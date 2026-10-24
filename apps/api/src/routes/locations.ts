import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function locationsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/locations — list all locations with device counts */
  app.get('/locations', async (_req, reply) => {
    const { rows } = await pool.query(`
      SELECT
        l.id,
        l.name,
        COUNT(d.id)::int AS device_count,
        COUNT(d.id) FILTER (WHERE d.status = 'online')::int AS online_count,
        COUNT(d.id) FILTER (WHERE d.status = 'stale')::int AS stale_count,
        COUNT(d.id) FILTER (WHERE d.status = 'offline')::int AS offline_count
      FROM locations l
      LEFT JOIN devices d ON d.location_id = l.id
      GROUP BY l.id, l.name
      ORDER BY l.name ASC
    `);

    return reply.send({ locations: rows });
  });

  /** POST /api/locations — create a location */
  app.post<{ Body: { name: string } }>('/locations', async (req, reply) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Name is required' } });
    }

    const { rows } = await pool.query(
      'INSERT INTO locations (name) VALUES ($1) RETURNING id, name',
      [name.trim()]
    );

    return reply.status(201).send({ location: rows[0] });
  });
}
