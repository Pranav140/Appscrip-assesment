import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sseBroker, type SSEMessage } from '../sse/broker.js';
import { getPool } from '@rtops/db';
import { DEFAULTS } from '@rtops/shared';

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/stream
   * Server-Sent Events endpoint for real-time dashboard updates.
   *
   * Auth: operator token via ?token= (EventSource cannot set headers).
   * Resume: client sends Last-Event-ID header; we replay missed activity items.
   * Resync: sent when the gap is too large (>= SSE_CATCHUP_LIMIT items).
   */
  app.get('/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    const clientId = randomUUID();
    const lastEventId = (req.headers['last-event-id'] as string | undefined) ?? '0';

    // Set SSE headers
    void reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    const write = (msg: SSEMessage): void => {
      if (reply.raw.destroyed) return;
      const id = msg.id ?? '';
      const data = JSON.stringify(msg.data);
      reply.raw.write(`event: ${msg.kind}\n`);
      if (id) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`data: ${data}\n\n`);
    };

    // Register client with the broker
    sseBroker.addClient(clientId, lastEventId, write);
    req.log.info({ clientId, lastEventId }, 'SSE client connected');

    // ── Replay missed activity since Last-Event-ID ──────────
    try {
      const pool = getPool();
      const sinceId = parseInt(lastEventId, 10) || 0;

      const { rows: missed } = await pool.query<{
        id: string;
        kind: string;
        entity_type: string;
        entity_id: string;
        data: unknown;
      }>(
        `SELECT id::text, kind, entity_type, entity_id, data
         FROM activity_log
         WHERE id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [sinceId, DEFAULTS.SSE_CATCHUP_LIMIT + 1]
      );

      if (missed.length > DEFAULTS.SSE_CATCHUP_LIMIT) {
        // Gap too large — tell client to refetch snapshots
        write({ kind: 'resync', data: { reason: 'gap_too_large', since: lastEventId } });
      } else {
        for (const row of missed) {
          write({
            kind: 'activity',
            id: row.id,
            data: { kind: row.kind, entity_type: row.entity_type, entity_id: row.entity_id, ...((row.data as object) ?? {}) },
          });
        }
      }
    } catch (err) {
      req.log.error({ err }, 'Failed to replay missed SSE events');
    }

    // ── Ping heartbeat (keeps proxies alive) ───────────────────
    const pingInterval = setInterval(() => {
      if (reply.raw.destroyed) {
        clearInterval(pingInterval);
        return;
      }
      reply.raw.write(`: ping\n\n`);
    }, DEFAULTS.SSE_PING_INTERVAL_MS);

    // ── Stats push every 5 seconds ─────────────────────────────
    const statsInterval = setInterval(async () => {
      if (reply.raw.destroyed) {
        clearInterval(statsInterval);
        return;
      }
      try {
        const pool = getPool();
        const { rows } = await pool.query<{ pending: string; processing: string }>(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
            COUNT(*) FILTER (WHERE status = 'processing') AS processing
          FROM events
          WHERE status IN ('pending','processing')
        `);
        write({
          kind: 'stats',
          data: {
            queue_pending: parseInt(rows[0]?.pending ?? '0', 10),
            queue_processing: parseInt(rows[0]?.processing ?? '0', 10),
            ts: new Date().toISOString(),
          },
        });
      } catch { /* non-fatal */ }
    }, DEFAULTS.SSE_STATS_INTERVAL_MS);

    // ── Cleanup on client disconnect ───────────────────────────
    req.raw.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(statsInterval);
      sseBroker.removeClient(clientId);
      req.log.info({ clientId }, 'SSE client disconnected');
    });

    // Keep connection open — do not return
    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
      req.raw.on('error', resolve);
    });
  });
}
