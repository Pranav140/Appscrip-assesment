import type { Pool, PoolClient } from 'pg';
import { getPool, pgNotify } from '@rtops/db';
import { PG_CHANNELS, type StoredEvent, createLogger, DEFAULTS } from '@rtops/shared';
import { RulesCache, processEventRules } from './rules.js';
import {
  eventsProcessedTotal,
  processingDurationSeconds,
  processingLagSeconds,
  leaseReclaimsTotal,
  eventsFailedTotal,
} from './metrics.js';

const logger = createLogger({ service: 'worker:processor' });

export class EventProcessor {
  private pool: Pool;
  private rulesCache: RulesCache;
  private running = false;
  private concurrency: number;
  private batchSize: number;
  private leaseSeconds: number;
  private maxAttempts: number;

  constructor(
    pool: Pool,
    rulesCache: RulesCache,
    options: {
      concurrency?: number;
      batchSize?: number;
      leaseSeconds?: number;
      maxAttempts?: number;
    } = {}
  ) {
    this.pool = pool;
    this.rulesCache = rulesCache;
    this.concurrency = options.concurrency ?? 2;
    this.batchSize = options.batchSize ?? 50;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.MAX_RETRY_ATTEMPTS;
  }

  public async start(): Promise<void> {
    this.running = true;
    logger.info({ concurrency: this.concurrency, batchSize: this.batchSize }, 'Starting event processor loops');

    for (let i = 0; i < this.concurrency; i++) {
      void this.runLoop(i);
    }
  }

  public stop(): void {
    this.running = false;
    logger.info('Stopping event processor');
  }

  private async runLoop(workerIndex: number): Promise<void> {
    while (this.running) {
      try {
        const claimed = await this.claimBatch();
        if (claimed.length === 0) {
          // No work; wait briefly before next poll
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }

        for (const event of claimed) {
          if (!this.running) break;
          await this.processSingleEvent(event);
        }
      } catch (err) {
        logger.error({ err, workerIndex }, 'Error in processor loop iteration');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async claimBatch(): Promise<StoredEvent[]> {
    const query = `
      UPDATE events
      SET status = 'processing',
          locked_until = now() + ($1 || ' seconds')::interval,
          attempts = attempts + 1
      WHERE ingest_seq IN (
        SELECT ingest_seq FROM events
        WHERE (status = 'pending')
           OR (status = 'processing' AND locked_until < now())
        ORDER BY ingest_seq ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;

    const { rows } = await this.pool.query<StoredEvent>(query, [
      this.leaseSeconds,
      this.batchSize,
    ]);

    for (const r of rows) {
      if (r.attempts > 1) {
        leaseReclaimsTotal.inc();
      }
    }

    return rows;
  }

  private async processSingleEvent(event: StoredEvent): Promise<void> {
    const startTime = process.hrtime.bigint();
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Fetch device info (location_id, status)
      const devRes = await client.query<{ location_id: number | null; status: string }>(
        `SELECT location_id, status FROM devices WHERE id = $1 FOR UPDATE`,
        [event.device_id]
      );
      const dev = devRes.rows[0];
      const locationId = dev ? dev.location_id : null;

      // 2. Mark device online if previously stale/offline/unknown
      if (dev && dev.status !== 'online') {
        await client.query(
          `UPDATE devices SET status = 'online' WHERE id = $1`,
          [event.device_id]
        );
        await pgNotify(client, PG_CHANNELS.DEVICE_STATUS_CHANGED, {
          device_id: event.device_id,
          status: 'online',
          prev_status: dev.status,
        });
      }

      // 3. Auto-resolve any open silence incidents for this device
      const silenceIncidents = await client.query<{ id: string; rule_id: number }>(
        `SELECT i.id, i.rule_id
         FROM incidents i
         JOIN rules r ON r.id = i.rule_id
         WHERE i.device_id = $1
           AND r.type = 'silence'
           AND r.auto_resolve = true
           AND i.state IN ('open', 'acknowledged')`,
        [event.device_id]
      );

      for (const inc of silenceIncidents.rows) {
        await client.query(
          `UPDATE incidents
           SET state = 'resolved',
               resolved_at = now(),
               resolved_by = 'system (device resumed reporting)',
               resolution_reason = 'device resumed reporting'
           WHERE id = $1`,
          [inc.id]
        );

        await client.query(
          `INSERT INTO activity_log (kind, entity_type, entity_id, data)
           VALUES ('incident_resolved', 'incident', $1, $2)`,
          [
            inc.id,
            JSON.stringify({
              incident_id: parseInt(inc.id, 10),
              device_id: event.device_id,
              reason: 'device resumed reporting',
            }),
          ]
        );

        await pgNotify(client, PG_CHANNELS.INCIDENT_CHANGED, {
          action: 'resolved',
          incident_id: parseInt(inc.id, 10),
          device_id: event.device_id,
          reason: 'device resumed reporting',
        });
      }

      // 4. Load enabled rules and evaluate
      const enabledRules = await this.rulesCache.getEnabledRules();
      const decisions = await processEventRules(client, event, enabledRules, locationId);

      // 5. Store rule_evaluations audit rows
      for (const d of decisions) {
        await client.query(
          `INSERT INTO rule_evaluations (
            event_ingest_seq, device_id, rule_id, evaluated_at, matched, outcome, reason, incident_id
           ) VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`,
          [
            event.ingest_seq,
            event.device_id,
            d.rule.id,
            d.matched,
            d.outcome,
            d.reason,
            d.incidentId ?? null,
          ]
        );
      }

      // 6. Mark event done
      await client.query(
        `UPDATE events
         SET status = 'done',
             processed_at = now(),
             locked_until = NULL,
             last_error = NULL
         WHERE ingest_seq = $1`,
        [event.ingest_seq]
      );

      await client.query('COMMIT');

      // Record metrics
      const elapsedNs = Number(process.hrtime.bigint() - startTime);
      const elapsedSec = elapsedNs / 1e9;
      processingDurationSeconds.observe(elapsedSec);

      const lagSec = Math.max(0, (Date.now() - new Date(event.received_at).getTime()) / 1000);
      processingLagSeconds.observe(lagSec);

      eventsProcessedTotal.inc({ outcome: 'done' });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, ingest_seq: event.ingest_seq, device_id: event.device_id, attempts: event.attempts },
        'Failed to process event'
      );

      eventsProcessedTotal.inc({ outcome: 'error' });

      // Check max attempts -> dead letter
      if (event.attempts >= this.maxAttempts) {
        eventsFailedTotal.inc();
        await this.pool.query(
          `UPDATE events
           SET status = 'failed',
               last_error = $1,
               processed_at = now(),
               locked_until = NULL
           WHERE ingest_seq = $2`,
          [errMsg, event.ingest_seq]
        );

        await this.pool.query(
          `INSERT INTO activity_log (kind, entity_type, entity_id, data)
           VALUES ('event_failed', 'event', $1, $2)`,
          [
            String(event.ingest_seq),
            JSON.stringify({
              ingest_seq: event.ingest_seq,
              device_id: event.device_id,
              error: errMsg,
              attempts: event.attempts,
            }),
          ]
        );
      } else {
        // Exponential backoff lease release: 2^(attempts) seconds
        const backoffSec = Math.min(Math.pow(2, event.attempts), 60);
        await this.pool.query(
          `UPDATE events
           SET status = 'pending',
               last_error = $1,
               locked_until = now() + ($2 || ' seconds')::interval
           WHERE ingest_seq = $3`,
          [errMsg, backoffSec, event.ingest_seq]
        );
      }
    } finally {
      client.release();
    }
  }
}
