import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/devices?status=&location_id=&q= */
  app.get<{ Querystring: { status?: string; location_id?: string; q?: string } }>(
    '/devices',
    async (req, reply) => {
      const { status, location_id, q } = req.query;

      const conditions: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      if (status) {
        conditions.push(`d.status = $${p++}::device_status_enum`);
        params.push(status);
      }
      if (location_id) {
        conditions.push(`d.location_id = $${p++}`);
        params.push(parseInt(location_id, 10));
      }
      if (q) {
        conditions.push(`(d.id ILIKE $${p} OR d.name ILIKE $${p})`);
        params.push(`%${q}%`);
        p++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const { rows } = await pool.query(
        `SELECT d.id, d.name, d.status, d.last_seen_at, d.last_event_ts,
                d.metadata, d.created_at,
                l.name AS location_name, d.location_id,
                COUNT(i.id) FILTER (WHERE i.state IN ('open','acknowledged')) AS open_incident_count
         FROM devices d
         LEFT JOIN locations l ON l.id = d.location_id
         LEFT JOIN incidents i ON i.device_id = d.id
         ${where}
         GROUP BY d.id, l.name
         ORDER BY d.last_seen_at DESC NULLS LAST
         LIMIT 500`,
        params
      );

      return reply.send({ devices: rows });
    }
  );

  /** GET /api/devices/:id */
  app.get<{ Params: { id: string } }>('/devices/:id', async (req, reply) => {
    const { id } = req.params;

    const { rows: [device] } = await pool.query(
      `SELECT d.*, l.name AS location_name
       FROM devices d LEFT JOIN locations l ON l.id = d.location_id
       WHERE d.id = $1`,
      [id]
    );

    if (!device) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    }

    const { rows: recentEvents } = await pool.query(
      `SELECT ingest_seq, event_id, type, event_ts, received_at, payload, status, is_replay
       FROM events WHERE device_id = $1 ORDER BY ingest_seq DESC LIMIT 20`,
      [id]
    );

    const { rows: openIncidents } = await pool.query(
      `SELECT id, title, state, severity, opened_at, occurrence_count
       FROM incidents WHERE device_id = $1 AND state IN ('open','acknowledged')
       ORDER BY opened_at DESC`,
      [id]
    );

    return reply.send({ device, recent_events: recentEvents, open_incidents: openIncidents });
  });
}
