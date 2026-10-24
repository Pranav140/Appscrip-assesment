-- ============================================================
-- 001_init.sql  – Core schema for Real-Time Operations Platform
-- ============================================================
-- Runs inside a transaction (the migration runner wraps it).
-- All enums, tables, indexes, and comments in one migration
-- so a clean install is a single pass.
-- ============================================================

-- ── Enum types ──────────────────────────────────────────────
CREATE TYPE device_status_enum   AS ENUM ('online', 'stale', 'offline', 'unknown');
CREATE TYPE event_status_enum    AS ENUM ('pending', 'processing', 'done', 'failed');
CREATE TYPE incident_state_enum  AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE severity_enum        AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE notification_status_enum AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead');
CREATE TYPE eval_outcome_enum    AS ENUM (
  'incident_created', 'incident_updated', 'suppressed_cooldown',
  'skipped_replay', 'no_match', 'error'
);
CREATE TYPE rule_type_enum AS ENUM ('threshold', 'event_type', 'silence');
CREATE TYPE scope_type_enum AS ENUM ('device', 'location', 'all');

-- ── locations ───────────────────────────────────────────────
CREATE TABLE locations (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
COMMENT ON TABLE locations IS 'Physical or logical locations that group devices';

-- ── devices ─────────────────────────────────────────────────
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,      -- device_id as supplied by device
  name           TEXT NOT NULL,
  location_id    INT  REFERENCES locations(id) ON DELETE SET NULL,
  api_key_hash   TEXT NOT NULL,         -- SHA-256 of the raw key (never store raw)
  status         device_status_enum NOT NULL DEFAULT 'unknown',
  -- last_seen_at uses received_at (server time, monotonic with GREATEST); never set backward
  last_seen_at   TIMESTAMPTZ,
  -- last_event_ts uses device-reported ts (untrusted; informational only)
  last_event_ts  TIMESTAMPTZ,
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN devices.api_key_hash   IS 'SHA-256 hex of the raw API key. Key is shown only once on creation.';
COMMENT ON COLUMN devices.last_seen_at   IS 'Server receive time of the latest event; advanced with GREATEST to resist rollback.';
COMMENT ON COLUMN devices.last_event_ts  IS 'Device-reported ts of the latest event; untrusted, stored for reference.';

CREATE INDEX idx_devices_location  ON devices(location_id);
CREATE INDEX idx_devices_status    ON devices(status);
CREATE INDEX idx_devices_last_seen ON devices(last_seen_at);

-- ── operators ────────────────────────────────────────────────
CREATE TABLE operators (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  webhook_url TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── operator_locations ──────────────────────────────────────
-- Many-to-many: which operators are responsible for which locations
CREATE TABLE operator_locations (
  operator_id INT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  location_id INT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (operator_id, location_id)
);

-- ── events ──────────────────────────────────────────────────
-- This table IS the work queue. Status + lease columns make it safe for
-- concurrent workers using FOR UPDATE SKIP LOCKED.
CREATE TABLE events (
  ingest_seq      BIGSERIAL PRIMARY KEY,            -- server-side monotonic cursor for SSE / catch-up
  device_id       TEXT NOT NULL REFERENCES devices(id),
  event_id        TEXT NOT NULL,                    -- device-generated, unique per device
  type            TEXT NOT NULL,
  event_ts        TIMESTAMPTZ NOT NULL,             -- device clock (untrusted)
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload         JSONB NOT NULL DEFAULT '{}',
  schema_version  INT  NOT NULL DEFAULT 1,
  is_replay       BOOLEAN NOT NULL DEFAULT false,   -- received_at - event_ts > threshold
  -- Queue fields
  status          event_status_enum NOT NULL DEFAULT 'pending',
  attempts        INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,                      -- lease expiry; null = not claimed
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,

  -- !! The primary reliability guarantee: (device_id, event_id) must be unique.
  -- The DB enforces this regardless of concurrency; INSERT ... ON CONFLICT DO NOTHING
  -- makes duplicate ingestion safe and idempotent.
  CONSTRAINT uq_device_event UNIQUE (device_id, event_id)
);
COMMENT ON TABLE  events            IS 'Ingest queue and event log. status+lease turn it into a durable work queue.';
COMMENT ON COLUMN events.ingest_seq IS 'Monotonically increasing server-side sequence used as SSE cursor.';
COMMENT ON COLUMN events.event_id   IS 'Device-generated ID. UNIQUE(device_id,event_id) ensures exactly-once storage.';
COMMENT ON COLUMN events.is_replay  IS 'True when (received_at - event_ts) > REPLAY_THRESHOLD. Rules may skip replays.';
COMMENT ON COLUMN events.locked_until IS 'Non-null while claimed by a worker. Expiry allows re-claim on worker death.';

-- Primary queue claim index: covers both unclaimed and expired-lease rows
CREATE INDEX idx_events_queue
  ON events(status, locked_until, ingest_seq)
  WHERE status IN ('pending', 'processing');

-- Device history index for the operator UI
CREATE INDEX idx_events_device_ts
  ON events(device_id, event_ts DESC);

-- ── rejected_events ──────────────────────────────────────────
-- Events that failed schema validation; stored for visibility / debugging
CREATE TABLE rejected_events (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT,      -- nullable: may not be parseable from malformed payload
  raw         JSONB NOT NULL,
  reason      TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rejected_events_received ON rejected_events(received_at DESC);

-- ── rules ────────────────────────────────────────────────────
CREATE TABLE rules (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  type                 rule_type_enum NOT NULL,
  scope_type           scope_type_enum NOT NULL DEFAULT 'all',
  scope_id             TEXT,    -- device_id or location_id (as text); null = applies to all
  config               JSONB NOT NULL DEFAULT '{}',
  severity             severity_enum NOT NULL,
  cooldown_seconds     INT NOT NULL DEFAULT 300,
  ignore_replayed      BOOLEAN NOT NULL DEFAULT false,
  auto_resolve         BOOLEAN NOT NULL DEFAULT false,
  notify_operator_ids  INT[],   -- null = route by operator_locations / all
  debug                BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN rules.config IS
  'threshold: {metric,op,value}; event_type: {event_type}; silence: {seconds}. Validated by zod on write.';
COMMENT ON COLUMN rules.ignore_replayed IS
  'If true, this rule is not evaluated for events flagged as replays.';
COMMENT ON COLUMN rules.auto_resolve IS
  'For silence rules: automatically resolve the incident when the device resumes.';
COMMENT ON COLUMN rules.cooldown_seconds IS
  'After a RESOLVED incident, suppress new incidents for this duration.';

-- ── incidents ────────────────────────────────────────────────
CREATE TABLE incidents (
  id                 BIGSERIAL PRIMARY KEY,
  rule_id            INT NOT NULL REFERENCES rules(id),
  device_id          TEXT NOT NULL REFERENCES devices(id),
  -- dedupe_key = 'rule:{rule_id}:device:{device_id}'
  -- The partial unique index below guarantees: at most one open/acknowledged incident per rule+device.
  dedupe_key         TEXT NOT NULL,
  state              incident_state_enum NOT NULL DEFAULT 'open',
  severity           severity_enum NOT NULL,
  title              TEXT NOT NULL,
  first_event_id     TEXT,          -- event_id of the first match (informational)
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at    TIMESTAMPTZ,
  acknowledged_by    TEXT,
  resolved_at        TIMESTAMPTZ,
  resolved_by        TEXT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count   INT NOT NULL DEFAULT 1,
  resolution_reason  TEXT,
  suppressed_count   INT NOT NULL DEFAULT 0  -- count of suppressed_cooldown matches after resolve
);
COMMENT ON TABLE  incidents           IS 'One row per active incident. Dedupe key + partial index guarantee no duplicates.';
COMMENT ON COLUMN incidents.dedupe_key IS
  'Composite key rule:{rule_id}:device:{device_id}. Partial UNIQUE index on (open,acknowledged) prevents concurrent duplicates.';
COMMENT ON COLUMN incidents.occurrence_count IS
  'Incremented on every matching event, even without creating new incident rows.';

-- !! Key reliability constraint: at most one open/acknowledged incident per dedupe_key.
-- The WHERE clause makes this a partial index: resolved incidents are excluded,
-- so a new incident CAN open after the previous one is resolved.
CREATE UNIQUE INDEX uq_incident_dedupe_active
  ON incidents(dedupe_key)
  WHERE state IN ('open', 'acknowledged');

CREATE INDEX idx_incidents_device   ON incidents(device_id);
CREATE INDEX idx_incidents_rule     ON incidents(rule_id);
CREATE INDEX idx_incidents_state    ON incidents(state);
CREATE INDEX idx_incidents_opened   ON incidents(opened_at DESC);

-- ── incident_events ──────────────────────────────────────────
-- Attaches events to incidents (many-to-many, capped per incident in app layer)
CREATE TABLE incident_events (
  incident_id     BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  event_ingest_seq BIGINT NOT NULL REFERENCES events(ingest_seq) ON DELETE CASCADE,
  attached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, event_ingest_seq)
);

-- ── rule_evaluations ─────────────────────────────────────────
-- Audit log: answers "why was/wasn't an incident created for this event?"
CREATE TABLE rule_evaluations (
  id              BIGSERIAL PRIMARY KEY,
  event_ingest_seq BIGINT REFERENCES events(ingest_seq) ON DELETE SET NULL,
  device_id       TEXT NOT NULL,
  rule_id         INT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched         BOOLEAN NOT NULL,
  outcome         eval_outcome_enum NOT NULL,
  reason          TEXT NOT NULL,      -- human-readable explanation
  incident_id     BIGINT REFERENCES incidents(id) ON DELETE SET NULL
);
CREATE INDEX idx_eval_event  ON rule_evaluations(event_ingest_seq);
CREATE INDEX idx_eval_device ON rule_evaluations(device_id, evaluated_at DESC);
CREATE INDEX idx_eval_rule   ON rule_evaluations(rule_id);

-- ── notifications ────────────────────────────────────────────
-- Transactional outbox: written in the same txn as incident creation.
-- Notifier picks up pending/failed rows using FOR UPDATE SKIP LOCKED.
CREATE TABLE notifications (
  id               BIGSERIAL PRIMARY KEY,
  incident_id      BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  operator_id      INT NOT NULL REFERENCES operators(id),
  channel          TEXT NOT NULL DEFAULT 'webhook',  -- 'webhook' | 'log'
  payload          JSONB NOT NULL DEFAULT '{}',
  status           notification_status_enum NOT NULL DEFAULT 'pending',
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until     TIMESTAMPTZ,
  last_error       TEXT,
  -- idempotency_key prevents duplicate sends on worker re-run.
  -- Format: 'incident:{id}:operator:{operator_id}:opened' (or :escalated, etc.)
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);
COMMENT ON COLUMN notifications.idempotency_key IS
  'Globally unique key sent as Idempotency-Key header to the webhook. Prevents double delivery.';
COMMENT ON COLUMN notifications.locked_until IS
  'Non-null while being sent. Expiry allows re-send on worker death.';

CREATE INDEX idx_notifications_due
  ON notifications(status, next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- ── activity_log ─────────────────────────────────────────────
-- Append-only feed used as SSE cursor and for the UI activity stream
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,   -- monotonic cursor for SSE Last-Event-ID
  kind        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);

-- ── worker_heartbeat ─────────────────────────────────────────
-- Each worker loop upserts this row; /readyz checks its age
CREATE TABLE worker_heartbeat (
  worker_id    TEXT PRIMARY KEY,
  last_beat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'
);
