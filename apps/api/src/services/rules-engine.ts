import type { Rule, DeviceEvent } from '@rtops/shared';

export interface EvalResult {
  matched: boolean;
  reason: string;
}

/**
 * Pure function: evaluate one rule against one event.
 * No DB side-effects — used both by the worker and by the dry-run API endpoint.
 */
export function evaluateRule(rule: Rule, event: DeviceEvent): EvalResult {
  // Silence rules are evaluated by the scheduler, not per-event
  if (rule.type === 'silence') {
    return { matched: false, reason: 'silence rules are evaluated by the scheduler, not per-event' };
  }

  // Skip replay if rule says so
  if (rule.ignore_replayed && (event as unknown as { is_replay?: boolean }).is_replay) {
    return { matched: false, reason: 'skipped: event is a replay and rule.ignore_replayed=true' };
  }

  if (rule.type === 'event_type') {
    const matched = event.type === rule.config.event_type;
    return {
      matched,
      reason: matched
        ? `event type "${event.type}" matches rule.config.event_type="${rule.config.event_type}"`
        : `event type "${event.type}" != rule.config.event_type="${rule.config.event_type}"`,
    };
  }

  if (rule.type === 'threshold') {
    if (event.type !== 'telemetry') {
      return { matched: false, reason: `threshold rules only apply to telemetry events, got "${event.type}"` };
    }
    const { metric, op, value } = rule.config;
    const raw = (event.payload as Record<string, unknown>)[metric];

    if (raw === undefined || raw === null) {
      return { matched: false, reason: `payload.${metric} is missing` };
    }
    const actual = Number(raw);
    if (!isFinite(actual)) {
      return { matched: false, reason: `payload.${metric}="${String(raw)}" is not numeric` };
    }

    let matched = false;
    switch (op) {
      case '>':  matched = actual >  value; break;
      case '>=': matched = actual >= value; break;
      case '<':  matched = actual <  value; break;
      case '<=': matched = actual <= value; break;
      case '==': matched = actual === value; break;
    }

    return {
      matched,
      reason: `${metric}=${actual} ${op} ${value} → ${matched ? 'MATCH' : 'no match'}`,
    };
  }

  return { matched: false, reason: 'unknown rule type' };
}

/**
 * Check if a rule is in scope for a given device/location.
 */
export function isRuleInScope(
  rule: Rule,
  deviceId: string,
  locationId: number | null | undefined
): boolean {
  if (rule.scope_type === 'all') return true;
  if (rule.scope_type === 'device') return rule.scope_id === deviceId;
  if (rule.scope_type === 'location') {
    return locationId != null && rule.scope_id === String(locationId);
  }
  return false;
}
