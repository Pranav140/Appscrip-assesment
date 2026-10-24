import type { FastifyInstance } from 'fastify';
import { getPool } from '@rtops/db';

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/events?device_id=&type=&after_seq=&limit= */
  app.get<{
    Querystring: { device_id?: string; type?: string; after_seq?: string; limit?: string };
  }>('/events', async (req, reply) => {
    const { device_id, type, after_seq, limit } = req.query;
    const lim = Math.min(parseInt(limit ?? '100', 10), 500);
    const afterSeq = parseInt(after_seq ?? '0', 10);

    const conditions = [`ingest_seq > $1`];
    const params: unknown[] = [afterSeq];
    let p = 2;

    if (device_id) { conditions.push(`device_id = $${p++}`); params.push(device_id); }
    if (type)      { conditions.push(`type = $${p++}`);       params.push(type); }

    params.push(lim);
    const { rows } = await pool.query(
      `SELECT ingest_seq, device_id, event_id, type, event_ts, received_at,
              payload, schema_version, is_replay, status, attempts, last_error, processed_at
       FROM events WHERE ${conditions.join(' AND ')}
       ORDER BY ingest_seq ASC LIMIT $${p}`,
      params
    );
    return reply.send({ events: rows, next_seq: rows.at(-1)?.ingest_seq ?? afterSeq });
  });

  /** GET /api/events/failed */
  app.get('/events/failed', async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT ingest_seq, device_id, event_id, type, event_ts, received_at,
              attempts, last_error, processed_at
       FROM events WHERE status = 'failed'
       ORDER BY ingest_seq DESC LIMIT 200`
    );
    return reply.send({ events: rows });
  });

  /** POST /api/events/:seq/retry — re-queue a failed event */
  app.post<{ Params: { seq: string } }>('/events/:seq/retry', async (req, reply) => {
    const seq = parseInt(req.params.seq, 10);
    const { rowCount } = await pool.query(
      `UPDATE events SET status='pending', attempts=0, locked_until=NULL, last_error=NULL
       WHERE ingest_seq = $1 AND status = 'failed'`,
      [seq]
    );
    if (rowCount === 0) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found or not in failed state' } });
    }
    return reply.send({ ok: true, ingest_seq: seq });
  });

  /** GET /api/events/:seq/evaluations — why was/wasn't an incident created? */
  app.get<{ Params: { seq: string } }>('/events/:seq/evaluations', async (req, reply) => {
    const seq = parseInt(req.params.seq, 10);
    const { rows } = await pool.query(
      `SELECT re.*, r.name AS rule_name
       FROM rule_evaluations re
       JOIN rules r ON r.id = re.rule_id
       WHERE re.event_ingest_seq = $1
       ORDER BY re.evaluated_at ASC`,
      [seq]
    );
    return reply.send({ evaluations: rows });
  });

  /** GET /api/rejected-events */
  app.get('/rejected-events', async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, device_id, raw, reason, received_at
       FROM rejected_events ORDER BY received_at DESC LIMIT 200`
    );
    return reply.send({ rejected_events: rows });
  });

  /** GET /api/debug/incidents-why?device_id=&rule_id=&since= */
  app.get<{ Querystring: { device_id?: string; rule_id?: string; since?: string } }>(
    '/debug/incidents-why',
    async (req, reply) => {
      const { device_id, rule_id, since } = req.query;
      const conditions = ['1=1'];
      const params: unknown[] = [];
      let p = 1;
      if (device_id) { conditions.push(`re.device_id = $${p++}`); params.push(device_id); }
      if (rule_id)   { conditions.push(`re.rule_id = $${p++}`);   params.push(parseInt(rule_id, 10)); }
      if (since)     { conditions.push(`re.evaluated_at >= $${p++}`); params.push(since); }
      params.push(200);
      const { rows } = await pool.query(
        `SELECT re.id, re.event_ingest_seq, re.device_id, re.rule_id,
                r.name AS rule_name, re.evaluated_at, re.matched,
                re.outcome, re.reason, re.incident_id
         FROM rule_evaluations re JOIN rules r ON r.id = re.rule_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY re.evaluated_at DESC LIMIT $${p}`,
        params
      );
      return reply.send({ evaluations: rows });
    }
  );
}
