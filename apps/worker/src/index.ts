import http from 'node:http';
import pg from 'pg';
import { getPool } from '@rtops/db';
import { getEnv, createLogger, PG_CHANNELS } from '@rtops/shared';
import { register } from './metrics.js';
import { RulesCache } from './rules.js';
import { EventProcessor } from './processor.js';
import { SilenceDetector } from './silence.js';
import { NotificationDispatcher } from './notifier.js';

const logger = createLogger({ service: 'worker' });

async function main() {
  const env = getEnv();
  const pool = getPool();

  logger.info('Initializing RTOps worker service');

  const rulesCache = new RulesCache(pool);
  await rulesCache.getEnabledRules();

  // 1. Dedicated LISTEN connection for rule updates
  const { Client } = pg;
  const listenClient = new Client({ connectionString: env.DATABASE_URL });
  await listenClient.connect();
  await listenClient.query(`LISTEN ${PG_CHANNELS.RULES_CHANGED}`);

  listenClient.on('notification', (msg) => {
    if (msg.channel === PG_CHANNELS.RULES_CHANGED) {
      logger.info('Received rules_changed notification; invalidating local cache');
      rulesCache.invalidate();
    }
  });

  // 2. Start Background Components
  const eventProcessor = new EventProcessor(pool, rulesCache, {
    concurrency: env.WORKER_CONCURRENCY,
    batchSize: env.WORKER_BATCH_SIZE,
    leaseSeconds: env.WORKER_LEASE_SECONDS,
  });

  const silenceDetector = new SilenceDetector(pool, rulesCache, {
    intervalMs: 5000,
    gracePeriodSec: 30,
  });

  const notifier = new NotificationDispatcher(pool, {
    intervalMs: 2000,
  });

  await eventProcessor.start();
  await silenceDetector.start();
  await notifier.start();

  // 3. Simple Prometheus metrics & Health server
  const metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    } else if (req.url === '/healthz') {
      res.statusCode = 200;
      res.end('OK');
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  const metricsPort = 3002;
  metricsServer.listen(metricsPort, () => {
    logger.info({ port: metricsPort }, 'Worker metrics server listening');
  });

  // 4. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down gracefully');
    eventProcessor.stop();
    silenceDetector.stop();
    notifier.stop();

    metricsServer.close();
    await listenClient.end().catch(() => {});
    await pool.end().catch(() => {});

    logger.info('Worker shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Worker fatal startup error');
  process.exit(1);
});
