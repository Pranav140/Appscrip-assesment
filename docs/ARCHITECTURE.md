# System Architecture & Technical Specification

## High-Level Topology

```mermaid
graph TD
    subgraph Fleet [Field Device Fleet]
        D1[Device 01 - Local Buffer]
        D2[Device 02 - Local Buffer]
        D3[Device N - Local Buffer]
    end

    subgraph API [Fastify API Cluster]
        ING[Ingest Route: /v1/events]
        REST[Operator REST API: /api/*]
        SSE[SSE Fanout Broker: /api/stream]
    end

    subgraph DB [PostgreSQL 16 Engine]
        EVT[(events - Durable Work Queue)]
        DEV[(devices)]
        INC[(incidents)]
        OUT[(notifications - Outbox)]
        ACT[(activity_log)]
        NOTIFY[Postgres LISTEN / NOTIFY]
    end

    subgraph Worker [Autonomous Background Worker]
        PROC[Event Processor Loop - SKIP LOCKED]
        SIL[Silence Detector Scheduler - Advisory Lock]
        NOTIF[Notification Outbox Dispatcher]
    end

    subgraph External [External Webhook Sink & Operator UI]
        SINK[Webhook Sink]
        WEB[React + Vite Operations Dashboard]
    end

    D1 -->|POST /v1/events batch| ING
    D2 -->|POST /v1/events batch| ING
    D3 -->|POST /v1/events batch| ING

    ING -->|INSERT ON CONFLICT DO NOTHING| EVT
    ING -->|GREATEST update| DEV

    EVT -->|FOR UPDATE SKIP LOCKED lease| PROC
    PROC -->|Single ACID Transaction| INC
    PROC -->|Single ACID Transaction| OUT
    PROC -->|Single ACID Transaction| ACT
    PROC -->|pg_notify| NOTIFY

    NOTIFY -->|Dedicated LISTEN| SSE
    SSE -->|Server-Sent Events| WEB
    REST <-->|TanStack Query REST| WEB

    SIL -->|Tick with advisory lock| DEV
    SIL -->|Silence alerts| INC

    OUT -->|Claim with SKIP LOCKED| NOTIF
    NOTIF -->|Idempotency-Key HTTP POST| SINK
```

## Core Sequence Workflows

### 1. Ingest → Event Processor → Incident → SSE Stream
```mermaid
sequenceDiagram
    autonumber
    actor Device as Field Device
    participant API as Fastify Ingest
    participant DB as PostgreSQL
    participant Worker as Event Processor
    participant SSE as SSE Broker
    actor Operator as Operator Dashboard

    Device->>API: POST /v1/events (batch of N events)
    API->>DB: INSERT ON CONFLICT (device_id, event_id) DO NOTHING
    API->>DB: UPDATE devices SET last_seen_at = GREATEST(last_seen_at, now())
    API-->>Device: 200 OK { results: [ { event_id, status: "accepted" } ] }
    API->>DB: pg_notify('events_available')

    Worker->>DB: Claim pending batch via FOR UPDATE SKIP LOCKED
    Worker->>Worker: Evaluate rule against telemetry
    Worker->>DB: Upsert incident with dedupe_key (rule_id + device_id)
    Worker->>DB: Insert outbox notification & activity_log
    Worker->>DB: Mark event done
    Worker->>DB: pg_notify('incident_changed')
    DB-->>SSE: Notification delivered to dedicated LISTEN connection
    SSE-->>Operator: Push live incident update via SSE
```

### 2. Device Offline → Reconnect Replay
```mermaid
sequenceDiagram
    autonumber
    actor Device as Field Device
    participant DB as PostgreSQL
    participant Silence as Silence Detector
    participant API as Ingestion API

    Note over Device: Network connection dropped
    loop While Offline
        Device->>Device: Append telemetry to local disk buffer (.jsonl)
    end
    Silence->>DB: Tick: Check last_seen_at age > 60s
    Silence->>DB: Open silence incident for device

    Note over Device: Network restored
    Device->>API: Flush buffered backlog in chunks
    API->>DB: Ingest backlog, last_seen_at jumps to now()
    API-->>Device: Acknowledge batch
    Note over DB: Worker marks device online & auto-resolves silence incident
```

### 3. Worker Crash Recovery
```mermaid
sequenceDiagram
    autonumber
    participant WorkerA as Worker Instance A
    participant DB as PostgreSQL (Queue)
    participant WorkerB as Worker Instance B

    WorkerA->>DB: Claim batch: status='processing', locked_until=now()+30s
    Note over WorkerA: Process crashed / SIGKILL
    Note over DB: 30s elapsed -> lease expired (locked_until < now())
    WorkerB->>DB: Claim batch: WHERE status='processing' AND locked_until < now()
    WorkerB->>WorkerB: Re-process event safely
    WorkerB->>DB: Commit incident upsert & mark done
```
