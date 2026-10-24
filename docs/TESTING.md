# Test Suite & Failure Scenario Coverage

This document maps every required failure scenario from the assignment specification to its automated test or reproduction script.

## Scenario Mapping Table

| Assignment Requirement | Implementation Mechanism | Test Suite / Script | Expected Verification |
|---|---|---|---|
| **Out-of-order events** | Monotonic server receive time via `GREATEST()` and separate `event_ts`. | `npm run scenario:out-of-order` | Server `last_seen_at` is never rolled back; rule evaluations evaluate consistently. |
| **Duplicate deliveries** | `UNIQUE (device_id, event_id)` constraint on `events`. | `npm run scenario:duplicates` | All duplicate sends return `status: "duplicate"`; `reconcile` script confirms 0 duplicate rows. |
| **Disconnect & Reconnect** | Durable disk file buffer (`.jsonl`) on device; batch replay on reconnect. | `npm run scenario:offline` | Silence incident opens after 60s; auto-resolves when backlog replays. |
| **Bursts & Overload** | Queue high watermark triggers `429 Too Many Requests` + `Retry-After`. | `npm run scenario:burst` | Rate-limited devices buffer and drain without silent drops. |
| **Malformed payloads** | Per-event Zod schema validation; failed items stored in `rejected_events`. | `npm run scenario:malformed` | Healthy events in batch are accepted; malformed items isolated in `rejected_events`. |
| **Worker process crash** | Lease-based locking (`locked_until`) with `FOR UPDATE SKIP LOCKED`. | `scripts/chaos.sh` (Step 2) | Expired leases automatically reclaimed by next worker tick. |
| **Notification service outage** | Transactional outbox with exponential backoff & circuit breaker. | `curl /admin/down` on sink + `scenario:abnormal` | Outbox accumulates as `failed`; delivered once sink recovers via `/admin/up`. |
| **Long offline gaps** | Silence detector scheduler using PostgreSQL advisory lock. | Silence detector tick | Silence incident opened with last known server timestamp. |
| **End-to-End Consistency** | Mathematical reconciliation script querying DB invariants. | `npm run reconcile` | Confirms: 0 duplicate events, 0 duplicate active incidents, zero data loss. |
