# RTOps — Real-Time Operations Platform

Read `docs/DECISIONS.md` before making architectural changes.

## Project Summary
RTOps is a robust real-time operations and fleet monitoring platform designed for resilient telemetry ingestion, automated rule evaluation, deduplicated incident management, and live operational visibility under adverse network and system conditions.

## Fixed Architectural Decisions
- **Language & Runtime**: Node.js 20 + TypeScript (Strict), npm workspaces monorepo.
- **Backend API**: Fastify (HTTP validation with Zod, structured logging with Pino).
- **Database & Queue**: PostgreSQL 16 only (no Kafka or Redis required for core loop). PostgreSQL functions as the durable queue (`FOR UPDATE SKIP LOCKED` + leases), the transactional outbox for notifications, and the pub/sub backbone (`LISTEN / NOTIFY`).
- **Device Protocol**: HTTP `POST /v1/events` (batching up to 500 events) with per-event status acks (`accepted`, `duplicate`, `rejected`).
- **Dashboard Realtime**: Server-Sent Events (SSE `GET /api/stream`) + REST catch-up via `Last-Event-ID`.
- **Frontend**: React + Vite + TypeScript + TanStack Query with optimistic updates and offline state preservation.
- **Containerization**: Multi-container Docker Compose (postgres, api, worker, web, webhook-sink).

## Monorepo Layout
```
apps/
  api/          - Fastify HTTP service (ingestion, operator REST API, SSE broker)
  worker/       - Event queue consumer, silence detector scheduler, notification outbox dispatcher
  web/          - React + Vite live operations console
  simulator/    - Fleet device simulator CLI with durable disk buffer and chaos scenarios
  webhook-sink/ - Mock external webhook receiver with outage simulation and idempotency dedupe
packages/
  db/           - PostgreSQL connection pool, migration runner, transaction helpers
  shared/       - Zod schemas, constants, typed configurations, logger factory
docs/           - Architecture diagrams, ADRs, protocols, reliability matrix, viva notes
scripts/        - Database seed, consistency reconciliation audit, chaos test scripts
```

## How to Run
```bash
# 1. Start Postgres and Webhook Sink
docker compose up -d postgres webhook-sink

# 2. Reset and migrate DB
npm run db:reset && npm run db:migrate

# 3. Seed demo locations, devices, operators, and rules
npm run seed

# 4. Start services locally
npm run dev:api       # Port 3000
npm run dev:worker    # Background worker
npm run dev:web       # Port 5173

# 5. Run device simulator
npm run scenario:normal
```
