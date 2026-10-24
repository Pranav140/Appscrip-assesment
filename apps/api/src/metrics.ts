import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

export const register = new Registry();

collectDefaultMetrics({ register });

// ── Ingest metrics ──────────────────────────────────────────
export const eventsReceivedTotal = new Counter({
  name: 'events_received_total',
  help: 'Total events received, labelled by result',
  labelNames: ['result'] as const, // accepted | duplicate | rejected
  registers: [register],
});

export const ingestBatchSize = new Histogram({
  name: 'ingest_batch_size',
  help: 'Number of events per ingest batch',
  buckets: [1, 5, 10, 25, 50, 100, 200, 500],
  registers: [register],
});

export const ingestDurationSeconds = new Histogram({
  name: 'ingest_duration_seconds',
  help: 'Duration of ingest request handling',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const ingestRejectedTotal = new Counter({
  name: 'ingest_rejected_total',
  help: 'Ingest rejections by reason',
  labelNames: ['reason'] as const,
  registers: [register],
});

export const queueDepthGauge = new Gauge({
  name: 'queue_depth',
  help: 'Current number of pending events in the queue',
  registers: [register],
});

export const rateLimitedTotal = new Counter({
  name: 'rate_limited_total',
  help: 'Number of requests rate-limited per device',
  labelNames: ['device_id'] as const,
  registers: [register],
});

// ── SSE metrics ────────────────────────────────────────────
export const sseCLientsGauge = new Gauge({
  name: 'sse_clients',
  help: 'Number of connected SSE clients',
  registers: [register],
});

export const sseMessagesSentTotal = new Counter({
  name: 'sse_messages_sent_total',
  help: 'Total SSE messages sent to clients',
  labelNames: ['kind'] as const,
  registers: [register],
});

// ── Processing metrics (updated by worker via DB gauge) ────
export const processingLagSeconds = new Gauge({
  name: 'processing_lag_seconds',
  help: 'Seconds between event received_at and now (for oldest pending)',
  registers: [register],
});

export function initMetrics(): void {
  // No-op — metrics are initialized on module import
}
