# Database Schema & Constraint Architecture

The PostgreSQL schema serves as both the persistent system of record and the durable work queue. Reliability is enforced through database constraints rather than application-layer locks.

## Entity Relationship Overview

```
 [ locations ] <─── (location_id) ─── [ devices ]
       │                                     │
       │                               (device_id)
       ▼                                     ▼
 [ operator_locations ]                  [ events ] (Durable Queue)
       │                                     │
       ▼                               (ingest_seq)
 [ operators ]                               ▼
       ▲                             [ incident_events ]
       │                                     ▲
  (operator_id)                              │
       │                               (incident_id)
 [ notifications ] (Outbox) <─────── [ incidents ]
                                             ▲
                                             │ (rule_id)
                                             │
                                         [ rules ]
```

## Why Each Uniqueness Constraint Exists

### 1. `events (device_id, event_id)`
```sql
UNIQUE (device_id, event_id)
```
- **Purpose**: Idempotency boundary.
- **Guarantee**: Even if an offline device replays an entire batch 5 times, or network retries resend identical packets, exactly one event row is stored. The API returns `status: "duplicate"` on conflict.

### 2. `incidents.uq_incident_dedupe_active`
```sql
CREATE UNIQUE INDEX uq_incident_dedupe_active
  ON incidents(dedupe_key)
  WHERE state IN ('open', 'acknowledged');
```
- **Purpose**: At-most-one active incident per `(rule, device)` pair.
- **Guarantee**: Eliminates duplicate incident creation under concurrent worker processing. Subsequent matches execute:
  ```sql
  DO UPDATE SET occurrence_count = occurrence_count + 1, last_seen_at = EXCLUDED.last_seen_at
  ```
- **Partial Index Rationale**: The `WHERE state IN ('open', 'acknowledged')` clause ensures that once an incident is marked `resolved`, a new incident is free to open when the device triggers the rule again after its cooldown window.

### 3. `notifications.idempotency_key`
```sql
UNIQUE (idempotency_key)
```
- **Format**: `incident:{id}:operator:{operator_id}:opened`
- **Purpose**: Exactly-once webhook dispatch semantics.
- **Guarantee**: If a worker crashes mid-send and the lease expires, the re-attempt sends the identical `Idempotency-Key` HTTP header. The webhook sink uses this key to deduplicate deliveries.
