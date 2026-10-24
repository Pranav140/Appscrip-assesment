// ── Postgres Notification Channel Names ─────────────────────────────────────
export const PG_CHANNELS = {
  EVENTS_AVAILABLE: 'events_available',
  INCIDENT_CHANGED: 'incident_changed',
  DEVICE_STATUS_CHANGED: 'device_status_changed',
  ACTIVITY: 'activity',
  RULES_CHANGED: 'rules_changed',
  NOTIFICATIONS_AVAILABLE: 'notifications_available',
} as const;

export type PgChannel = (typeof PG_CHANNELS)[keyof typeof PG_CHANNELS];

// ── Default configuration constants ──────────────────────────────────────────
export const DEFAULTS = {
  HIGH_WATERMARK: 5000,
  HARD_WATERMARK: 10000,
  REPLAY_THRESHOLD_SECONDS: 120,
  MAX_FUTURE_SECONDS: 86400,
  MAX_ATTEMPTS: 5,
  WORKER_CONCURRENCY: 4,
  WORKER_BATCH_SIZE: 20,
  POLL_INTERVAL_MS: 1000,
  WORKER_LEASE_SECONDS: 30,
  STALE_AFTER_SECONDS: 30,
  OFFLINE_AFTER_SECONDS: 90,
  SCHEDULER_INTERVAL_MS: 5000,
  STARTUP_GRACE_SECONDS: 180,
  MAX_NOTIFY_ATTEMPTS: 8,
  CIRCUIT_BREAKER_K: 5,
  CIRCUIT_BREAKER_COOL_OFF_SECONDS: 60,
  RULE_CACHE_TTL_MS: 5000,
  SSE_FLUSH_INTERVAL_MS: 250,
  SSE_MAX_BATCH: 50,
  SSE_PING_INTERVAL_MS: 15000,
  SSE_STATS_INTERVAL_MS: 5000,
  SSE_CATCHUP_LIMIT: 1000,
  SSE_CLIENT_QUEUE_LIMIT: 200,
  INCIDENT_MAX_ATTACHED_EVENTS: 100,
} as const;

// ── Activity log kinds ────────────────────────────────────────────────────────
export const ACTIVITY_KINDS = {
  EVENT_PROCESSED: 'event_processed',
  EVENT_FAILED: 'event_failed',
  INCIDENT_CREATED: 'incident_created',
  INCIDENT_UPDATED: 'incident_updated',
  INCIDENT_ACKNOWLEDGED: 'incident_acknowledged',
  INCIDENT_RESOLVED: 'incident_resolved',
  DEVICE_STATUS_CHANGED: 'device_status_changed',
  NOTIFICATION_SENT: 'notification_sent',
  NOTIFICATION_FAILED: 'notification_failed',
  NOTIFICATION_DEAD: 'notification_dead',
  RULE_CHANGED: 'rule_changed',
  SILENCE_DETECTED: 'silence_detected',
} as const;
