# Platform Limitations & Technical Debt

This document honestly outlines the current limitations of the platform implementation and their real-world trade-offs.

## 1. Static Operator Authentication
- **Current State**: Uses a shared static bearer token (`OPERATOR_TOKEN`) set via environment variables.
- **Trade-off**: Kept simple to prioritize core concurrency and reliability over sprawling user-management code.
- **Production Path**: Replace with OpenID Connect (OIDC) / OAuth2 with JWT validation (e.g., Auth0, Keycloak) and role-based access control (RBAC).

## 2. PostgreSQL Queue Throughput Ceiling
- **Current State**: Queue uses PostgreSQL table with `FOR UPDATE SKIP LOCKED`.
- **Throughput Limit**: Approximately 5,000 to 10,000 writes/sec depending on NVMe disk IOPS and connection pooling.
- **Production Path**: When fleet scales beyond 25,000 high-frequency devices, swap the ingestion queue for Redis Streams or Apache Kafka. The `EventProcessor` abstraction isolates this transition cleanly.

## 3. Single PostgreSQL Instance (SPOF)
- **Current State**: Local Docker Compose runs a single primary PostgreSQL container.
- **Trade-off**: Optimized for immediate local developer setup (`docker compose up`).
- **Production Path**: Deploy managed PostgreSQL (AWS RDS / Aurora) with Multi-AZ automated failover and read replicas for dashboard queries.

## 4. Query Parameter Token for SSE
- **Current State**: `GET /api/stream?token=...` accepts the bearer token in the query string.
- **Reason**: The standard browser `EventSource` API does not support custom request headers.
- **Production Path**: Use ephemeral cookie-based sessions or lightweight WebSocket fallback if tokens in access logs present a compliance risk.

## 5. Event Table Partitioning & Retention
- **Current State**: `events` table is a single unpartitioned table.
- **Production Path**: Partition `events` by range on `received_at` (monthly or weekly partitions) with an automated drop or archive policy to S3 / Parquet for long-term analytics.
