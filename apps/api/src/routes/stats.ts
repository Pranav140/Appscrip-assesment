import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/stats — aggregated platform statistics */
  app.get('/stats', async (_req, reply) => {
    const [
      deviceStats,
      incidentStats,
      eventStats,
      notificationStats,
      queueStats,
      eventsPerMin,
    ] = await Promise.all([
      // Device counts by status
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) AS count FROM devices GROUP BY status`
      ),
      // Incident counts by state+severity
      pool.query<{ state: string; severity: string; count: string }>(
        `SELECT state, severity, COUNT(*) AS count FROM incidents GROUP BY state, severity`
      ),
      // Event counts (last hour)
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) AS count FROM events
         WHERE received_at > now() - interval '1 hour' GROUP BY status`
      ),
      // Notification counts by status
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) AS count FROM notifications GROUP BY status`
      ),
      // Queue depth + processing lag
      pool.query<{ pending: string; processing: string; lag_p50: string; lag_p95: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status='pending')    AS pending,
           COUNT(*) FILTER (WHERE status='processing') AS processing,
           PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now()-received_at)))
             FILTER (WHERE status='pending') AS lag_p50,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (now()-received_at)))
             FILTER (WHERE status='pending') AS lag_p95
         FROM events WHERE status IN ('pending','processing')`
      ),
      // Events per minute — 15 one-minute buckets
      pool.query<{ bucket: string; count: string }>(
        `SELECT
           DATE_TRUNC('minute', received_at) AS bucket,
           COUNT(*) AS count
         FROM events
         WHERE received_at > now() - interval '15 minutes'
         GROUP BY bucket ORDER BY bucket`
      ),
    ]);

    const devices = Object.fromEntries(deviceStats.rows.map((r) => [r.status, parseInt(r.count, 10)]));
    const incidents = incidentStats.rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
      if (!acc[r.state]) acc[r.state] = {};
      acc[r.state]![r.severity] = parseInt(r.count, 10);
      return acc;
    }, {});
    const eventsByStatus = Object.fromEntries(eventStats.rows.map((r) => [r.status, parseInt(r.count, 10)]));
    const notifs = Object.fromEntries(notificationStats.rows.map((r) => [r.status, parseInt(r.count, 10)]));
    const q = queueStats.rows[0];

    return reply.send({
      devices,
      incidents,
      events_last_hour: eventsByStatus,
      notifications: notifs,
      queue: {
        pending: parseInt(q?.pending ?? '0', 10),
        processing: parseInt(q?.processing ?? '0', 10),
        lag_p50_seconds: parseFloat(q?.lag_p50 ?? '0'),
        lag_p95_seconds: parseFloat(q?.lag_p95 ?? '0'),
      },
      events_per_minute: eventsPerMin.rows.map((r) => ({
        bucket: r.bucket,
        count: parseInt(r.count, 10),
      })),
      ts: new Date().toISOString(),
    });
  });
}
