import type { Pool, PoolClient } from 'pg';
import { getPool, pgNotify } from '@rtops/db';
import { PG_CHANNELS, type Rule, type DeviceEvent, type StoredEvent } from '@rtops/shared';
import { createLogger } from '@rtops/shared';

const logger = createLogger({ service: 'worker:rules' });

export interface RuleEvaluationDecision {
  rule: Rule;
  matched: boolean;
  outcome:
    | 'incident_created'
    | 'incident_updated'
    | 'suppressed_cooldown'
    | 'skipped_replay'
    | 'no_match'
    | 'error';
  reason: string;
  incidentId?: number;
}

export class RulesCache {
  private rules: Rule[] = [];
  private lastFetched = 0;
  private readonly ttlMs = 5000;
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  public invalidate(): void {
    this.lastFetched = 0;
  }

  public async getEnabledRules(): Promise<Rule[]> {
    const now = Date.now();
    if (now - this.lastFetched < this.ttlMs && this.rules.length > 0) {
      return this.rules;
    }

    try {
      const { rows } = await this.pool.query<Rule>(
        'SELECT * FROM rules WHERE enabled = true ORDER BY id ASC'
      );
      this.rules = rows;
      this.lastFetched = now;
    } catch (err) {
      logger.error({ err }, 'Failed to refresh rules cache from DB');
    }
    return this.rules;
  }
}

/** Pure evaluation of a single rule against an event */
export function evaluateRule(rule: Rule, event: StoredEvent): { matched: boolean; reason: string } {
  // Scope check
  if (rule.scope === 'device' && rule.scope_target && rule.scope_target !== event.device_id) {
    return { matched: false, reason: `Device ${event.device_id} not in rule scope (${rule.scope_target})` };
  }

  // Type check
  if (rule.type === 'event_type') {
    const targetType = (rule.config as { event_type: string }).event_type;
    if (event.type === targetType) {
      return { matched: true, reason: `Event type matched '${targetType}'` };
    }
    return { matched: false, reason: `Event type '${event.type}' != '${targetType}'` };
  }

  if (rule.type === 'threshold') {
    if (event.type !== 'telemetry') {
      return { matched: false, reason: `Threshold rule only applies to 'telemetry' events (got '${event.type}')` };
    }
    const { metric, op, value } = rule.config as { metric: string; op: string; value: number };
    const rawVal = event.payload ? event.payload[metric] : undefined;

    if (rawVal === undefined || rawVal === null) {
      return { matched: false, reason: `Payload metric '${metric}' is missing or null` };
    }
    const num = Number(rawVal);
    if (Number.isNaN(num)) {
      return { matched: false, reason: `Metric '${metric}' value '${String(rawVal)}' is not numeric` };
    }

    let match = false;
    switch (op) {
      case '>':
        match = num > value;
        break;
      case '>=':
        match = num >= value;
        break;
      case '<':
        match = num < value;
        break;
      case '<=':
        match = num <= value;
        break;
      case '==':
        match = num === value;
        break;
      default:
        return { matched: false, reason: `Unsupported operator '${op}'` };
    }

    if (match) {
      return { matched: true, reason: `${metric}=${num} ${op} ${value}` };
    }
    return { matched: false, reason: `${metric}=${num} not ${op} ${value}` };
  }

  // Silence rules are evaluated by the silence detector loop
  if (rule.type === 'silence') {
    return { matched: false, reason: 'Silence rules evaluated by scheduler' };
  }

  return { matched: false, reason: 'Unknown rule type' };
}

/** Execute rule matching and incident upsert inside the event processing transaction */
export async function processEventRules(
  client: PoolClient,
  event: StoredEvent,
  rules: Rule[],
  deviceLocationId: number | null
): Promise<RuleEvaluationDecision[]> {
  const decisions: RuleEvaluationDecision[] = [];

  for (const rule of rules) {
    if (rule.type === 'silence') continue;

    // Check scope if location-based
    if (rule.scope === 'location' && rule.scope_target) {
      if (deviceLocationId === null || String(deviceLocationId) !== String(rule.scope_target)) {
        decisions.push({
          rule,
          matched: false,
          outcome: 'no_match',
          reason: `Device location ${deviceLocationId} does not match rule location scope ${rule.scope_target}`,
        });
        continue;
      }
    }

    // Check replay suppression
    if (event.is_replay && rule.ignore_replayed) {
      decisions.push({
        rule,
        matched: false,
        outcome: 'skipped_replay',
        reason: 'Event is replayed and rule.ignore_replayed is true',
      });
      continue;
    }

    const evalResult = evaluateRule(rule, event);
    if (!evalResult.matched) {
      decisions.push({
        rule,
        matched: false,
        outcome: 'no_match',
        reason: evalResult.reason,
      });
      continue;
    }

    // Matched! Check cooldown from any recently resolved incident for this rule & device
    const dedupeKey = `rule:${rule.id}:device:${event.device_id}`;
    if (rule.cooldown_seconds > 0) {
      const cooldownCheck = await client.query<{ resolved_at: Date }>(
        `SELECT resolved_at FROM incidents
         WHERE dedupe_key = $1 AND state = 'resolved'
         ORDER BY resolved_at DESC LIMIT 1`,
        [dedupeKey]
      );
      if (cooldownCheck.rows.length > 0 && cooldownCheck.rows[0].resolved_at) {
        const secondsSinceResolve =
          (Date.now() - new Date(cooldownCheck.rows[0].resolved_at).getTime()) / 1000;
        if (secondsSinceResolve < rule.cooldown_seconds) {
          decisions.push({
            rule,
            matched: true,
            outcome: 'suppressed_cooldown',
            reason: `Incident in cooldown (${Math.round(secondsSinceResolve)}s < ${rule.cooldown_seconds}s)`,
          });
          continue;
        }
      }
    }

    // Upsert incident with dedupe key protection
    const upsertRes = await client.query<{ inserted: boolean; id: string; state: string }>(
      `INSERT INTO incidents (
        rule_id, device_id, dedupe_key, state, severity, title, first_event_id, opened_at, last_seen_at, occurrence_count
       ) VALUES ($1, $2, $3, 'open', $4, $5, $6, now(), $7, 1)
       ON CONFLICT (dedupe_key) WHERE state IN ('open', 'acknowledged')
       DO UPDATE SET
         occurrence_count = incidents.occurrence_count + 1,
         last_seen_at = GREATEST(incidents.last_seen_at, EXCLUDED.last_seen_at)
       RETURNING (xmax = 0) AS inserted, id, state`,
      [
        rule.id,
        event.device_id,
        dedupeKey,
        rule.severity,
        `${rule.name} triggered on ${event.device_id}`,
        event.event_id,
        event.event_ts,
      ]
    );

    const incidentRow = upsertRes.rows[0];
    const incidentId = parseInt(incidentRow.id, 10);
    const wasInserted = incidentRow.inserted;

    // Attach event to incident_events
    await client.query(
      `INSERT INTO incident_events (incident_id, event_ingest_seq)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [incidentId, event.ingest_seq]
    );

    // If new incident created, enqueue notification outbox rows
    if (wasInserted) {
      let targetOperators: { id: number }[] = [];
      if (rule.notify_operator_ids && rule.notify_operator_ids.length > 0) {
        const { rows } = await client.query<{ id: number }>(
          `SELECT id FROM operators WHERE id = ANY($1) AND active = true`,
          [rule.notify_operator_ids]
        );
        targetOperators = rows;
      } else if (deviceLocationId) {
        const { rows } = await client.query<{ id: number }>(
          `SELECT o.id FROM operators o
           JOIN operator_locations ol ON ol.operator_id = o.id
           WHERE ol.location_id = $1 AND o.active = true`,
          [deviceLocationId]
        );
        targetOperators = rows;
      }

      if (targetOperators.length === 0) {
        const { rows } = await client.query<{ id: number }>(
          `SELECT id FROM operators WHERE active = true LIMIT 5`
        );
        targetOperators = rows;
      }

      for (const op of targetOperators) {
        const idempotencyKey = `incident:${incidentId}:operator:${op.id}:opened`;
        await client.query(
          `INSERT INTO notifications (
            incident_id, operator_id, channel, payload, idempotency_key, status
           ) VALUES ($1, $2, 'webhook', $3, $4, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            incidentId,
            op.id,
            JSON.stringify({
              incident_id: incidentId,
              rule_name: rule.name,
              device_id: event.device_id,
              severity: rule.severity,
              reason: evalResult.reason,
              timestamp: new Date().toISOString(),
            }),
            idempotencyKey,
          ]
        );
      }

      // Record activity log & NOTIFY
      await client.query(
        `INSERT INTO activity_log (kind, entity_type, entity_id, data)
         VALUES ('incident_created', 'incident', $1, $2)`,
        [
          String(incidentId),
          JSON.stringify({
            incident_id: incidentId,
            rule_id: rule.id,
            rule_name: rule.name,
            device_id: event.device_id,
            severity: rule.severity,
          }),
        ]
      );

      await pgNotify(client, PG_CHANNELS.INCIDENT_CHANGED, {
        action: 'created',
        incident_id: incidentId,
        device_id: event.device_id,
        severity: rule.severity,
      });
    }

    decisions.push({
      rule,
      matched: true,
      outcome: wasInserted ? 'incident_created' : 'incident_updated',
      reason: evalResult.reason,
      incidentId,
    });
  }

  return decisions;
}
