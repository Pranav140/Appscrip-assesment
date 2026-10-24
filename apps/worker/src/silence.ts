import type { Pool, PoolClient } from 'pg';
import { getPool, pgNotify } from '@rtops/db';
import { PG_CHANNELS, type Rule, createLogger } from '@rtops/shared';
import { RulesCache } from './rules.js';

const logger = createLogger({ service: 'worker:silence' });

const ADVISORY_LOCK_ID = 987654321; // Single-leader lock for silence detector scheduler

export class SilenceDetector {
  private pool: Pool;
  private rulesCache: RulesCache;
  private running = false;
  private intervalMs: number;
  private startupGraceUntil: number;

  constructor(
    pool: Pool,
    rulesCache: RulesCache,
    options: {
      intervalMs?: number;
      gracePeriodSec?: number;
    } = {}
  ) {
    this.pool = pool;
    this.rulesCache = rulesCache;
    this.intervalMs = options.intervalMs ?? 5000;
    // Startup grace period (default 60s) to avoid false silence alerts during platform restart
    this.startupGraceUntil = Date.now() + (options.gracePeriodSec ?? 60) * 1000;
  }

  public async start(): Promise<void> {
    this.running = true;
    logger.info({ intervalMs: this.intervalMs }, 'Silence detector scheduler starting');
    void this.loop();
  }

  public stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        logger.error({ err }, 'Error in silence detector tick');
      }
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }

  private async tick(): Promise<void> {
    const client = await this.pool.connect();
    let lockAcquired = false;

    try {
      // 1. Try advisory lock (non-blocking)
      const lockRes = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [ADVISORY_LOCK_ID]
      );
      lockAcquired = lockRes.rows[0]?.acquired ?? false;

      if (!lockAcquired) {
        // Another worker instance holds the lock
        return;
      }

      // 2. Derive device status based on server last_seen_at
      await this.updateDeviceStatuses(client);

      // 3. Check silence rules if startup grace period has passed
      if (Date.now() < this.startupGraceUntil) {
        const remainingGrace = Math.round((this.startupGraceUntil - Date.now()) / 1000);
        logger.debug({ remainingGrace }, 'Within startup grace period; skipping silence rule evaluations');
        return;
      }

      await this.evaluateSilenceRules(client);
    } finally {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
      }
      client.release();
    }
  }

  private async updateDeviceStatuses(client: PoolClient): Promise<void> {
    // Online < 30s, Stale 30s-90s, Offline >= 90s, Unknown if NULL
    const { rows: changed } = await client.query<{
      id: string;
      prev_status: string;
      new_status: string;
    }>(`
      WITH calculated AS (
        SELECT
          id,
          status AS prev_status,
          CASE
            WHEN last_seen_at IS NULL THEN 'unknown'::device_status_enum
            WHEN last_seen_at >= now() - interval '30 seconds' THEN 'online'::device_status_enum
            WHEN last_seen_at >= now() - interval '90 seconds' THEN 'stale'::device_status_enum
            ELSE 'offline'::device_status_enum
          END AS new_status
        FROM devices
      )
      UPDATE devices d
      SET status = c.new_status
      FROM calculated c
      WHERE d.id = c.id AND d.status IS DISTINCT FROM c.new_status
      RETURNING d.id, c.prev_status, c.new_status;
    `);

    for (const d of changed) {
      await client.query(
        `INSERT INTO activity_log (kind, entity_type, entity_id, data)
         VALUES ('device_status_changed', 'device', $1, $2)`,
        [
          d.id,
          JSON.stringify({
            device_id: d.id,
            from: d.prev_status,
            to: d.new_status,
            timestamp: new Date().toISOString(),
          }),
        ]
      );

      await pgNotify(client, PG_CHANNELS.DEVICE_STATUS_CHANGED, {
        device_id: d.id,
        status: d.new_status,
        prev_status: d.prev_status,
      });
    }
  }

  private async evaluateSilenceRules(client: PoolClient): Promise<void> {
    const rules = await this.rulesCache.getEnabledRules();
    const silenceRules = rules.filter((r) => r.type === 'silence');

    for (const rule of silenceRules) {
      const config = rule.config as { seconds: number };
      const silenceSeconds = config.seconds ?? 60;

      // Find devices whose last_seen_at is older than silenceSeconds
      // and which do NOT have an open or acknowledged incident for this rule
      let deviceFilter = `
        last_seen_at IS NOT NULL
        AND last_seen_at < now() - ($1 || ' seconds')::interval
      `;
      const params: (number | string)[] = [silenceSeconds];

      if (rule.scope === 'device' && rule.scope_target) {
        params.push(rule.scope_target);
        deviceFilter += ` AND id = $${params.length}`;
      } else if (rule.scope === 'location' && rule.scope_target) {
        params.push(rule.scope_target);
        deviceFilter += ` AND location_id = $${params.length}`;
      }

      const { rows: silentDevices } = await client.query<{
        id: string;
        last_seen_at: Date;
        location_id: number | null;
      }>(
        `SELECT id, last_seen_at, location_id
         FROM devices
         WHERE ${deviceFilter}`,
        params
      );

      for (const dev of silentDevices) {
        const dedupeKey = `rule:${rule.id}:device:${dev.id}`;

        // Attempt to insert open incident; unique partial index protects against duplicates
        const insRes = await client.query<{ inserted: boolean; id: string }>(
          `INSERT INTO incidents (
            rule_id, device_id, dedupe_key, state, severity, title, opened_at, last_seen_at, occurrence_count
           ) VALUES ($1, $2, $3, 'open', $4, $5, now(), $6, 1)
           ON CONFLICT (dedupe_key) WHERE state IN ('open', 'acknowledged')
           DO UPDATE SET
             occurrence_count = incidents.occurrence_count + 1
           RETURNING (xmax = 0) AS inserted, id`,
          [
            rule.id,
            dev.id,
            dedupeKey,
            rule.severity,
            `Device ${dev.id} silent for ${silenceSeconds}s`,
            dev.last_seen_at,
          ]
        );

        if (insRes.rows.length > 0 && insRes.rows[0].inserted) {
          const incidentId = parseInt(insRes.rows[0].id, 10);
          logger.warn({ device_id: dev.id, rule_id: rule.id, incidentId }, 'Created silence incident');

          // Log rule evaluation
          await client.query(
            `INSERT INTO rule_evaluations (
              device_id, rule_id, evaluated_at, matched, outcome, reason, incident_id
             ) VALUES ($1, $2, now(), true, 'incident_created', $3, $4)`,
            [
              dev.id,
              rule.id,
              `No heartbeat received for ${silenceSeconds}s (last seen: ${dev.last_seen_at.toISOString()})`,
              incidentId,
            ]
          );

          // Find target operators
          const { rows: ops } = await client.query<{ id: number }>(
            `SELECT id FROM operators WHERE active = true LIMIT 5`
          );

          for (const op of ops) {
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
                  device_id: dev.id,
                  severity: rule.severity,
                  reason: `Device silent for ${silenceSeconds}s`,
                  timestamp: new Date().toISOString(),
                }),
                idempotencyKey,
              ]
            );
          }

          // Activity log and SSE NOTIFY
          await client.query(
            `INSERT INTO activity_log (kind, entity_type, entity_id, data)
             VALUES ('incident_created', 'incident', $1, $2)`,
            [
              String(incidentId),
              JSON.stringify({
                incident_id: incidentId,
                rule_id: rule.id,
                rule_name: rule.name,
                device_id: dev.id,
                severity: rule.severity,
              }),
            ]
          );

          await pgNotify(client, PG_CHANNELS.INCIDENT_CHANGED, {
            action: 'created',
            incident_id: incidentId,
            device_id: dev.id,
            severity: rule.severity,
          });
        }
      }
    }
  }
}
