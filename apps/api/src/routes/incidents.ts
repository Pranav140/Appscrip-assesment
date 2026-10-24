import type { FastifyInstance } from 'fastify';
import { getPool, pgNotify } from '@rtops/db';
import { PG_CHANNELS } from '@rtops/shared';

export async function incidentsRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/incidents?state=&severity=&device_id=&limit=&cursor= */
  app.get<{
    Querystring: { state?: string; severity?: string; device_id?: string; limit?: string; cursor?: string };
  }>('/incidents', async (req, reply) => {
    const { state, severity, device_id, limit, cursor } = req.query;
    const lim = Math.min(parseInt(limit ?? '50', 10), 200);
    const params: unknown[] = [parseInt(cursor ?? '0', 10)];
    const conditions = ['i.id > $1'];
    let p = 2;

    if (state)     { conditions.push(`i.state = $${p++}::incident_state_enum`); params.push(state); }
    if (severity)  { conditions.push(`i.severity = $${p++}::severity_enum`);    params.push(severity); }
    if (device_id) { conditions.push(`i.device_id = $${p++}`);                  params.push(device_id); }

    params.push(lim);
    const { rows } = await pool.query(
      `SELECT i.*, r.name AS rule_name, d.name AS device_name
       FROM incidents i
       JOIN rules r   ON r.id = i.rule_id
       JOIN devices d ON d.id = i.device_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.id DESC LIMIT $${p}`,
      params
    );
    return reply.send({ incidents: rows, next_cursor: rows.at(-1)?.id ?? cursor });
  });

  /** GET /api/incidents/:id — full detail */
  app.get<{ Params: { id: string } }>('/incidents/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);

    const { rows: [incident] } = await pool.query(
      `SELECT i.*, r.name AS rule_name, r.type AS rule_type, r.config AS rule_config
       FROM incidents i JOIN rules r ON r.id = i.rule_id WHERE i.id = $1`, [id]
    );
    if (!incident) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });

    const [{ rows: attachedEvents }, { rows: evaluations }, { rows: notifications }] = await Promise.all([
      pool.query(
        `SELECT e.ingest_seq, e.event_id, e.type, e.event_ts, e.received_at, e.payload
         FROM incident_events ie JOIN events e ON e.ingest_seq = ie.event_ingest_seq
         WHERE ie.incident_id = $1 ORDER BY ie.attached_at ASC LIMIT 100`, [id]
      ),
      pool.query(
        `SELECT re.outcome, re.reason, re.matched, re.evaluated_at, r.name AS rule_name
         FROM rule_evaluations re JOIN rules r ON r.id = re.rule_id
         WHERE re.incident_id = $1 ORDER BY re.evaluated_at ASC LIMIT 50`, [id]
      ),
      pool.query(
        `SELECT n.id, n.operator_id, o.name AS operator_name, n.channel,
                n.status, n.attempts, n.next_attempt_at, n.last_error, n.sent_at
         FROM notifications n JOIN operators o ON o.id = n.operator_id
         WHERE n.incident_id = $1 ORDER BY n.created_at`, [id]
      ),
    ]);

    return reply.send({ incident, attached_events: attachedEvents, evaluations, notifications });
  });

  /** POST /api/incidents/:id/acknowledge */
  app.post<{ Params: { id: string }; Body: { by: string; note?: string } }>(
    '/incidents/:id/acknowledge',
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      const { by, note } = req.body ?? {};
      if (!by) return reply.status(400).send({ error: { code: 'MISSING_ACTOR', message: '"by" field required' } });

      const { rows: [inc] } = await pool.query(
        `UPDATE incidents SET
           state = 'acknowledged',
           acknowledged_at = now(),
           acknowledged_by = $2
         WHERE id = $1 AND state = 'open'
         RETURNING *`, [id, by]
      );

      if (!inc) {
        // Check if it exists with wrong state
        const { rows: [exists] } = await pool.query(`SELECT state FROM incidents WHERE id = $1`, [id]);
        if (!exists) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });
        return reply.status(409).send({
          error: { code: 'INVALID_TRANSITION', message: `Cannot acknowledge incident in state: ${exists.state}` }
        });
      }

      await pool.query(
        `INSERT INTO activity_log (kind, entity_type, entity_id, data)
         VALUES ('incident_acknowledged','incident',$1,$2)`,
        [String(id), JSON.stringify({ by, note, incident_id: id })]
      );
      await pgNotify(PG_CHANNELS.INCIDENT_CHANGED, { incident_id: id, state: 'acknowledged' });
      return reply.send({ incident: inc });
    }
  );

  /** POST /api/incidents/:id/resolve */
  app.post<{ Params: { id: string }; Body: { by: string; note?: string } }>(
    '/incidents/:id/resolve',
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      const { by, note } = req.body ?? {};
      if (!by) return reply.status(400).send({ error: { code: 'MISSING_ACTOR', message: '"by" field required' } });

      const { rows: [inc] } = await pool.query(
        `UPDATE incidents SET
           state = 'resolved',
           resolved_at = now(),
           resolved_by = $2,
           resolution_reason = $3
         WHERE id = $1 AND state IN ('open','acknowledged')
         RETURNING *`, [id, by, note ?? null]
      );

      if (!inc) {
        const { rows: [exists] } = await pool.query(`SELECT state FROM incidents WHERE id = $1`, [id]);
        if (!exists) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });
        return reply.status(409).send({
          error: { code: 'INVALID_TRANSITION', message: `Cannot resolve incident in state: ${exists.state}` }
        });
      }

      await pool.query(
        `INSERT INTO activity_log (kind, entity_type, entity_id, data)
         VALUES ('incident_resolved','incident',$1,$2)`,
        [String(id), JSON.stringify({ by, note, incident_id: id })]
      );
      await pgNotify(PG_CHANNELS.INCIDENT_CHANGED, { incident_id: id, state: 'resolved' });
      return reply.send({ incident: inc });
    }
  );
}
