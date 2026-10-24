import client from 'prom-client';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'worker_' });

export const eventsProcessedTotal = new client.Counter({
  name: 'worker_events_processed_total',
  help: 'Total events processed by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

export const processingDurationSeconds = new client.Histogram({
  name: 'worker_processing_duration_seconds',
  help: 'Time to process a single event in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const processingLagSeconds = new client.Histogram({
  name: 'worker_processing_lag_seconds',
  help: 'Lag from event received_at to worker processing completion',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const leaseReclaimsTotal = new client.Counter({
  name: 'worker_lease_reclaims_total',
  help: 'Number of expired event leases reclaimed by this worker',
  registers: [register],
});

export const eventsFailedTotal = new client.Counter({
  name: 'worker_events_failed_total',
  help: 'Number of events marked dead-letter failed',
  registers: [register],
});

export const notificationsSentTotal = new client.Counter({
  name: 'worker_notifications_sent_total',
  help: 'Notifications sent successfully',
  labelNames: ['channel'],
  registers: [register],
});

export const notificationsFailedTotal = new client.Counter({
  name: 'worker_notifications_failed_total',
  help: 'Notifications delivery attempts that failed',
  labelNames: ['channel'],
  registers: [register],
});

export const outboxDepthGauge = new client.Gauge({
  name: 'worker_outbox_depth',
  help: 'Current pending/failed notifications in outbox',
  registers: [register],
});

export const circuitBreakerStateGauge = new client.Gauge({
  name: 'worker_circuit_breaker_state',
  help: 'State of notification circuit breaker (0=closed, 1=open, 2=half-open)',
  labelNames: ['destination'],
  registers: [register],
});
