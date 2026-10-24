import type { FastifyInstance } from 'fastify';
import { register } from '../metrics.js';

/** GET /metrics — Prometheus scrape endpoint */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    const metrics = await register.metrics();
    return reply
      .status(200)
      .header('Content-Type', register.contentType)
      .send(metrics);
  });
}
