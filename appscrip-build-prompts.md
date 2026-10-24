# Appscrip FDE Assignment: Step-by-Step Build Prompts

A plan plus 10 copy-paste prompts to build the **Real-Time Operations Platform** end to end, using Claude Code (or any coding agent) in your repo.

---

## 0. Read this first: the plan

### 0.1 What the assignment is really testing

The brief is deliberately vague. The evaluators do not want a big system. They want to see that you:

1. **Interpret ambiguity** and write down your assumptions.
2. **Pick explicit delivery guarantees** and implement them (not just claim them).
3. **Explain failure behavior** ("what happens when X dies?").
4. **Keep it small and reliable** rather than impressive and fragile.

Every design choice below is made for **correctness you can defend in a viva**, not for resume-driven complexity.

### 0.2 Stack decision (and why)

| Concern | Choice | Why | Alternative considered |
|---|---|---|---|
| Language | **Node.js + TypeScript** | You already work in MERN/PERN, so you move fast and can explain every line | Python/FastAPI (fine, but no advantage here) |
| API framework | **Fastify** | Fast, schema validation, good logging (pino) built in | Express (slower, less structure), NestJS (too heavy) |
| Database | **PostgreSQL** | Transactions, unique constraints for dedup, `SKIP LOCKED` for queues, `LISTEN/NOTIFY`, advisory locks | MongoDB (weaker transactional dedup story) |
| Queue / buffering | **Postgres table used as a durable queue** (`FOR UPDATE SKIP LOCKED` + lease) | One dependency, transactional with the accepted write, trivial to run locally, easy to reason about | Redis Streams / Kafka / RabbitMQ (better at scale; documented as the scale path) |
| Device protocol | **HTTP `POST /v1/events` with batches + per-event ack** | Stateless, retry-friendly, perfect for offline-buffer-then-replay | MQTT (the real-world answer for IoT; documented as the production path), WebSocket (stateful, more failure modes) |
| Dashboard realtime | **SSE (Server-Sent Events)** + REST catch-up | One-way fits the need, auto-reconnect built into the browser, simpler than WebSocket | WebSocket (needed only for bidirectional) |
| Frontend | **React + Vite + TypeScript + TanStack Query** | Familiar, and Query gives caching and refetch-on-reconnect | Next.js (SSR is not needed) |
| Notifications | **Transactional outbox** + notifier worker + mock webhook sink | Handles "notification service unavailable" properly | Calling the webhook inline (loses notifications) |
| Observability | `pino` logs, `prom-client` `/metrics`, `/healthz`, `/readyz`, `rule_evaluations` audit table | Answers "why was/wasn't an incident created?" | Full OpenTelemetry (documented as next step) |
| Packaging | **docker-compose** (Postgres + api + worker + web + sink) | "Runnable locally" in one command | Manual setup |
| Tests | **Vitest** against a real Postgres (compose test DB) | Failure tests must hit real DB semantics | Mocks (hide the concurrency bugs) |

### 0.3 Architecture at a glance

```
 Device Simulator(s)                 Operator Browser (React)
   | offline buffer (file)             ^   |  REST + SSE (Last-Event-ID / catch-up)
   | HTTP batch + X-Device-Key         |   v
   v                                 +------------------+
+-----------------+  202 + per-event |   API process    |  (Fastify)
|  Ingest API     |  ack / 429       |  ingest + REST   |
|  validate, auth |----------------->|  + SSE broker    |
|  dedupe insert  |                  +--------+---------+
+--------+--------+                           | LISTEN/NOTIFY
         | INSERT ... ON CONFLICT DO NOTHING   |
         v                                     |
+---------------------------- PostgreSQL ------+--------------------+
| devices | events(queue: status,attempts,locked_until) | rules     |
| incidents | incident_events | rule_evaluations | activity_log     |
| notifications(outbox) | rejected_events | operators               |
+----------+---------------------------+------------------+---------+
           ^ claim batch (SKIP LOCKED)  ^ scheduler (advisory lock)  ^ claim due notifications
+----------+-----------+  +------------+-----------+  +--------------+--------+
| Event Processor      |  | Silence Detector       |  | Notifier (retry+DLQ,   |
| rules -> incidents   |  | "no report for N sec"  |  | circuit breaker)       |
| (1 txn per event)    |  |                        |  +--------------+---------+
+----------------------+  +------------------------+                 v
                                                            Webhook sink (mock, can be toggled down)
```

### 0.4 Delivery guarantees (your answer to "what do you promise?")

| Hop | Guarantee | Mechanism |
|---|---|---|
| Device -> platform | **At-least-once** | Device keeps events in a durable buffer until the server acks each `event_id`. It retries with backoff plus jitter. |
| Ingest -> storage | **Accepted means durable** | We only ack after the Postgres commit. `UNIQUE(device_id, event_id)` makes duplicates harmless. |
| Storage -> processing | **At-least-once, effectively-once effects** | Lease-based claim. Processing and "mark done" happen in **one transaction**. A crash means the lease expires and the event is re-claimed. Incident creation is idempotent via dedupe keys. |
| Processing -> notification | **At-least-once** | Transactional outbox. Retry with exponential backoff. After N attempts it goes to a dead-letter state that is visible in the UI. Notifications carry an idempotency key. |
| Ordering | **No global ordering assumed** | Rules are order-insensitive. Device "last seen" uses `GREATEST()`. Event time and receive time are stored separately. |
| Overload | **Bounded and honest** | When queue depth is above the high watermark, ingest returns `429 + Retry-After`. Devices keep buffering. No silent drops. |

### 0.5 Key assumptions to write down in your README

- Device clocks are **untrusted**, so we store both `event_ts` (device) and `received_at` (server). Silence detection uses `received_at`.
- A device is identified by `device_id` plus an API key (hashed in DB). Keys are provisioned via a registration endpoint or a seed.
- "Replayed" events (event_ts older than a threshold versus received_at) are flagged. A rule may choose to ignore replayed events.
- Incident dedupe key = `rule_id + device_id`. While one is open or acknowledged, matches only bump `occurrence_count` and attach the event.
- Operator auth is intentionally minimal (a static token), and this is listed as a limitation.

### 0.6 Suggested timeline (8-12 hours)

| Prompt | Topic | Time |
|---|---|---|
| 1 | Foundation + architecture decisions | 45 min |
| 2 | Database schema + migrations | 45 min |
| 3 | Ingestion API + protocol | 1 h |
| 4 | Event processor worker | 1 h |
| 5 | Rules engine + incidents | 1.25 h |
| 6 | Silence detector + notification outbox | 1 h |
| 7 | Operator REST API + SSE | 1 h |
| 8 | Frontend dashboard | 1.5-2 h |
| 9 | Device simulator + chaos scripts | 45 min |
| 10 | Tests, observability, docs, demo | 1.5 h |

### 0.7 How to use these prompts

- Run them **in order**, in the **same repo**. Each one assumes the earlier ones are done.
- After each prompt, **run the acceptance checks** before moving on. Do not stack untested work.
- Prompt 1 creates `CLAUDE.md` and `docs/DECISIONS.md`. Every later prompt starts with "read those first", which keeps the agent consistent across sessions.
- Commit after every prompt (`git commit -m "step N: ..."`). It gives you a clean story and easy rollback.
- Read what it writes. You must be able to explain it live.

---

## PROMPT 1: Foundation, decisions, scaffold

````text
You are helping me build a take-home assignment: a Real-Time Operations Platform for a fleet of devices
(events in, rules -> incidents, live dashboard, reliability under failure). I want a SMALL, RELIABLE,
well-explained system, not a sprawling one.

PRODUCT BRIEF (save verbatim to docs/BRIEF.md):
- Devices across multiple locations continuously produce events, sometimes go offline, and reconnect by
  replaying buffered events.
- Operators monitor devices in real time, define rules, and get incidents + notifications.
- Must handle: out-of-order events, duplicates, disconnect/reconnect, bursts, malformed payloads;
  processing failures, process restarts, notification service outages, long offline gaps, overload.
- Deliverables: working frontend+backend, architecture diagram, architecture notes (decisions,
  alternatives, trade-offs), tests incl. failure scenarios, run instructions, deployment notes,
  and a lightweight device simulator (offline buffering + reconnect + replay).

FIXED TECH DECISIONS (do not change without telling me):
- Node.js 20 + TypeScript (strict), npm workspaces monorepo.
- Fastify + zod for validation, pino for logs, prom-client for metrics.
- PostgreSQL 16 only (no Redis/Kafka). Postgres is also the durable queue (FOR UPDATE SKIP LOCKED + lease),
  the outbox for notifications, and the pub/sub (LISTEN/NOTIFY) between worker and API.
- Device protocol: HTTP POST /v1/events (batch) with per-event ack. Dashboard realtime: SSE + REST catch-up.
- Frontend: React + Vite + TypeScript + TanStack Query.
- Tests: Vitest against a real Postgres.
- Everything runs via docker-compose (postgres, api, worker, web, webhook-sink).

TASKS:
1. Create the monorepo layout:
   apps/api        (Fastify HTTP: ingest + operator REST + SSE)
   apps/worker     (event processor, silence detector scheduler, notifier; separate process)
   apps/web        (React dashboard; placeholder for now)
   apps/simulator  (device simulator CLI; placeholder for now)
   apps/webhook-sink (tiny mock external notification service that can be toggled up/down; placeholder)
   packages/shared (zod schemas, types, constants shared by all apps)
   packages/db     (pg pool, migration runner, typed query helpers)
   docs/, scripts/
2. Shared tooling: tsconfig base (strict), eslint + prettier, .editorconfig, .env.example,
   a central typed config module (zod-validated env) in packages/shared, a pino logger factory that
   adds service name and supports a request/correlation id.
3. docker-compose.yml with postgres (healthcheck) and placeholders for the other services;
   a Makefile or npm scripts: dev, build, test, db:migrate, db:reset, compose:up.
4. Write CLAUDE.md at the repo root containing: project summary, tech decisions above, repo layout,
   coding conventions, how to run, and the line "Read docs/DECISIONS.md before making architectural changes."
5. Write docs/DECISIONS.md as an ADR-style log. Seed it with these decisions (each with Context, Decision,
   Alternatives considered, Consequences):
   - ADR-1 Postgres as durable queue instead of Kafka/Redis.
   - ADR-2 HTTP batch ingestion with per-event ack instead of MQTT/WebSocket.
   - ADR-3 SSE + REST catch-up for dashboard.
   - ADR-4 At-least-once delivery + idempotent processing (event dedupe on (device_id,event_id)).
   - ADR-5 Device clocks untrusted: store event_ts and received_at; silence uses received_at.
   - ADR-6 Incident dedupe key = rule_id + device_id.
   - ADR-7 Transactional outbox for notifications.
   - ADR-8 Backpressure via 429 + Retry-After when queue depth exceeds a watermark.
6. Add a /healthz endpoint stub to apps/api and make `npm run dev` start it, to prove the scaffold works.

ACCEPTANCE CHECKS:
- `docker compose up -d postgres` works; `npm run build` passes; `curl localhost:3000/healthz` returns 200.
- CLAUDE.md and docs/DECISIONS.md exist and are specific, not generic.
Do not implement features beyond the scaffold. Show me the final tree and the commands to run.
````

---

## PROMPT 2: Database schema and migrations

````text
Read CLAUDE.md and docs/DECISIONS.md first. Now design and implement the PostgreSQL schema and a simple
migration runner (plain SQL files in packages/db/migrations, applied in order, tracked in a
schema_migrations table, run inside transactions). No heavy ORM: use `pg` with small typed helpers.

TABLES (adjust sensibly, but keep the intent, and explain any deviation in docs/DECISIONS.md):

locations(id, name)
devices(id text PK = device_id, name, location_id, api_key_hash, status enum[online,stale,offline,unknown],
        last_seen_at (server received time, monotonic via GREATEST), last_event_ts (device time),
        metadata jsonb, created_at)
operators(id, name, email, webhook_url nullable, active)
operator_locations(operator_id, location_id)   -- who covers which location (for routing)
events(
  ingest_seq bigserial PK,               -- server-side ordering/cursor
  device_id, event_id text, type text, event_ts timestamptz, received_at timestamptz default now(),
  payload jsonb, schema_version int, is_replay boolean,
  status enum[pending,processing,done,failed],   -- this table IS the work queue
  attempts int default 0, locked_until timestamptz, last_error text, processed_at timestamptz,
  UNIQUE (device_id, event_id)           -- idempotency / dedupe
)
  + partial index on (status, locked_until) for claiming; index on (device_id, event_ts desc).
rejected_events(id, device_id nullable, raw jsonb, reason text, received_at)  -- malformed payload visibility
rules(id, name, enabled, type enum[threshold,event_type,silence], scope (device_id | location_id | all),
      config jsonb,   -- threshold: {metric, op, value}; event_type: {event_type}; silence: {seconds}
      severity enum[low,medium,high,critical], cooldown_seconds, ignore_replayed boolean,
      auto_resolve boolean, notify_operator_ids int[] nullable, created_at, updated_at)
incidents(id, rule_id, device_id, dedupe_key, state enum[open,acknowledged,resolved], severity,
          title, first_event_id nullable, opened_at, acknowledged_at, acknowledged_by, resolved_at,
          resolved_by, last_seen_at, occurrence_count int, resolution_reason text)
  + UNIQUE partial index on dedupe_key WHERE state IN ('open','acknowledged')  <- the key to dedupe under concurrency
incident_events(incident_id, event_ingest_seq, attached_at, PRIMARY KEY(incident_id, event_ingest_seq))
rule_evaluations(id, event_ingest_seq nullable, device_id, rule_id, evaluated_at, matched boolean,
                 outcome enum[incident_created,incident_updated,suppressed_cooldown,skipped_replay,no_match,error],
                 reason text, incident_id nullable)    -- answers "why was/wasn't an incident created?"
notifications(id, incident_id, operator_id, channel, payload jsonb, status enum[pending,sending,sent,failed,dead],
              attempts, next_attempt_at, last_error, idempotency_key UNIQUE, created_at, sent_at)
activity_log(id bigserial, kind text, entity_type, entity_id, data jsonb, created_at)  -- feed + SSE cursor

TASKS:
1. Write the migrations (001_init.sql etc.) with enums, constraints, comments, and indexes.
2. packages/db: pool factory, `migrate()` runner, `withTransaction(fn)` helper, and `pg_notify` helper
   (channel names constants in packages/shared).
3. Seed script (scripts/seed.ts): 3 locations, ~12 devices with generated API keys (print once, store
   hashed with sha256), 3 operators mapped to locations, and 4 default rules (temperature > 80 high,
   device silent 60s, event_type "tamper" critical, battery < 15 low).
4. Add a small integration test proving: (a) duplicate (device_id,event_id) insert is rejected by the
   constraint, (b) two concurrent inserts of the same open incident dedupe_key result in exactly one row.

ACCEPTANCE CHECKS:
- `npm run db:reset && npm run db:migrate && npm run seed` is repeatable and idempotent.
- The 2 integration tests pass against real Postgres.
Document the schema with a short ER overview in docs/SCHEMA.md and explain WHY each uniqueness
constraint exists (this is the backbone of the reliability story).
````

---

## PROMPT 3: Ingestion API and device protocol

````text
Read CLAUDE.md and docs/DECISIONS.md. Implement the device-facing ingestion in apps/api, and document the
protocol in docs/PROTOCOL.md.

EVENT SCHEMA (zod in packages/shared):
{
  "event_id": string (device-generated UUIDv4/ULID, unique per device),
  "device_id": string,
  "seq": integer (optional, device-local monotonic counter, for debugging gaps),
  "type": string (e.g. "telemetry","heartbeat","tamper","battery_low"),
  "ts": ISO-8601 timestamp (device clock),
  "payload": object (type-specific; telemetry has e.g. {temperature, humidity, battery}),
  "schema_version": 1
}

ENDPOINTS:
- POST /v1/events    headers: X-Device-Id, X-Device-Key.   body: { "events": [Event, ...] } (max 500)
  Behavior:
  1. Authenticate device by id + key (compare against sha256 hash; constant-time compare). 401 if bad.
     Reject events whose device_id != authenticated device (per-event rejection, not whole batch).
  2. Validate each event independently with zod. Invalid ones go to `rejected_events` with a reason.
     One bad event must NEVER fail the whole batch.
  3. Backpressure: before inserting, check pending queue depth (cheap cached count, refresh ~1s).
     If depth > HIGH_WATERMARK (env, default 5000): respond 429 with Retry-After and a JSON body; insert nothing.
  4. Insert valid events in ONE statement: INSERT ... ON CONFLICT (device_id,event_id) DO NOTHING RETURNING.
     Compute is_replay = (received_at - ts > REPLAY_THRESHOLD_SECONDS, default 120).
     Reject absurd timestamps (more than 24h in the future) as invalid.
  5. Update devices.last_seen_at = GREATEST(last_seen_at, now()) and last_event_ts = GREATEST(...) in the same txn.
  6. Respond 200 with per-event ack:
     { "results": [ { "event_id": "...", "status": "accepted" | "duplicate" | "rejected", "reason"?: "..." } ] }
     The device may delete from its local buffer anything marked accepted, duplicate, OR rejected (permanent
     errors must not be retried forever). Only 429/5xx/timeouts mean "retry the whole batch".
  7. After commit, pg_notify the worker channel ("events_available") so processing is prompt.
     (The worker must also poll, so a lost NOTIFY is harmless. Note this in the docs.)
- POST /v1/devices/register (admin-token protected): create/rotate a device key, returns the key once.
- GET /healthz (liveness) and GET /readyz (checks DB reachable + queue depth below hard limit).

CROSS-CUTTING:
- Per-device simple rate limit (token bucket in memory) returning 429; log and count it.
- Request body size limit; correlation id per request in logs (pino child logger).
- Prometheus metrics: events_received_total{result}, ingest_batch_size, ingest_duration_seconds,
  ingest_rejected_total{reason}, queue_depth gauge.
- Structured log line per batch: device_id, counts of accepted/duplicate/rejected, duration.

PROTOCOL DOC (docs/PROTOCOL.md) must explain, in plain language:
- At-least-once from device, dedupe by (device_id,event_id), acks per event, retry/backoff/jitter rules,
  what the device does on 401/429/5xx/timeouts, how reconnect-replay works, clock-skew handling,
  and why we chose HTTP batches over MQTT/WebSocket (and that MQTT would be the production upgrade).

TESTS (Vitest, real Postgres, use fastify.inject or supertest):
- accepted, duplicate resend, malformed event mixed in a batch, wrong device key, mismatched device_id,
  out-of-order timestamps in one batch, future timestamp rejected, 429 when watermark exceeded,
  concurrent identical batches from two "connections" produce exactly N rows.

ACCEPTANCE: curl examples in docs/PROTOCOL.md work against the running API; all tests pass.
````

---

## PROMPT 4: Event processor worker (queue, leases, crash recovery)

````text
Read CLAUDE.md and docs/DECISIONS.md. Implement apps/worker's event processing loop.

DESIGN:
- The `events` table is the queue. Claim work with a lease:
  UPDATE events SET status='processing', locked_until = now() + LEASE, attempts = attempts+1
  WHERE ingest_seq IN (
    SELECT ingest_seq FROM events
    WHERE (status='pending') OR (status='processing' AND locked_until < now())
    ORDER BY ingest_seq LIMIT $batch FOR UPDATE SKIP LOCKED)
  RETURNING *;
  Expired leases are automatically re-claimed. That is the crash-recovery mechanism.
- Concurrency: configurable number of async workers/loops (WORKER_CONCURRENCY), and multiple worker
  PROCESSES must be safe to run at the same time.
- Wake-up: LISTEN on "events_available" AND poll every POLL_INTERVAL_MS (NOTIFY is only a hint).
- Per-event processing happens in ONE transaction that: (1) loads active rules in scope,
  (2) calls the rules engine (a pluggable interface `evaluate(event, rules, tx)` which I will implement in the next step;
  for now provide a stub that returns no matches), (3) updates the device's `status` to online,
  and auto-resolves silence incidents for that device if the rule has auto_resolve, via a hook,
  (4) marks the event status='done', processed_at=now(), (5) writes activity_log entries and pg_notify
  for the API's SSE broker. If anything throws, the transaction rolls back, the event stays claimed until
  the lease expires or we explicitly release it with last_error and a backoff (set locked_until = now()+backoff).
- Retry policy: attempts < MAX_ATTEMPTS (default 5) means exponential backoff; at MAX_ATTEMPTS mark status='failed'
  (a dead-letter state) with last_error and log at error level, and emit activity_log kind='event_failed'.
  Failed events must be visible via API later and re-queueable by an operator (POST /api/events/:seq/retry).
- Poison pill safety: one bad event must not block the batch behind it. Process each event independently.
- Graceful shutdown: on SIGTERM stop claiming, finish in-flight work (with timeout), release remaining leases.
- Rule cache: cache enabled rules in memory with short TTL (e.g. 5s) plus invalidation via NOTIFY "rules_changed".
- Metrics: events_processed_total{result}, processing_duration_seconds, processing_lag_seconds
  (now - received_at), queue_depth, in_flight, lease_reclaims_total, events_failed_total.
- Structured logs with event ingest_seq, device_id, attempt, outcome.

TESTS (real Postgres):
1. Happy path: N events inserted -> all end 'done', exactly once effect.
2. Crash simulation: claim events, "die" before commit (throw / kill the loop without releasing),
   advance/set locked_until in the past, run again -> events are reclaimed and processed; no event lost
   and no double effect (verify with a counter table or activity_log row count).
3. Poison event: processor throws for one specific event -> others in the batch complete; the poison event
   retries with backoff and ends 'failed' after MAX_ATTEMPTS.
4. Two worker instances run concurrently on 2,000 events -> each event processed exactly once (assert via
   attempts=1 and unique processed marker).
5. Graceful shutdown leaves no stuck 'processing' rows.

ACCEPTANCE: `npm run dev:worker` processes events inserted via the ingest API; `kill -9` of the worker
mid-burst followed by restart ends with all events 'done' (document the exact command to demo this).
````

---

## PROMPT 5: Rules engine and incident management

````text
Read CLAUDE.md and docs/DECISIONS.md. Implement the rules engine and incident lifecycle, plug it into the
worker's `evaluate` interface, and expose rule CRUD in the API.

RULE TYPES (config validated by zod discriminated union in packages/shared):
- threshold:  { metric: "temperature", op: ">"|">="|"<"|"<="|"==", value: number }  on events of type "telemetry"
              (read payload[metric]; missing/non-numeric = no match, with a recorded reason)
- event_type: { event_type: string }  matches events of that type
- silence:    { seconds: number }     evaluated by the scheduler (next prompt), NOT per event. The engine only defines its
              matching function and the incident-creating helper that the scheduler will call.
Common fields: name, enabled, scope (device | location | all), severity, cooldown_seconds,
ignore_replayed, auto_resolve, notify_operator_ids.

MATCH -> INCIDENT LOGIC (all inside the event's processing transaction):
1. For each applicable rule, produce a decision and ALWAYS write a rule_evaluations row with
   outcome + human-readable reason (e.g. "temperature=91.2 > 80", "payload.temperature missing",
   "skipped: event is a replay and rule.ignore_replayed=true", "suppressed: cooldown 300s active until ...").
   For high volume, write evaluation rows for matches and for non-matches ONLY when matched or when the
   rule has debug=true or the event is flagged; document the volume trade-off (add a `trace_all` env flag).
2. On match, upsert the incident using the dedupe key `rule:{rule_id}:device:{device_id}`:
   INSERT ... ON CONFLICT (dedupe_key) WHERE state IN ('open','acknowledged') DO UPDATE SET
   occurrence_count = occurrence_count + 1, last_seen_at = GREATEST(last_seen_at, event_ts).
   Use RETURNING (xmax = 0) AS inserted to know whether it was created or updated.
   This must be safe under concurrent workers (rely on the partial unique index, not app-level checks).
3. Attach the event to incident_events (ON CONFLICT DO NOTHING). Cap attached events per incident
   (e.g. keep first 50 + the last 50) so a long-running incident cannot grow without bound; always keep
   occurrence_count accurate.
4. Cooldown: after an incident is RESOLVED, a new match within cooldown_seconds does not open a new
   incident (outcome suppressed_cooldown, but still bumps a `suppressed_count` on the resolved incident or logs it).
5. Out-of-order handling: severity/state decisions never depend on arrival order; `opened_at` of a new
   incident uses received time, and `first_event_ts` records the earliest event_ts seen.
6. State machine (enforced in one service module with explicit allowed transitions):
   open -> acknowledged -> resolved, open -> resolved. Illegal transitions return a typed error (HTTP 409 later).
   Record timestamps and actor on each transition and write activity_log.
7. When an incident is CREATED (not merely updated), write notification rows to the outbox in the same
   transaction (one per target operator; targets = rule.notify_operator_ids, else operators covering the
   device's location via operator_locations, else fall back to all active operators). Use
   idempotency_key = `incident:{id}:operator:{operator_id}:opened`. Notification sending is the next prompt.
   Also notify on escalation if severity increases later (optional, skip if time-boxed).

API (apps/api) with zod validation + proper status codes:
- GET/POST/PATCH/DELETE /api/rules (PATCH to enable/disable; NOTIFY "rules_changed" on change)
- GET /api/rules/:id/test  or POST /api/rules/dry-run {rule, sample_event} -> returns match + reason, no side effects
- GET /api/incidents?state=&severity=&device_id=&limit=&cursor=
- GET /api/incidents/:id  (includes attached events, rule snapshot, evaluation history, notifications status)
- POST /api/incidents/:id/acknowledge, POST /api/incidents/:id/resolve  (body: {by, note?})
- GET /api/events/:seq/evaluations  -> "why was or wasn't an incident created for this event?"

TESTS:
- each rule type matches/does not match (table-driven), missing payload field, wrong type
- 500 identical-condition events for one device => exactly 1 open incident with occurrence_count 500
- concurrent processing of the same device's events by 2 workers => still 1 incident
- ack/resolve transitions + illegal transition 409
- cooldown suppression after resolve; new incident after cooldown expires
- replay flag with ignore_replayed true/false
- notifications rows created exactly once per incident creation even if the event is re-processed after a crash

ACCEPTANCE: seeded rules fire on simulated bad readings; incident detail answers "why" using rule_evaluations.
````

---

## PROMPT 6: Silence detector and notification outbox

````text
Read CLAUDE.md and docs/DECISIONS.md. Implement the two remaining background duties in apps/worker:
(A) the silence detector / device status scheduler, (B) the notifier with retries.

(A) SCHEDULER (runs every SCHEDULER_INTERVAL_MS, default 5s)
- Single-leader: use pg_try_advisory_lock so only one worker process runs the scheduler tick at a time
  (others skip). If the leader dies, the lock releases with the connection and another worker takes over.
- Device status derivation based on server `last_seen_at`:
  online if age < STALE_AFTER (default 30s); stale if < OFFLINE_AFTER (default 90s); offline otherwise;
  unknown if never seen. Update devices.status only on change, and write activity_log + pg_notify
  ('device_status_changed') on each change.
- For each enabled silence rule, find in-scope devices whose last_seen_at < now() - rule.seconds and which have
  no open/acknowledged incident for that rule+device (the partial unique index protects against races). Create the
  incident (title "Device X silent for Ns"), store the last_seen_at in details, and enqueue notifications in the same transaction.
- Auto-resolve: when a device that has an open silence incident reports again (processor hook from
  the previous step; also double-check in the scheduler) and the rule has auto_resolve=true, resolve it with
  resolution_reason "device resumed reporting" and write activity.
- IMPORTANT edge cases to handle and document:
  * Reconnect burst after a long gap: last_seen_at jumps to now -> silence incident auto-resolves.
  * Platform downtime: if the whole platform was down, do not mass-create silence incidents on startup.
    Add a startup grace period (e.g. 2x the max silence threshold, configurable) during which silence rules
    are not evaluated, because absence of data is ambiguous. Explain this choice.
  * Scheduler tick overlap: a tick that takes longer than the interval must not start a second concurrent run.

(B) NOTIFIER
- Poll `notifications` WHERE status IN ('pending','failed') AND next_attempt_at <= now()
  using FOR UPDATE SKIP LOCKED + lease (status='sending', locked_until) just like the event queue.
- Channels: "webhook" (POST JSON to operator.webhook_url or a default NOTIFY_WEBHOOK_URL, with timeout and
  an Idempotency-Key header) and "log" (always-on fallback so notifications are visible even without webhook).
- Retry policy: exponential backoff with jitter (e.g. 2s,4s,8s,... max 5 min), MAX_NOTIFY_ATTEMPTS (default 8),
  then status='dead' (visible in UI + metric + activity_log kind 'notification_dead'). Never block incident
  creation on notification failure (already guaranteed by the outbox pattern).
- Circuit breaker per destination: after K consecutive failures, open for a cool-off period and skip attempts
  (leave rows pending, do not burn attempts while the breaker is open); half-open probe after cool-off.
- Manual re-send endpoint: POST /api/notifications/:id/retry.
- Metrics: notifications_sent_total, notifications_failed_total, notification_attempts, outbox_depth,
  oldest_pending_notification_age_seconds, circuit_breaker_state.

WEBHOOK SINK (apps/webhook-sink): tiny Fastify app that logs received notifications, dedupes by Idempotency-Key,
exposes POST /admin/down, POST /admin/up, and GET /admin/received so I can demonstrate "external service
unavailable" -> retries -> recovery -> exactly one effective delivery per idempotency key.

TESTS:
- silence incident created once for a silent device; not created for a device that reported inside the window
- auto-resolve when device resumes (burst of buffered events included)
- startup grace period suppresses false positives
- two schedulers racing => single leader, no duplicate incidents
- notifier: sink down -> attempts increase with backoff and the status stays failed/pending; sink up -> sent
  exactly once; sink down forever -> dead after MAX attempts; breaker opens and half-opens
- worker killed mid-send (lease expires) -> notification re-sent; sink dedupes by idempotency key

ACCEPTANCE: demonstrate in docs/DEMO.md (stub for now) the sequence: stop a simulated device -> incident after N seconds ->
webhook sink down -> notification retries -> sink up -> delivered.
````

---

## PROMPT 7: Operator REST API and real-time stream (SSE)

````text
Read CLAUDE.md and docs/DECISIONS.md. Complete the operator-facing API and the real-time channel in apps/api.

REST (all JSON, zod-validated, consistent error shape {error:{code,message,details?}}, pagination via cursor):
- GET /api/devices?status=&location_id=&q=         list with status, last_seen_at, location, open incident count
- GET /api/devices/:id                              details + last 20 events + open incidents
- GET /api/events?device_id=&type=&after_seq=&limit=  (cursor on ingest_seq; `after_seq` enables catch-up after reconnect)
- GET /api/events/failed + POST /api/events/:seq/retry   (dead-lettered events)
- GET /api/rejected-events                           malformed payload visibility
- GET /api/stats                                     events/min (last 15 min buckets), ingest rate, queue depth,
                                                     processing lag p50/p95, devices by status, incidents by state/severity,
                                                     notifications by status, failed events count
- GET /api/activity?after_id=&limit=                 recent activity feed
- GET /api/notifications?status=
- GET /api/locations, GET /api/operators
- Operator auth: simple static bearer token from env (OPERATOR_TOKEN) via a Fastify hook, applied to /api/* and the SSE stream
  (EventSource cannot set headers, so accept ?token= for SSE, and document this trade-off and its limitation).
  Identify the acting operator by a header X-Operator-Id for ack/resolve audit.

SSE: GET /api/stream
- Event kinds: `event` (batched/coalesced: flush at most every 250ms, cap N events per flush, include a "dropped_since_last" count
  if the client is too slow), `incident` (created/updated/state change), `device` (status change), `activity`, `stats` (every 5s),
  `ping` (every 15s heartbeat comment to keep proxies alive and detect dead connections).
- Source of truth: the API process LISTENs on Postgres channels (events_ingested, incident_changed, device_status_changed, activity)
  and fans out to connected SSE clients through an in-memory broker. Payloads in NOTIFY must stay small (ids + minimal fields; <8KB limit);
  the broker fetches details if needed.
- Resume semantics: every SSE message carries `id:` = activity/event cursor. On reconnect the browser sends Last-Event-ID;
  the server replays missed items if the gap is small (<= 1000 items); otherwise it sends a `resync` message so the client refetches
  snapshots via REST. Document this in docs/ARCHITECTURE.md.
- Backpressure: bounded per-client queue; if the client falls behind, drop `event` messages (counted) but never drop `incident`/`device` messages.
- Clean up listeners on client disconnect; expose gauge sse_clients and counter sse_messages_sent_total.
- LISTEN connection resilience: if the dedicated LISTEN connection drops, reconnect with backoff, re-LISTEN, and send `resync` to clients.

TESTS: SSE receives an incident message after an event is processed; Last-Event-ID resume replays exactly the missed items;
resync is sent when the gap is too large; slow client is bounded; 401 without token; stats endpoint math sanity (bucket counts);
LISTEN connection killed -> API recovers and clients resync.

ACCEPTANCE: `curl -N "localhost:3000/api/stream?token=..."` shows live messages while the simulator-free curl ingest example runs.
````

---

## PROMPT 8: Frontend dashboard (React)

````text
Read CLAUDE.md and docs/DECISIONS.md. Build apps/web: the live operations dashboard. Use React + Vite + TypeScript +
TanStack Query, plain CSS modules or Tailwind (pick one, keep it light), and a small chart library only if needed (Recharts is fine).
Prioritize clarity and operator usefulness over visual polish, but it should look professional and clean.

LAYOUT / VIEWS (single-page app, simple router):
1. Overview: stat cards (devices online/stale/offline, open incidents by severity, events/min, queue depth, processing lag,
   failed events, notification failures), a small events-per-minute chart, and a recent activity feed.
2. Devices: table with search + status/location filters, status badge, last seen (relative time, ticking), open incidents count.
   Row click opens a device drawer: latest readings, recent events, linked incidents.
3. Live Events: a scrolling live feed (newest first, capped at ~500 in memory), pause/resume button, type/device filter,
   badge for "replayed" events, and "N events dropped by throttle" notice if the server reports drops.
4. Incidents: list with state/severity filters; detail view showing rule snapshot, timeline (opened/acknowledged/resolved with actor + time),
   occurrence_count, attached events, the "why" (rule evaluation reasons), and notification delivery status per operator.
   Buttons: Acknowledge, Resolve (with optional note) with optimistic UI and proper error handling (409 shows a friendly message).
5. Rules: list + create/edit form for threshold / event_type / silence rules (dynamic form per type), enable/disable toggle,
   a "Test rule" panel using the dry-run endpoint with a sample event editor.
6. System: failed events (retry button), rejected events, notification outbox (dead letters + retry), health/ready status.

REAL-TIME + RESILIENCE (this is the key part):
- A `useLiveStream` hook wrapping EventSource: connection state machine (connecting / live / reconnecting / offline), exponential
  backoff reconnect with jitter handled by us (close and recreate on error to control timing), tracks last cursor.
- Persistent top banner when not live: "Connection lost, showing data from HH:MM:SS. Reconnecting..." with a manual retry button.
  Also listen to the browser online/offline events and document.visibilitychange (refresh on tab refocus).
- On every (re)connect or `resync` message: invalidate/refetch TanStack Query caches and fetch `GET /api/events?after_seq=<last>`
  so the UI catches up without a full reload. De-duplicate events client-side by ingest_seq.
- The UI stays usable offline: it keeps showing last known data (stale markers), disables mutation buttons with a tooltip
  ("offline: reconnect to acknowledge"), and does not blank out on errors.
- Apply SSE messages to the Query cache surgically (setQueryData) for incidents/devices; throttle high-rate event rendering
  with requestAnimationFrame batching to avoid UI jank during bursts.
- Accessibility basics: semantic tables, keyboard-focusable controls, color is never the only status indicator.

ENGINEERING:
- API client with typed responses using shared zod types, central error handling, token from env (VITE_OPERATOR_TOKEN) for the demo.
- Component tests (Vitest + Testing Library) for the useLiveStream state machine (fake EventSource) and the incident action buttons.
- Dockerfile for the web app (build + nginx) and wire it into docker-compose.

ACCEPTANCE: with the stack running and a seeded dataset, I can watch events appear live, see a device go stale/offline, see an incident
appear without refresh, acknowledge/resolve it, kill the API container and see the banner + retained data, restart the API and see
automatic catch-up with no duplicate rows.
````

---

## PROMPT 9: Device simulator and chaos scripts

````text
Read CLAUDE.md and docs/DECISIONS.md. Implement apps/simulator, a lightweight Node CLI that behaves like a fleet of realistic devices
and can reproduce every failure scenario in the assignment on demand.

SIMULATOR FEATURES:
- Config via CLI flags/env: --devices N, --api URL, --rate events/sec/device, --seed for reproducibility, --scenario name.
  Load device credentials from a JSON file produced by the seed script (device_id -> api_key).
- Each simulated device:
  * Generates `telemetry` events (temperature random-walk, humidity, battery drain), periodic `heartbeat`, occasional rare events
    (`tamper`, `battery_low`). Each event has a uuid event_id, a monotonic `seq`, and ts from the device's own (optionally skewed) clock.
  * Sends in batches over HTTP with timeout; reads per-event acks; removes only acked/duplicate/rejected events from its buffer.
  * Offline buffer: durable on disk (append-only JSONL file per device, with compaction after acks) so killing and restarting the
    simulator process preserves unsent events. Buffer has a max size with a documented drop policy (drop oldest telemetry, never drop alerts).
  * Retry policy: exponential backoff with full jitter on network errors/5xx/429 (honor Retry-After); 401 -> stop and log loudly.
  * Reconnect: after being offline, flush the backlog in chunks (e.g. 200 per request) in timestamp order or deliberately
    shuffled (flag --shuffle-replay) to prove out-of-order handling.
  * Interactive control: each device can be put OFFLINE/ONLINE at runtime (simple local control HTTP port or stdin commands:
    `offline dev-3 120s`, `online dev-3`, `burst dev-5 5000`, `status`).
- Scenarios (npm scripts, each prints a clear expected outcome so I can verify against the dashboard):
  1. `normal`: steady traffic from N devices.
  2. `offline-reconnect`: device goes offline 3 min, buffers events, reconnects and replays (silence incident opens, then auto-resolves).
  3. `duplicates`: re-sends the same batch 3 times and random individual events (dedupe proof; counts must match).
  4. `out-of-order`: shuffled timestamps within and across batches.
  5. `burst`: 50k events at max speed across devices to exceed processing capacity (expect 429s, backlog, then drain with zero loss).
  6. `malformed`: mix of invalid JSON, missing fields, wrong types, oversized payloads, future timestamps (expect rejected_events rows
     and valid ones still accepted).
  7. `abnormal-readings`: temperature spike for one device (one incident, occurrence_count grows, not N incidents).
  8. `chaos`: random combination over 5 minutes (kill/restart loop is documented as a manual step with docker commands).
- Reconciliation tool (scripts/reconcile.ts): the simulator logs every event_id it generated and which were acked; the script
  queries the DB and asserts: generated == acked-or-buffered; no event stored twice; no accepted event missing a final status
  ('done' or 'failed'); prints a PASS/FAIL report. This gives an end-to-end "zero loss, zero dupes" proof.

ALSO: scripts/chaos.sh with documented commands to: stop/start the worker container mid-burst, stop/start postgres briefly,
stop/start the api, bring the webhook sink down/up. Include the expected behaviour next to each command.

ACCEPTANCE: run `scenario burst` + `docker compose kill -s KILL worker` + restart, then reconcile.ts prints PASS.
Keep the simulator under ~600 lines; clarity beats cleverness.
````

---

## PROMPT 10: Tests, observability polish, docs, deployment notes, demo

````text
Read CLAUDE.md and docs/DECISIONS.md. This is the finishing pass. Audit the whole repo against the assignment and complete the deliverables.

1. TEST SUITE CONSOLIDATION
   - `npm test` runs unit + integration tests (real Postgres from docker compose, test DB reset per file).
   - Add an e2e failure suite (tests/e2e/failures.test.ts) that boots api + worker in-process or via compose and verifies:
     duplicate delivery, accepted-but-processing-fails (poison event -> retry -> failed -> manual retry succeeds),
     worker restart mid-burst (lease reclaim), notification service down then up, device offline minutes then replay with out-of-order
     events, ingest above capacity (429 + eventual full drain), LISTEN connection loss + SSE resync.
   - Produce a short coverage-of-scenarios table in docs/TESTING.md mapping each assignment failure bullet -> test name -> expected result.
   - Fix any flaky tests (no sleeps; poll with timeouts).

2. OBSERVABILITY POLISH
   - Verify: structured JSON logs with consistent fields (service, request_id, device_id, ingest_seq, rule_id, incident_id, outcome).
   - Add GET /api/debug/incidents-why?device_id=&rule_id=&since= (or equivalent) that returns recent rule_evaluations for a device/rule,
     so an operator can answer "why was/wasn't an incident created?". Surface it in the UI incident/device detail if not already.
   - /readyz reports: db ok, worker heartbeat age (write a worker_heartbeat row/timestamp each loop), queue depth, outbox depth, scheduler leader age.
   - Add a Grafana-free "Metrics" doc: list every metric, what it means, and 5 example alert rules (queue lag > 30s, failed events > 0,
     outbox oldest age > 5m, 5xx rate, no scheduler heartbeat).
   - Optionally include docker-compose profile `monitoring` with Prometheus (+ Grafana dashboard JSON) if time allows. Do not spend more than ~20 minutes.

3. DOCUMENTATION (concise, specific, honest)
   - README.md: what it is, 3-command quickstart (`docker compose up --build`, seed, run simulator), URLs, default credentials/tokens,
     how to run tests, how to run each simulator scenario, troubleshooting.
   - docs/ARCHITECTURE.md: Mermaid component diagram + Mermaid sequence diagrams for (a) normal ingest->process->incident->notify->SSE,
     (b) offline reconnect replay, (c) worker crash recovery. Explain data flow, guarantees table, state machines (incident, event, notification),
     key decisions with alternatives and trade-offs (reference ADRs), and capacity thinking (what limits throughput, what we would measure).
     Export a PNG/SVG of the main diagram into docs/ as well.
   - docs/PROTOCOL.md: final check that it matches the implementation.
   - docs/RELIABILITY.md: "What happens when X fails?" table: duplicate delivery, accepted-but-failed processing, worker restart, API restart,
     Postgres outage, notification outage, device offline for minutes, overload, clock skew, SSE disconnect, rule changed mid-burst.
     For each: behaviour, guarantee, how it is tested, residual risk.
   - docs/LIMITATIONS.md: honest list (static operator token, single Postgres is a single point of failure, queue-in-Postgres throughput ceiling,
     no multi-tenant isolation, device key rotation story, event retention/partitioning not implemented, silence rule precision limited by scheduler interval,
     at-least-once webhooks require receiver idempotency, etc.).
   - docs/DEPLOYMENT.md: how I would deploy for a real client: containers on ECS/Kubernetes, managed Postgres with HA + PITR backups,
     read replica for dashboards, PgBouncer, API and worker scaled independently (HPA on queue lag), TLS + API gateway/WAF,
     device auth (per-device keys -> mTLS or short-lived tokens), MQTT broker (EMQX/AWS IoT Core) in front of ingestion for large fleets,
     migration to Kafka/Redis Streams when the Postgres queue becomes the bottleneck (with the migration path and the interface boundary
     that makes it a swap), partitioning events by time + retention policy, monitoring/alerting/SLOs, secrets management, CI/CD with
     migrations strategy, load testing plan, cost notes, rollout + rollback.
   - docs/DEMO.md: a 10-minute demo script with exact commands and what to point at in the UI, ending with the failure demos
     (kill worker mid-burst, sink down/up, kill API and watch the UI banner, reconcile PASS).

4. FINAL AUDIT
   - Walk the assignment checklist (sections 1-6) and mark each requirement with where it is implemented/tested. Put this in docs/REQUIREMENTS_TRACE.md.
   - Run a clean-clone verification: fresh clone -> `docker compose up --build` -> seed -> simulator -> dashboard works; fix anything that does not.
   - Remove dead code, TODOs, console.logs; make sure .env.example is complete and no secrets are committed.
   - Produce docs/VIVA_NOTES.md: 15 likely questions ("what happens if the worker dies after inserting the incident but before marking the event done?",
     "why not Kafka?", "how do you prevent duplicate incidents under concurrency?", "what if device clocks are wrong?", "how would this scale 100x?")
     with crisp 3-5 line answers grounded in this implementation.

ACCEPTANCE: a new engineer can follow README.md only and reach a working dashboard with live data in under 10 minutes; `npm test` is green;
docs contain no claims that the code does not back up.
````

---

## Appendix A: Reliability cheat sheet (memorize this)

| Scenario | What happens | Why it's safe |
|---|---|---|
| Same event delivered twice | Second insert hits `UNIQUE(device_id,event_id)` and is acked as `duplicate` | The DB enforces dedupe, so concurrency can't break it |
| Accepted but processing fails | The txn rolls back, the event stays claimed, and is retried with backoff. After 5 attempts it is `failed` and visible in the UI with a manual retry | The failure is never silent and never blocks other events |
| Worker restarts or is killed | The lease expires and another worker re-claims the event | There is no in-memory-only state |
| Crash after incident insert but before "done" | Both are in **one transaction**, so both roll back and the retry is idempotent via the dedupe key | Effects are exactly-once even though delivery is at-least-once |
| Notification service down | Outbox rows retry with backoff and a circuit breaker. After N attempts they go dead-lettered, visible in the UI, with manual retry | Incident creation is decoupled from notification |
| Device offline for minutes then replays | Silence incident opens, the burst is accepted, out-of-order events are handled, and the incident auto-resolves | Rules are order-insensitive, and `last_seen_at` uses `GREATEST` |
| Ingest exceeds processing capacity | The API returns 429 + Retry-After at the watermark and devices keep buffering | The load is bounded and nothing is silently dropped |
| Postgres down | The API fails `/readyz` and returns 503, and devices retry from their buffers | Devices are the durable source until acked |
| Browser loses connection | A banner shows stale data, then the client reconnects and catches up via `after_seq` and resync | Dedupe on the client by `ingest_seq` |

## Appendix B: Scope guard (what NOT to build)

Skip these unless everything else is done: user management/RBAC, multi-tenancy, MQTT broker, Kubernetes manifests, fancy charts, email/SMS integrations
(a webhook plus log channel is enough), schema registry, event replay UI. Mention them in `docs/DEPLOYMENT.md` and `docs/LIMITATIONS.md` instead.
Judges prefer a smaller system whose failure behavior you can explain.

## Appendix C: Quality gates before you submit

- [ ] Fresh clone to a working demo in under 10 minutes
- [ ] `npm test` green, including the e2e failure suite
- [ ] `reconcile.ts` prints PASS after the burst + kill-worker scenario
- [ ] Architecture diagram renders in the README
- [ ] Every ADR names alternatives and trade-offs
- [ ] Limitations are stated honestly
- [ ] You can answer every question in `docs/VIVA_NOTES.md` without reading it
