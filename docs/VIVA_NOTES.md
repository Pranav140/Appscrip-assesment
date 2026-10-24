# Viva & Technical Evaluation Q&A

15 crisp, defendable answers for live technical interviews and viva assessments.

---

### Q1: Why use PostgreSQL as the queue instead of Kafka or RabbitMQ?
**Answer**: For this scale (<10,000 ev/s), PostgreSQL with `FOR UPDATE SKIP LOCKED` allows event processing, incident creation, and notification outbox writes to execute inside the **exact same ACID transaction**. This completely eliminates distributed dual-write inconsistencies (e.g. event committed to DB but message broker write failed). When scale exceeds database write limits, the interface allows a clean swap to Kafka without changing business logic.

---

### Q2: What happens if the worker process crashes after inserting an incident but before marking the event done?
**Answer**: They are in the **same database transaction**. If the worker crashes or dies, the transaction automatically rolls back. The event remains in the queue, its lease (`locked_until`) expires after 30 seconds, and another worker safely reclaims it. Furthermore, the incident upsert uses an idempotent dedupe key, so re-processing is guaranteed harmless.

---

### Q3: How do you prevent duplicate incidents under high concurrency?
**Answer**: We do not rely on fragile application memory or query-then-insert checks. We enforce a partial unique index at the database level:
`CREATE UNIQUE INDEX uq_incident_dedupe_active ON incidents(dedupe_key) WHERE state IN ('open', 'acknowledged');`
Concurrent workers attempting to insert an incident for the same rule and device safely hit this index and atomically increment `occurrence_count` instead.

---

### Q4: Why are device clocks untrusted? How do you handle clock skew?
**Answer**: Field devices frequently suffer from drift, bad NTP sync, or deliver buffered logs from hours ago. We store both `event_ts` (device-reported) and `received_at` (server monotonic time). Device status and silence rules evaluate strictly on `received_at`. Monotonic `GREATEST(last_seen_at, now())` ensures arrival of old replayed events never rolls backward the device's online status.

---

### Q5: How does the system handle backpressure during burst traffic?
**Answer**: Before accepting writes, the Ingest API checks the cached depth of pending events. If queue depth exceeds the high watermark (default 5,000), the API immediately returns `HTTP 429 Too Many Requests` with a `Retry-After: 5` header. Field devices buffer events durably on local disk instead of dropping them, and drain when capacity clears.

---

### Q6: How does the dashboard stay in sync when the network drops?
**Answer**: The browser uses Server-Sent Events (SSE) with `Last-Event-ID`. Upon network drop, a persistent UI banner warns the operator with the timestamp of last known good data. When connection resumes, the server replays missed items or issues a `resync` message that triggers TanStack Query to refetch fresh REST snapshots, avoiding duplicate rows.

---

### Q7: What is the purpose of the Transactional Outbox?
**Answer**: Calling external notification webhooks directly inside the event processing loop risks timeouts, latency spikes, or failed incident creation if the webhook endpoint is down. The outbox pattern writes notification intents to a database table within the incident transaction, allowing a background dispatcher to retry with exponential backoff and circuit breaking.

---

### Q8: How do you prevent duplicate webhook notifications on worker retry?
**Answer**: Every notification row contains a deterministic `idempotency_key` (e.g. `incident:{id}:operator:{operator_id}:opened`). When dispatching HTTP webhooks, the worker sends this key in the `Idempotency-Key` header. Compliant webhook receivers and our mock sink deduplicate deliveries against this key.

---

### Q9: What happens if a device is offline for 2 hours and suddenly reconnects with 5,000 events?
**Answer**: First, during the outage, the silence detector opens a silence incident. Upon reconnection, the device flushes its backlog in chunks (marked `is_replay = true`). The server receives the first chunk, updates `last_seen_at` to current time, and auto-resolves the silence incident with reason `"device resumed reporting"`. Rules configured with `ignore_replayed: true` will safely ignore stale historic triggers.

---

### Q10: How do you prevent poison pill events from stalling the queue?
**Answer**: Each event is claimed and processed in isolation. If a malformed or corrupted event causes processing exceptions, its `attempts` counter increments and its lease is released with exponential backoff. Once `attempts >= MAX_ATTEMPTS` (5), the event is marked `status = 'failed'` (dead-lettered) and recorded in `activity_log`. Healthy events behind it in the queue continue processing unimpeded.

---

### Q11: How do you avoid multiple workers running the silence detection scheduler simultaneously?
**Answer**: We use PostgreSQL advisory locks: `SELECT pg_try_advisory_lock(987654321)`. Only one worker process can acquire this lock. If that leader process dies, PostgreSQL automatically releases the advisory lock with the connection, allowing another worker to seamlessly assume the scheduler role on the next tick.

---

### Q12: How do you prevent false-positive silence alerts when the entire platform reboots?
**Answer**: The silence detector includes a configurable **Startup Grace Period** (default 60 seconds). Because absence of data immediately after platform reboot is ambiguous (the platform was down, not necessarily the devices), silence evaluations are deferred until the fleet has had ample time to re-establish connectivity.

---

### Q13: What happens if an operator tries to acknowledge an already resolved incident?
**Answer**: The incidents state machine enforces legal transitions: `open -> acknowledged`, `open -> resolved`, `acknowledged -> resolved`. Attempting an illegal transition returns `HTTP 409 Conflict`. The UI catches this and informs the operator without crashing.

---

### Q14: How does the system answer: "Why was or wasn't an incident created for this event?"
**Answer**: Every rule evaluation writes an immutable audit record to `rule_evaluations` storing `event_ingest_seq`, `rule_id`, `matched` (boolean), `outcome` (`incident_created`, `suppressed_cooldown`, `skipped_replay`, `no_match`), and a human-readable `reason` (e.g. `"temperature=92.4 > 80"` or `"skipped: event is replay"`). Operators can inspect this audit trail directly in the UI.

---

### Q15: How would you scale this platform to 100,000 devices?
**Answer**:
1. Place an MQTT broker (EMQX / AWS IoT Core) at the edge for persistent lightweight connections.
2. Bridge incoming telemetry to Apache Kafka partitioned by `device_id`.
3. Separate the Ingest API from the Operator Dashboard API.
4. Scale worker consumers horizontally using Kafka consumer groups.
5. Retain hot incident state in PostgreSQL while partitioning historical events across timescale / ClickHouse.
