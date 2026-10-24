import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function operatorsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/operators — list all operators */
  app.get('/operators', async (_req, reply) => {
    const { rows } = await pool.query(`
      SELECT id, name, email, webhook_url, active, created_at
      FROM operators
      ORDER BY id ASC
    `);

    return reply.send({ operators: rows });
  });

  /** POST /api/operators — create or register an operator */
  app.post<{
    Body: {
      name: string;
      email: string;
      webhook_url?: string;
    };
  }>('/operators', async (req, reply) => {
    const { name, email, webhook_url } = req.body;
    if (!name || !email) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Name and email are required' },
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO operators (name, email, webhook_url)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, webhook_url, active, created_at`,
      [name.trim(), email.trim().toLowerCase(), webhook_url ?? null]
    );

    return reply.status(201).send({ operator: rows[0] });
  });
}
