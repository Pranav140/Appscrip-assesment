import type { FastifyInstance } from 'fastify';
import { getPool, pgNotify } from '@rtops/db';
import { RuleSchema, PG_CHANNELS, type DeviceEvent } from '@rtops/shared';
import { evaluateRule } from '../services/rules-engine.js';

export async function rulesRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  /** GET /api/rules */
  app.get('/rules', async (_req, reply) => {
    const { rows } = await pool.query(
      `SELECT id, name, enabled, type, scope_type, scope_id, config,
              severity, cooldown_seconds, ignore_replayed, auto_resolve,
              notify_operator_ids, debug, created_at, updated_at
       FROM rules ORDER BY id`
    );
    return reply.send({ rules: rows });
  });

  /** POST /api/rules */
  app.post<{ Body: unknown }>('/rules', async (req, reply) => {
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: 'INVALID_RULE', details: parsed.error.flatten() } });
    }
    const r = parsed.data;
    const { rows: [created] } = await pool.query(
      `INSERT INTO rules (name, enabled, type, scope_type, scope_id, config, severity,
                          cooldown_seconds, ignore_replayed, auto_resolve, notify_operator_ids, debug)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::severity_enum,$8,$9,$10,$11,$12)
       RETURNING *`,
      [r.name, r.enabled, r.type, r.scope_type, r.scope_id ?? null,
       JSON.stringify(r.config), r.severity, r.cooldown_seconds,
       r.ignore_replayed, r.auto_resolve, r.notify_operator_ids ?? null, r.debug]
    );
    await pgNotify(PG_CHANNELS.RULES_CHANGED, { action: 'created', rule_id: created.id });
    return reply.status(201).send({ rule: created });
  });

  /** PATCH /api/rules/:id */
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/rules/:id',
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      const allowed = ['name','enabled','config','severity','cooldown_seconds',
                       'ignore_replayed','auto_resolve','notify_operator_ids','debug','scope_type','scope_id'];
      const sets: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const [k, v] of Object.entries(req.body)) {
        if (!allowed.includes(k)) continue;
        const col = k === 'config' ? `config = $${p++}::jsonb` : `${k} = $${p++}`;
        sets.push(k === 'config' ? col : `${k} = $${p - 1}`);
        params.push(k === 'config' ? JSON.stringify(v) : v);
      }
      if (sets.length === 0) return reply.status(400).send({ error: { code: 'NOTHING_TO_UPDATE' } });
      sets.push(`updated_at = now()`);
      params.push(id);
      const { rows: [updated] } = await pool.query(
        `UPDATE rules SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
        params
      );
      if (!updated) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });
      await pgNotify(PG_CHANNELS.RULES_CHANGED, { action: 'updated', rule_id: id });
      return reply.send({ rule: updated });
    }
  );

  /** DELETE /api/rules/:id */
  app.delete<{ Params: { id: string } }>('/rules/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const { rowCount } = await pool.query('DELETE FROM rules WHERE id = $1', [id]);
    if (rowCount === 0) return reply.status(404).send({ error: { code: 'NOT_FOUND' } });
    await pgNotify(PG_CHANNELS.RULES_CHANGED, { action: 'deleted', rule_id: id });
    return reply.send({ ok: true });
  });

  /** POST /api/rules/dry-run { rule, sample_event } */
  app.post<{ Body: { rule: unknown; sample_event: unknown } }>(
    '/rules/dry-run',
    async (req, reply) => {
      const ruleResult = RuleSchema.safeParse(req.body?.rule);
      if (!ruleResult.success) {
        return reply.status(400).send({ error: { code: 'INVALID_RULE', details: ruleResult.error.flatten() } });
      }
      const { matched, reason } = evaluateRule(ruleResult.data, req.body.sample_event as DeviceEvent);
      return reply.send({ matched, reason, outcome: matched ? 'incident_created' : 'no_match' });
    }
  );
}
