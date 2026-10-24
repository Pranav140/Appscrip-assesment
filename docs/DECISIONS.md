# Architecture Decision Records (ADR)

This document records the foundational architectural decisions made in the Real-Time Operations Platform (RTOps), detailing context, decisions, alternatives considered, and trade-offs.

---

### ADR-1: PostgreSQL as Durable Queue (SKIP LOCKED) Instead of Kafka / Redis
- **Context**: Events must be buffered durably and processed with at-least-once guarantees and crash resilience.
- **Decision**: Use the Postgres `events` table with `status IN ('pending', 'processing')`, lease expiration (`locked_until`), and `FOR UPDATE SKIP LOCKED`.
- **Alternatives Considered**: Kafka (operational complexity, unnecessary for local evaluation), Redis Streams (requires two data stores, weaker transactional deduplication).
- **Consequences**: Single source of truth; zero distributed transactions; processing and state updates happen in the exact same ACID transaction. Throughput ceiling is bounded by Postgres write IOPS (~5,000-10,000 writes/sec), documented as the scaling swap point.

---

### ADR-2: HTTP Batch Ingestion with Per-Event Ack
- **Context**: Devices push telemetry across unreliable cellular/Wi-Fi links.
- **Decision**: Provide `POST /v1/events` accepting batches up to 500 events with per-event status (`accepted`, `duplicate`, `rejected`).
- **Alternatives Considered**: MQTT (industry standard for IoT; stateful broker needed), WebSockets (stateful, complex connection churn on flaky networks).
- **Consequences**: Stateless, easily load-balanced; client purges only acked/duplicate/rejected items. MQTT is documented in `docs/DEPLOYMENT.md` as the production edge upgrade.

---

### ADR-3: Server-Sent Events (SSE) + REST Catch-Up for Live Dashboard
- **Context**: Operator dashboard requires real-time updates for telemetry, incidents, and device state changes.
- **Decision**: Use HTTP Server-Sent Events (`GET /api/stream`) for server-to-client updates, combined with REST catch-up (`/api/events?after_seq=...`).
- **Alternatives Considered**: WebSockets (unnecessary overhead for unidirectional server-to-browser streaming), Short Polling (inefficient, high latency).
- **Consequences**: Automatic browser reconnection, native `Last-Event-ID` cursor support, works through HTTP/2 proxies without WebSocket upgrade handshakes.

---

### ADR-4: At-Least-Once Delivery with Idempotent Processing
- **Context**: Devices retry on network drops, causing inevitable duplicate deliveries.
- **Decision**: Enforce idempotency at the database boundary via `UNIQUE (device_id, event_id)` on the `events` table.
- **Alternatives Considered**: Application memory deduplication (lost on restart), Redis TTL keys (non-transactional with event insertion).
- **Consequences**: Concurrency cannot produce duplicates; concurrent identical batches resolve cleanly into one stored row.

---

### ADR-5: Untrusted Device Clocks
- **Context**: Devices may have uncalibrated RTCs, dead CMOS batteries, or deliver buffered events months late.
- **Decision**: Store both `event_ts` (device clock) and `received_at` (server monotonic time). Device status and silence detection strictly evaluate `received_at`.
- **Alternatives Considered**: Trusting `event_ts` (causes spurious alerts or prevents offline reconnect).
- **Consequences**: Resilient against clock skew, time-travel payloads, and replay storms.

---

### ADR-6: Incident Deduplication Key
- **Context**: Bursts of abnormal readings (e.g., 500 temperature readings > 80°C) must not generate 500 separate incident tickets.
- **Decision**: Use composite dedupe key `rule:{rule_id}:device:{device_id}` with a partial unique index:
  `CREATE UNIQUE INDEX uq_incident_dedupe_active ON incidents(dedupe_key) WHERE state IN ('open', 'acknowledged');`
- **Alternatives Considered**: Application-level query-then-insert (racy under concurrent workers).
- **Consequences**: Atomic upsert increments `occurrence_count` and updates `last_seen_at` without duplicate incident records.

---

### ADR-7: Transactional Outbox for Notifications
- **Context**: External webhook endpoints can be slow, intermittent, or down.
- **Decision**: Enqueue notifications into a `notifications` table in the exact transaction that creates the incident. A background dispatcher delivers with retries and a circuit breaker.
- **Alternatives Considered**: Inline HTTP dispatch during incident creation (risks rolling back incidents or losing alerts when webhook fails).
- **Consequences**: Zero lost notifications; decoupled availability.

---

### ADR-8: Backpressure via 429 + Retry-After
- **Context**: Bursts exceeding database ingestion capacity must not crash the API or cause unmonitored dropouts.
- **Decision**: Check cached queue depth. If depth > `QUEUE_HIGH_WATERMARK` (5,000), return `429 Too Many Requests` with a `Retry-After: 5` header.
- **Alternatives Considered**: Unbounded memory buffering (causes OOM), silent drop (violates delivery guarantees).
- **Consequences**: Devices continue buffering on local disk and drain gracefully when platform recovers.
