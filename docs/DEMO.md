# 10-Minute Live Evaluation Demo Script

Follow this step-by-step walkthrough to reproduce and verify every requirement in the assignment.

## Prerequisites
- Node.js 20+
- Docker & Docker Compose running

---

## 1. Clean Boot & Database Seeding (1 min)
```bash
# 1. Start Postgres and Webhook Sink in docker
docker compose up -d postgres webhook-sink

# 2. Reset and migrate database
npm run db:reset && npm run db:migrate

# 3. Seed demo dataset (locations, devices with SHA-256 keys, operators, rules)
npm run seed
```

## 2. Start Services (1 min)
In separate terminal tabs:
```bash
# Tab A: Fastify API
npm run dev:api

# Tab B: Background Worker
npm run dev:worker

# Tab C: Web Operations Dashboard
npm run dev:web
```
Open browser to: `http://localhost:5173`

---

## 3. Verify Normal Fleet Operation (2 min)
```bash
npm run scenario:normal
```
- **What to look at in UI**:
  - Live Events tab streams telemetry events in real time.
  - Overview tab shows devices online and events/min graph moving.
  - Queue depth remains near 0.

---

## 4. Failure Demo 1: Device Disconnect & Reconnect Replay (2 min)
```bash
npm run scenario:offline
```
- **Sequence**:
  1. Target device `dev-001` goes offline.
  2. In UI: Within 60 seconds, `dev-001` transitions to `stale` then `offline`.
  3. A **Silence Incident** opens automatically in the Incidents tab.
  4. Device reconnects and flushes buffered backlog from local disk.
  5. The silence incident automatically resolves with reason `"device resumed reporting"`.

---

## 5. Failure Demo 2: Alarm Deduplication & Cooldown (2 min)
```bash
npm run scenario:abnormal
```
- **Sequence**:
  1. Device sends temperature spikes (>95°C).
  2. Single High Temperature Incident opens.
  3. Notice the **Matches** count increments (5 matches) instead of opening 5 separate incidents.
  4. In UI Incidents tab: Click incident to inspect "Why was this created?" rule evaluation audit.

---

## 6. Failure Demo 3: Webhook Outage & Circuit Breaker (2 min)
```bash
# 1. Bring external webhook sink down
curl -X POST http://localhost:3003/admin/down

# 2. Trigger critical tamper event
npm run scenario:abnormal

# 3. Inspect System tab in UI
# Notification is queued in Outbox as 'failed' with exponential backoff.
# Circuit breaker opens after 5 failures to protect the system.

# 4. Restore webhook sink
curl -X POST http://localhost:3003/admin/up

# 5. Worker retries and notification transitions to 'sent' exactly once!
```

---

## 7. Zero-Loss Audit Proof
```bash
npm run reconcile
```
Expected output:
```
AUDIT RESULT: [ PASS ] Zero data loss, zero duplication.
```
