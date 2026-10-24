import { z } from 'zod';

// ── Event Schema (device-side) ─────────────────────────────────────────────
export const EventPayloadSchema = z.record(z.unknown());

export const DeviceEventSchema = z.object({
  event_id: z.string().min(1).max(128),
  device_id: z.string().min(1).max(128),
  seq: z.number().int().nonnegative().optional(),
  type: z.string().min(1).max(64),
  ts: z.string().datetime({ offset: true }),
  payload: EventPayloadSchema.default({}),
  schema_version: z.literal(1).default(1),
});

export type DeviceEvent = z.infer<typeof DeviceEventSchema>;

export const IngestBatchSchema = z.object({
  events: z.array(DeviceEventSchema).min(1).max(500),
});

export type IngestBatch = z.infer<typeof IngestBatchSchema>;

// ── Per-event ack ─────────────────────────────────────────────────────────
export const EventAckStatus = z.enum(['accepted', 'duplicate', 'rejected']);
export type EventAckStatus = z.infer<typeof EventAckStatus>;

export const EventAckSchema = z.object({
  event_id: z.string(),
  status: EventAckStatus,
  reason: z.string().optional(),
});

export type EventAck = z.infer<typeof EventAckSchema>;

export const IngestResponseSchema = z.object({
  results: z.array(EventAckSchema),
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

// ── Rule Schemas (discriminated union by type) ────────────────────────────
const RuleBaseSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(true),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  scope_type: z.enum(['device', 'location', 'all']),
  scope_id: z.string().nullable().optional(),
  cooldown_seconds: z.number().int().nonnegative().default(300),
  ignore_replayed: z.boolean().default(false),
  auto_resolve: z.boolean().default(false),
  notify_operator_ids: z.array(z.number()).nullable().optional(),
  debug: z.boolean().default(false),
  created_at: z.string().datetime({ offset: true }).optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
});

export const ThresholdRuleConfigSchema = z.object({
  metric: z.string().min(1),
  op: z.enum(['>', '>=', '<', '<=', '==']),
  value: z.number(),
});
export type ThresholdRuleConfig = z.infer<typeof ThresholdRuleConfigSchema>;

export const EventTypeRuleConfigSchema = z.object({
  event_type: z.string().min(1),
});
export type EventTypeRuleConfig = z.infer<typeof EventTypeRuleConfigSchema>;

export const SilenceRuleConfigSchema = z.object({
  seconds: z.number().int().positive(),
});
export type SilenceRuleConfig = z.infer<typeof SilenceRuleConfigSchema>;

export const ThresholdRuleSchema = RuleBaseSchema.extend({
  type: z.literal('threshold'),
  config: ThresholdRuleConfigSchema,
});

export const EventTypeRuleSchema = RuleBaseSchema.extend({
  type: z.literal('event_type'),
  config: EventTypeRuleConfigSchema,
});

export const SilenceRuleSchema = RuleBaseSchema.extend({
  type: z.literal('silence'),
  config: SilenceRuleConfigSchema,
});

export const RuleSchema = z.discriminatedUnion('type', [
  ThresholdRuleSchema,
  EventTypeRuleSchema,
  SilenceRuleSchema,
]);

export type Rule = z.infer<typeof RuleSchema>;
export type ThresholdRule = z.infer<typeof ThresholdRuleSchema>;
export type EventTypeRule = z.infer<typeof EventTypeRuleSchema>;
export type SilenceRule = z.infer<typeof SilenceRuleSchema>;

// ── Incident ──────────────────────────────────────────────────────────────
export const IncidentStateSchema = z.enum(['open', 'acknowledged', 'resolved']);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

// ── Device Status ─────────────────────────────────────────────────────────
export const DeviceStatusSchema = z.enum(['online', 'stale', 'offline', 'unknown']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

// ── Event Processing Status ───────────────────────────────────────────────
export const EventStatusSchema = z.enum(['pending', 'processing', 'done', 'failed']);
export type EventStatus = z.infer<typeof EventStatusSchema>;

// ── Notification ──────────────────────────────────────────────────────────
export const NotificationStatusSchema = z.enum([
  'pending',
  'sending',
  'sent',
  'failed',
  'dead',
]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// ── Rule Evaluation Outcome ────────────────────────────────────────────────
export const EvaluationOutcomeSchema = z.enum([
  'incident_created',
  'incident_updated',
  'suppressed_cooldown',
  'skipped_replay',
  'no_match',
  'error',
]);
export type EvaluationOutcome = z.infer<typeof EvaluationOutcomeSchema>;

// ── API Error Shape ────────────────────────────────────────────────────────
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── SSE Event Kinds ────────────────────────────────────────────────────────
export const SSEEventKindSchema = z.enum([
  'event',
  'incident',
  'device',
  'activity',
  'stats',
  'ping',
  'resync',
]);
export type SSEEventKind = z.infer<typeof SSEEventKindSchema>;

// ── Dry-run request ────────────────────────────────────────────────────────
export const DryRunRequestSchema = z.object({
  rule: RuleSchema,
  sample_event: DeviceEventSchema,
});
export type DryRunRequest = z.infer<typeof DryRunRequestSchema>;

export const DryRunResponseSchema = z.object({
  matched: z.boolean(),
  reason: z.string(),
  outcome: EvaluationOutcomeSchema.nullable(),
});
export type DryRunResponse = z.infer<typeof DryRunResponseSchema>;
