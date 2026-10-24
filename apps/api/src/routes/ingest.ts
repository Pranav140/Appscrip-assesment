import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getPool, withTransaction, pgNotify } from '@rtops/db';
import { IngestBatchSchema, type EventAck, getEnv } from '@rtops/shared';
import { PG_CHANNELS } from '@rtops/shared';
import {
  eventsReceivedTotal,
  ingestBatchSize,
  ingestDurationSeconds,
  ingestRejectedTotal,
  rateLimitedTotal,
} from '../metrics.js';
import { getQueueDepth, invalidateQueueDepthCache } from '../services/queue.js';

// ── Per-device in-memory token bucket rate limiter ──────────
const deviceBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const BUCKET_CAPACITY = 100;
const REFILL_PER_SECOND = 20;

function checkRateLimit(deviceId: string): boolean {
  const now = Date.now();
  let bucket = deviceBuckets.get(deviceId);
  if (!bucket) {
    bucket = { tokens: BUCKET_CAPACITY, lastRefill: now };
    deviceBuckets.set(deviceId, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsed * REFILL_PER_SECOND);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ── Admin token auth helper ─────────────────────────────────
function checkAdminToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();
  const pool = getPool();

  // ── POST /v1/events ─────────────────────────────────────────
  app.post<{
    Headers: { 'x-device-id'?: string; 'x-device-key'?: string };
  }>('/events', async (req, reply) => {
    const timer = ingestDurationSeconds.startTimer();
    const deviceId = req.headers['x-device-id'];
    const deviceKey = req.headers['x-device-key'];

    if (!deviceId || !deviceKey) {
      return reply.status(400).send({
        error: { code: 'MISSING_HEADERS', message: 'X-Device-Id and X-Device-Key headers required' },
      });
    }

    // ── Authenticate device ─────────────────────────────────
    const keyHash = crypto.createHash('sha256').update(deviceKey).digest('hex');
    const device = await queryOne<{ id: string; api_key_hash: string }>(
      pool,
      'SELECT id, api_key_hash FROM devices WHERE id = $1',
      [deviceId]
    );

    if (!device) {
      return reply.status(401).send({ error: { code: 'UNKNOWN_DEVICE', message: 'Device not found' } });
    }

    const expectedHash = Buffer.from(device.api_key_hash);
    const providedHash = Buffer.from(keyHash);
    if (expectedHash.length !== providedHash.length || !crypto.timingSafeEqual(expectedHash, providedHash)) {
      return reply.status(401).send({ error: { code: 'INVALID_KEY', message: 'Invalid device key' } });
    }

    // ── Per-device rate limit ─────────────────────────────────
    if (!checkRateLimit(deviceId)) {
      rateLimitedTotal.inc({ device_id: deviceId });
      req.log.warn({ device_id: deviceId }, 'Rate limit exceeded');
      return reply.status(429).header('Retry-After', '5').send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Retry after 5 seconds.' },
      });
    }

    // ── Backpressure check ─────────────────────────────────────
    const queueDepth = await getQueueDepth();
    if (queueDepth >= env.HIGH_WATERMARK) {
      const retryAfter = 30;
      return reply.status(429).header('Retry-After', String(retryAfter)).send({
        error: {
          code: 'QUEUE_FULL',
          message: `Queue depth ${queueDepth} exceeds limit ${env.HIGH_WATERMARK}. Retry after ${retryAfter}s.`,
          details: { queue_depth: queueDepth, high_watermark: env.HIGH_WATERMARK },
        },
      });
    }

    // ── Parse + validate batch ─────────────────────────────────
    const parseResult = IngestBatchSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: { code: 'INVALID_BODY', message: 'Request body validation failed', details: parseResult.error.flatten() },
      });
    }

    const { events } = parseResult.data;
    ingestBatchSize.observe(events.length);

    const acks: EventAck[] = [];
    const validEvents: typeof events = [];
    const now = new Date();

    // ── Per-event validation ───────────────────────────────────
    for (const evt of events) {
      // device_id mismatch: reject this event only
      if (evt.device_id !== deviceId) {
        acks.push({ event_id: evt.event_id, status: 'rejected', reason: 'device_id does not match authenticated device' });
        ingestRejectedTotal.inc({ reason: 'device_id_mismatch' });
        await pool.query(
          `INSERT INTO rejected_events (device_id, raw, reason) VALUES ($1, $2, $3)`,
          [deviceId, JSON.stringify(evt), 'device_id mismatch']
        );
        continue;
      }

      // Future timestamp check
      const evtTs = new Date(evt.ts);
      const futureLimit = new Date(now.getTime() + env.MAX_FUTURE_SECONDS * 1000);
      if (evtTs > futureLimit) {
        acks.push({ event_id: evt.event_id, status: 'rejected', reason: `timestamp too far in future (${evt.ts})` });
        ingestRejectedTotal.inc({ reason: 'future_timestamp' });
        await pool.query(
          `INSERT INTO rejected_events (device_id, raw, reason) VALUES ($1, $2, $3)`,
          [deviceId, JSON.stringify(evt), 'timestamp too far in future']
        );
        continue;
      }

      validEvents.push(evt);
    }

    if (validEvents.length === 0) {
      timer();
      return reply.status(200).send({ results: acks });
    }

    // ── Batch insert valid events (one statement) ─────────────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Build VALUES for bulk insert
      const replayThresholdMs = env.REPLAY_THRESHOLD_SECONDS * 1000;
      const valueRows = validEvents.map((evt, i) => {
        const base = i * 6;
        const receivedAt = now.toISOString();
        const evtTs = new Date(evt.ts);
        const isReplay = now.getTime() - evtTs.getTime() > replayThresholdMs;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::timestamptz, $${base + 6}::boolean)`;
      });

      const flatParams: unknown[] = [];
      for (const evt of validEvents) {
        const isReplay = now.getTime() - new Date(evt.ts).getTime() > replayThresholdMs;
        flatParams.push(
          evt.device_id,
          evt.event_id,
          evt.type,
          evt.ts,
          JSON.stringify(evt.payload),
          isReplay
        );
      }

      // INSERT ... ON CONFLICT DO NOTHING RETURNING to identify duplicates
      const insertSql = `
        INSERT INTO events (device_id, event_id, type, event_ts, payload, is_replay)
        VALUES ${valueRows
          .map((_, i) => {
            const base = i * 6;
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::timestamptz, $${base + 5}::jsonb, $${base + 6}::boolean)`;
          })
          .join(', ')}
        ON CONFLICT (device_id, event_id) DO NOTHING
        RETURNING event_id
      `;

      // Rebuild params correctly
      const insertParams: unknown[] = [];
      for (const evt of validEvents) {
        const isReplay = now.getTime() - new Date(evt.ts).getTime() > replayThresholdMs;
        insertParams.push(evt.device_id, evt.event_id, evt.type, evt.ts, JSON.stringify(evt.payload), isReplay);
      }

      const insertResult = await client.query<{ event_id: string }>(insertSql, insertParams);
      const insertedIds = new Set(insertResult.rows.map((r) => r.event_id));

      // Classify each valid event
      for (const evt of validEvents) {
        if (insertedIds.has(evt.event_id)) {
          acks.push({ event_id: evt.event_id, status: 'accepted' });
          eventsReceivedTotal.inc({ result: 'accepted' });
        } else {
          acks.push({ event_id: evt.event_id, status: 'duplicate' });
          eventsReceivedTotal.inc({ result: 'duplicate' });
        }
      }

      // Update device last_seen_at monotonically
      await client.query(
        `UPDATE devices SET
           last_seen_at  = GREATEST(last_seen_at, $2::timestamptz),
           last_event_ts = GREATEST(last_event_ts, $3::timestamptz)
         WHERE id = $1`,
        [deviceId, now.toISOString(), validEvents[validEvents.length - 1]?.ts ?? now.toISOString()]
      );

      await client.query('COMMIT');

      // Notify worker after commit (best-effort; worker also polls)
      void pgNotify(PG_CHANNELS.EVENTS_AVAILABLE, { device_id: deviceId, count: insertedIds.size });
      invalidateQueueDepthCache();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const accepted = acks.filter((a) => a.status === 'accepted').length;
    const duplicates = acks.filter((a) => a.status === 'duplicate').length;
    const rejected = acks.filter((a) => a.status === 'rejected').length;

    req.log.info({ device_id: deviceId, accepted, duplicates, rejected }, 'Ingest complete');
    timer();

    return reply.status(200).send({ results: acks });
  });

  // ── POST /v1/devices/register ───────────────────────────────
  app.post<{
    Headers: { authorization?: string };
    Body: { device_id: string; name: string; location_id?: number };
  }>('/devices/register', async (req, reply) => {
    const adminToken = req.headers.authorization?.replace('Bearer ', '');
    if (!checkAdminToken(adminToken, env.ADMIN_TOKEN)) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid admin token' } });
    }

    const { device_id, name, location_id } = req.body ?? {};
    if (!device_id || !name) {
      return reply.status(400).send({ error: { code: 'INVALID_BODY', message: 'device_id and name required' } });
    }

    // Generate a new API key
    const rawKey = crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    await pool.query(
      `INSERT INTO devices (id, name, location_id, api_key_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET api_key_hash = EXCLUDED.api_key_hash, name = EXCLUDED.name`,
      [device_id, name, location_id ?? null, keyHash]
    );

    req.log.info({ device_id, name }, 'Device registered/key rotated');

    // Return the raw key ONCE — it cannot be recovered later
    return reply.status(200).send({ device_id, api_key: rawKey, note: 'Store this key securely. It will not be shown again.' });
  });
}

// Simple query helper using a pool
async function queryOne<T>(pool: import('pg').Pool, sql: string, params: unknown[]): Promise<T | undefined> {
  const result = await pool.query<T>(sql as string, params as unknown[]);
  return result.rows[0];
}
