# Requirements Traceability Matrix

This matrix maps all core deliverables from the assignment prompt to their locations in this repository.

| Requirement | Implementation Location | Verification Evidence |
|---|---|---|
| **Monorepo Layout** | `apps/api`, `apps/worker`, `apps/web`, `apps/simulator`, `apps/webhook-sink`, `packages/db`, `packages/shared` | Monorepo root `package.json` |
| **Durable Ingestion Queue** | `packages/db/migrations/001_init.sql`, `apps/api/src/routes/ingest.ts` | `events` table with `SKIP LOCKED` |
| **Worker Queue Consumer** | `apps/worker/src/processor.ts` | Lease claiming and crash reclamation |
| **Rules Engine & Incidents** | `apps/worker/src/rules.ts`, `apps/api/src/routes/rules.ts`, `apps/api/src/routes/incidents.ts` | Deduplication via partial unique index |
| **Silence Detection** | `apps/worker/src/silence.ts` | Single-leader advisory lock + status derivation |
| **Notification Outbox** | `apps/worker/src/notifier.ts`, `apps/webhook-sink/src/index.ts` | Outbox table with `Idempotency-Key` header |
| **Real-Time SSE Broker** | `apps/api/src/sse/broker.ts`, `apps/api/src/sse/listener.ts`, `apps/api/src/routes/stream.ts` | Dedicated LISTEN connection & `Last-Event-ID` |
| **Operations Dashboard** | `apps/web/src/` | React + TanStack Query UI with offline recovery banner |
| **Fleet Device Simulator** | `apps/simulator/src/` | CLI supporting all failure scenarios |
| **Reconciliation Script** | `scripts/reconcile.ts` | Mathematical zero-loss proof |
| **Architecture Documentation** | `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/SCHEMA.md`, `docs/RELIABILITY.md` | Mermaid sequence diagrams & ADRs |
| **Docker Compose Packaging** | `docker-compose.yml` | Multi-container composition with health checks |
