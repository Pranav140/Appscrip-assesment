import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/notifications?status= */
  app.get<{ Querystring: { status?: string } }>('/notifications', async (req, reply) => {
    const { status } = req.query;
    const params: unknown[] = [];
    const where = status
      ? `WHERE n.status = $1::notification_status_enum` + (params.push(status) ? '' : '')
      : '';
    const { rows } = await pool.query(
      `SELECT n.*, o.name AS operator_name, i.title AS incident_title
       FROM notifications n
       JOIN operators o ON o.id = n.operator_id
       JOIN incidents i ON i.id = n.incident_id
       ${where}
       ORDER BY n.created_at DESC LIMIT 200`,
      params
    );
    return reply.send({ notifications: rows });
  });

  /** POST /api/notifications/:id/retry — manually re-send a dead/failed notification */
  app.post<{ Params: { id: string } }>('/notifications/:id/retry', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query(
      `UPDATE notifications
       SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
       WHERE id = $1 AND status IN ('dead', 'failed')`,
      [id]
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Notification not found or not retryable' } });
    }
    return reply.send({ ok: true });
  });
}
