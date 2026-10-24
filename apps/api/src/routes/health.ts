import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';
import { getEnv } from '@rtops/shared';
import { getQueueDepth } from '../services/queue.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  /** GET /healthz — liveness probe: process is running */
  app.get('/healthz', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok', service: 'api', ts: new Date().toISOString() });
  });

  /** GET /readyz — readiness probe: DB reachable, queue depth sane */
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let allOk = true;

    // 1. DB connectivity
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      checks['db'] = 'ok';
    } catch (err) {
      checks['db'] = `fail: ${(err as Error).message}`;
      allOk = false;
    }

    // 2. Queue depth below hard limit
    try {
      const depth = await getQueueDepth();
      if (depth >= env.HARD_WATERMARK) {
        checks['queue'] = `fail: depth ${depth} >= hard limit ${env.HARD_WATERMARK}`;
        allOk = false;
      } else {
        checks['queue'] = `ok (depth=${depth})`;
      }
    } catch (err) {
      checks['queue'] = `fail: ${(err as Error).message}`;
      allOk = false;
    }

    // 3. Worker heartbeat freshness
    try {
      const pool = getPool();
      const result = await pool.query<{ last_beat_at: Date }>(
        `SELECT last_beat_at FROM worker_heartbeat ORDER BY last_beat_at DESC LIMIT 1`
      );
      const beat = result.rows[0];
      if (!beat) {
        checks['worker'] = 'warn: no heartbeat yet';
      } else {
        const ageMs = Date.now() - beat.last_beat_at.getTime();
        const ageS = Math.round(ageMs / 1000);
        checks['worker'] = ageS > 30 ? `warn: stale (${ageS}s ago)` : `ok (${ageS}s ago)`;
      }
    } catch {
      checks['worker'] = 'warn: could not check heartbeat';
    }

    const statusCode = allOk ? 200 : 503;
    return reply.status(statusCode).send({
      status: allOk ? 'ready' : 'not_ready',
      checks,
      ts: new Date().toISOString(),
    });
  });
}
