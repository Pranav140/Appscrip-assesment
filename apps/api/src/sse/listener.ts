import pg from 'pg';
import { getEnv } from '@rtops/shared';
import { PG_CHANNELS } from '@rtops/shared';
import type { SSEBroker } from './broker.js';

const { Client } = pg;

let listenClient: pg.Client | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let broker: InstanceType<typeof import('./broker.js').SSEBroker & { new(): unknown }> | null = null;

/**
 * Establish a dedicated LISTEN connection separate from the pool.
 * The pool connections are short-lived; LISTEN requires a persistent connection.
 * On disconnect: reconnect with exponential backoff, then broadcast resync.
 */
export async function setupListenConnection(ssebroker: InstanceType<typeof import('./broker.js')['sseBroker'] extends infer T ? T extends object ? { constructor: new () => T } : never : never>): Promise<void> {
  await connect(ssebroker as unknown as SSEBrokerType);
}

type SSEBrokerType = {
  broadcast: (msg: { kind: string; data: unknown }) => void;
  broadcastResync: () => void;
};

async function connect(ssebroker: SSEBrokerType, attempt = 0): Promise<void> {
  const env = getEnv();

  if (listenClient) {
    try { await listenClient.end(); } catch { /* ignore */ }
    listenClient = null;
  }

  const client = new Client({ connectionString: env.DATABASE_URL });

  try {
    await client.connect();
    listenClient = client;

    // Subscribe to all relevant channels
    const channels = Object.values(PG_CHANNELS);
    for (const ch of channels) {
      await client.query(`LISTEN "${ch}"`);
    }

    if (attempt > 0) {
      // After reconnect, tell all SSE clients to resync
      ssebroker.broadcastResync();
    }

    console.info(`[listen] Connected and listening on ${channels.length} channels`);

    client.on('notification', (msg) => {
      handleNotification(ssebroker, msg.channel, msg.payload ?? '{}');
    });

    client.on('error', (err) => {
      console.error('[listen] Client error:', err.message);
      scheduleReconnect(ssebroker, attempt + 1);
    });

    client.on('end', () => {
      console.warn('[listen] Client ended unexpectedly');
      scheduleReconnect(ssebroker, attempt + 1);
    });
  } catch (err) {
    console.error(`[listen] Connection failed (attempt ${attempt}):`, (err as Error).message);
    scheduleReconnect(ssebroker, attempt + 1);
  }
}

function scheduleReconnect(ssebroker: SSEBrokerType, attempt: number): void {
  if (reconnectTimeout) return;
  const delayMs = Math.min(1000 * 2 ** attempt, 30_000); // max 30s
  console.info(`[listen] Reconnecting in ${delayMs}ms (attempt ${attempt})`);
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    void connect(ssebroker, attempt);
  }, delayMs);
}

function handleNotification(ssebroker: SSEBrokerType, channel: string, rawPayload: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    payload = { raw: rawPayload };
  }

  switch (channel) {
    case PG_CHANNELS.INCIDENT_CHANGED:
      ssebroker.broadcast({ kind: 'incident', data: payload });
      break;
    case PG_CHANNELS.DEVICE_STATUS_CHANGED:
      ssebroker.broadcast({ kind: 'device', data: payload });
      break;
    case PG_CHANNELS.ACTIVITY:
      ssebroker.broadcast({ kind: 'activity', data: payload });
      break;
    case PG_CHANNELS.EVENTS_AVAILABLE:
      ssebroker.broadcast({ kind: 'event', data: payload });
      break;
    default:
      break;
  }
}
