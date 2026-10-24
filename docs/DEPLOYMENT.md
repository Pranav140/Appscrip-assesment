# Production Deployment & Scaling Architecture

This guide describes how to take this platform from a local evaluation environment to a fault-tolerant cloud deployment serving millions of events per day.

## Cloud Infrastructure Layout (AWS / GCP / Azure)

```
 [ Devices ]
     │ (mTLS / API Gateway)
     ▼
 [ AWS Network Load Balancer ]
     │
 ┌───┴───────────────────────────┐
 │                               │
 ▼                               ▼
[ API Service (ECS Fargate/EKS) ] [ MQTT Gateway (EMQX / AWS IoT Core) ]
 │                               │
 └──────────────┬────────────────┘
                ▼
      [ Ingestion Layer ]
        - Redis Streams / Kafka (for >10k ev/s)
        - OR Managed PostgreSQL (Aurora Multi-AZ)
                ▲
                │
 [ Worker Service (Auto-Scaled on Queue Depth) ]
                │
                ▼
 [ Aurora PostgreSQL Primary ] ──Replication──> [ Read Replica (Analytics) ]
```

## Scaling Bottlenecks & Migration Milestones

| Fleet Size | Ingest Rate | Recommended Architecture |
|---|---|---|
| **< 5,000 devices** | < 1,000 ev/s | Current architecture: Single Fastify API + Worker + PostgreSQL Aurora (t4g.large). |
| **5,000 - 50,000 devices** | 1,000 - 10,000 ev/s | Split API into Ingestion nodes & Dashboard nodes. Use PgBouncer for connection pooling. Partition `events` by week. |
| **> 50,000 devices** | > 10,000 ev/s | Introduce MQTT Broker (EMQX) at edge; bridge to Apache Kafka. Workers consume Kafka partitions with consumer groups. |

## Observability & 5 Core Production Alert Rules

1. **High Ingestion Queue Lag**:
   - `worker_processing_lag_seconds{quantile="0.95"} > 30` for 3 minutes.
   - *Action*: Auto-scale worker tasks (HPA) or alert on-call engineer.
2. **Dead-Letter Event Spike**:
   - `rate(worker_events_failed_total[5m]) > 0`.
   - *Action*: Investigate malformed schema changes or database constraint anomalies.
3. **Oldest Pending Notification Age**:
   - `worker_outbox_oldest_age_seconds > 300` for 5 minutes.
   - *Action*: Check downstream webhook receiver health and circuit breaker status.
4. **API Ingestion Error Rate**:
   - `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.01`.
   - *Action*: Verify PostgreSQL connection pool saturation or disk IOPS exhaustion.
5. **Scheduler Leader Heartbeat Missed**:
   - `time() - worker_scheduler_last_heartbeat_timestamp > 30`.
   - *Action*: Indicates all worker processes lost database connectivity or crashed.
