import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/activity?after_id=&limit=&entity_type= */
  app.get<{
    Querystring: {
      after_id?: string;
      limit?: string;
      entity_type?: string;
    };
  }>('/activity', async (req, reply) => {
    const afterId = req.query.after_id ? parseInt(req.query.after_id, 10) : 0;
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10), 1), 200);
    const entityType = req.query.entity_type;

    let query = `
      SELECT id, kind, entity_type, entity_id, data, created_at
      FROM activity_log
      WHERE id > $1
    `;
    const params: (number | string)[] = [afterId];

    if (entityType) {
      params.push(entityType);
      query += ` AND entity_type = $${params.length}`;
    }

    query += ` ORDER BY id ASC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);
    const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : null;

    return reply.send({
      activity: rows,
      next_cursor: nextCursor,
      has_more: rows.length === limit,
    });
  });
}
