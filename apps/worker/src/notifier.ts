import type { Pool } from 'pg';
import { getPool } from '@rtops/db';
import { createLogger, getEnv } from '@rtops/shared';
import {
  notificationsSentTotal,
  notificationsFailedTotal,
  outboxDepthGauge,
  circuitBreakerStateGauge,
} from './metrics.js';

const logger = createLogger({ service: 'worker:notifier' });

interface OutboxNotification {
  id: number;
  incident_id: number;
  operator_id: number;
  channel: string;
  payload: Record<string, unknown>;
  attempts: number;
  idempotency_key: string;
  webhook_url: string | null;
}

class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openUntil = 0;
  private readonly threshold = 5;
  private readonly coolOffMs = 30000;

  public canAttempt(): boolean {
    const now = Date.now();
    if (this.state === 'open') {
      if (now > this.openUntil) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }

  public recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  public recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openUntil = Date.now() + this.coolOffMs;
      logger.warn({ failures: this.failures }, 'Circuit breaker OPENED for destination');
    }
  }

  public getStateNum(): number {
    if (this.state === 'closed') return 0;
    if (this.state === 'open') return 1;
    return 2;
  }
}

export class NotificationDispatcher {
  private pool: Pool;
  private running = false;
  private intervalMs: number;
  private maxAttempts: number;
  private circuitBreakers = new Map<string, CircuitBreaker>();

  constructor(
    pool: Pool,
    options: {
      intervalMs?: number;
      maxAttempts?: number;
    } = {}
  ) {
    this.pool = pool;
    this.intervalMs = options.intervalMs ?? 2000;
    this.maxAttempts = options.maxAttempts ?? 8;
  }

  public async start(): Promise<void> {
    this.running = true;
    logger.info('Notification dispatcher starting');
    void this.loop();
  }

  public stop(): void {
    this.running = false;
  }

  private getBreaker(destination: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(destination);
    if (!cb) {
      cb = new CircuitBreaker();
      this.circuitBreakers.set(destination, cb);
    }
    return cb;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.dispatchPending();
      } catch (err) {
        logger.error({ err }, 'Error in notifier loop');
      }
      await new Promise((resolve) => setTimeout(resolve, this.intervalMs));
    }
  }

  private async dispatchPending(): Promise<void> {
    // 1. Update gauge for pending/failed outbox depth
    const countRes = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications WHERE status IN ('pending', 'failed')`
    );
    outboxDepthGauge.set(parseInt(countRes.rows[0]?.count ?? '0', 10));

    // 2. Claim due notifications using FOR UPDATE SKIP LOCKED
    const claimQuery = `
      WITH claimed AS (
        SELECT n.id
        FROM notifications n
        WHERE n.status IN ('pending', 'failed')
          AND n.next_attempt_at <= now()
          AND (n.locked_until IS NULL OR n.locked_until < now())
        ORDER BY n.id ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      )
      UPDATE notifications n
      SET status = 'sending',
          locked_until = now() + interval '30 seconds',
          attempts = n.attempts + 1
      FROM claimed c
      WHERE n.id = c.id
      RETURNING n.id, n.incident_id, n.operator_id, n.channel, n.payload,
                n.attempts, n.idempotency_key;
    `;

    const { rows: claimed } = await this.pool.query<OutboxNotification>(claimQuery);
    if (claimed.length === 0) return;

    for (const notif of claimed) {
      await this.sendNotification(notif);
    }
  }

  private async sendNotification(notif: OutboxNotification): Promise<void> {
    const env = getEnv();

    // Fetch operator webhook_url if needed
    let destinationUrl = env.NOTIFY_WEBHOOK_URL;
    if (notif.operator_id) {
      const opRes = await this.pool.query<{ webhook_url: string | null }>(
        'SELECT webhook_url FROM operators WHERE id = $1',
        [notif.operator_id]
      );
      if (opRes.rows[0]?.webhook_url) {
        destinationUrl = opRes.rows[0].webhook_url;
      }
    }

    const breaker = this.getBreaker(destinationUrl);
    circuitBreakerStateGauge.set({ destination: destinationUrl }, breaker.getStateNum());

    if (!breaker.canAttempt()) {
      logger.info({ destinationUrl, notifId: notif.id }, 'Circuit breaker open; deferring notification attempt');
      await this.pool.query(
        `UPDATE notifications
         SET status = 'failed',
             locked_until = NULL,
             next_attempt_at = now() + interval '10 seconds'
         WHERE id = $1`,
        [notif.id]
      );
      return;
    }

    try {
      if (notif.channel === 'log') {
        // Fallback channel: always succeeds
        logger.info({ notifId: notif.id, payload: notif.payload }, '[NOTIFY:LOG] Notification dispatched');
      } else {
        // Webhook channel
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(destinationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': notif.idempotency_key,
            'User-Agent': 'rtops-worker/1.0',
          },
          body: JSON.stringify(notif.payload),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`Webhook returned status ${response.status} ${response.statusText}`);
        }
      }

      // Success
      breaker.recordSuccess();
      circuitBreakerStateGauge.set({ destination: destinationUrl }, breaker.getStateNum());
      notificationsSentTotal.inc({ channel: notif.channel });

      await this.pool.query(
        `UPDATE notifications
         SET status = 'sent',
             sent_at = now(),
             locked_until = NULL,
             last_error = NULL
         WHERE id = $1`,
        [notif.id]
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      breaker.recordFailure();
      circuitBreakerStateGauge.set({ destination: destinationUrl }, breaker.getStateNum());
      notificationsFailedTotal.inc({ channel: notif.channel });

      logger.error(
        { err, notifId: notif.id, attempts: notif.attempts, destinationUrl },
        'Failed to deliver notification'
      );

      if (notif.attempts >= this.maxAttempts) {
        // Mark DEAD letter
        await this.pool.query(
          `UPDATE notifications
           SET status = 'dead',
               last_error = $1,
               locked_until = NULL
           WHERE id = $2`,
          [errMsg, notif.id]
        );

        await this.pool.query(
          `INSERT INTO activity_log (kind, entity_type, entity_id, data)
           VALUES ('notification_dead', 'notification', $1, $2)`,
          [
            String(notif.id),
            JSON.stringify({
              notification_id: notif.id,
              incident_id: notif.incident_id,
              error: errMsg,
              attempts: notif.attempts,
            }),
          ]
        );
      } else {
        // Exponential backoff with jitter: 2^(attempts) + random jitter (0-2s)
        const jitter = Math.random() * 2;
        const delaySec = Math.min(Math.pow(2, notif.attempts) + jitter, 300);

        await this.pool.query(
          `UPDATE notifications
           SET status = 'failed',
               last_error = $1,
               locked_until = NULL,
               next_attempt_at = now() + ($2 || ' seconds')::interval
           WHERE id = $3`,
          [errMsg, Math.round(delaySec), notif.id]
        );
      }
    }
  }
}
