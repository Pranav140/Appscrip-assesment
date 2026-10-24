import Fastify from 'fastify';
import { getEnv, createLogger } from '@rtops/shared';
import { getPool } from '@rtops/db';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { devicesRoutes } from './routes/devices.js';
import { eventsRoutes } from './routes/events.js';
import { rulesRoutes } from './routes/rules.js';
import { incidentsRoutes } from './routes/incidents.js';
import { notificationsRoutes } from './routes/notifications.js';
import { streamRoutes } from './routes/stream.js';
import { statsRoutes } from './routes/stats.js';
import { activityRoutes } from './routes/activity.js';
import { locationsRoutes } from './routes/locations.js';
import { operatorsRoutes } from './routes/operators.js';
import { metricsRoutes } from './routes/metrics.js';
import { operatorAuthHook } from './hooks/auth.js';
import { sseBroker } from './sse/broker.js';
import { setupListenConnection } from './sse/listener.js';
import { initMetrics, queueDepthGauge, sseCLientsGauge } from './metrics.js';
import { getQueueDepth } from './services/queue.js';

export async function buildApp() {
  const env = getEnv();
  const logger = createLogger({ service: 'api' });

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      base: { service: 'api' },
    },
    bodyLimit: 1_048_576, // 1MB max body
    trustProxy: true,
  });

  // Initialize prometheus metrics
  initMetrics();

  // ── CORS ──────────────────────────────────────────────────
  await app.register(import('@fastify/cors'), {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Device-Key', 'X-Operator-Id'],
  });

  // ── Correlation ID ─────────────────────────────────────────
  app.addHook('onRequest', async (req, reply) => {
    const reqId =
      (req.headers['x-request-id'] as string) ??
      `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    req.headers['x-request-id'] = reqId;
    void reply.header('X-Request-Id', reqId);
  });

  // ── Error handler ──────────────────────────────────────────
  app.setErrorHandler(async (error, req, reply) => {
    const statusCode = error.statusCode ?? 500;
    req.log.error({ err: error, statusCode }, 'Request error');
    return reply.status(statusCode).send({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: statusCode < 500 ? error.message : 'Internal server error',
        ...(env.NODE_ENV === 'development' && statusCode >= 500
          ? { details: error.stack }
          : {}),
      },
    });
  });

  // ── Queue depth gauge updater ──────────────────────────────
  setInterval(() => {
    void getQueueDepth().then((depth) => {
      queueDepthGauge.set(depth);
    });
  }, 5000);

  // ── Routes ────────────────────────────────────────────────
  // Public (no auth): device ingest + health
  await app.register(healthRoutes);
  await app.register(ingestRoutes, { prefix: '/v1' });

  // Metrics endpoint (Prometheus scrape - no auth by convention, can be gated)
  await app.register(metricsRoutes);

  // Operator API (auth required)
  await app.register(async (instance) => {
    instance.addHook('onRequest', operatorAuthHook);
    await instance.register(devicesRoutes, { prefix: '/api' });
    await instance.register(eventsRoutes, { prefix: '/api' });
    await instance.register(rulesRoutes, { prefix: '/api' });
    await instance.register(incidentsRoutes, { prefix: '/api' });
    await instance.register(notificationsRoutes, { prefix: '/api' });
    await instance.register(statsRoutes, { prefix: '/api' });
    await instance.register(activityRoutes, { prefix: '/api' });
    await instance.register(locationsRoutes, { prefix: '/api' });
    await instance.register(operatorsRoutes, { prefix: '/api' });
    await instance.register(streamRoutes, { prefix: '/api' });
  });

  // ── SSE broker + LISTEN connection ────────────────────────
  await setupListenConnection(sseBroker);

  app.log.info('API app built');
  return app;
}
