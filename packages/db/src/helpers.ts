import type pg from 'pg';
import { getPool } from './pool.js';

/**
 * Run a function inside a serializable transaction.
 * Rolls back on throw; re-throws the error after rollback.
 * Accepts either a pool client or uses the pool to get one.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  clientOrPool?: pg.PoolClient | pg.Pool
): Promise<T> {
  const pool = getPool();
  const client = clientOrPool
    ? ('query' in clientOrPool && 'release' in clientOrPool
        ? (clientOrPool as pg.PoolClient)
        : null)
    : null;

  // If we received a PoolClient, use it directly (caller manages lifecycle)
  if (client && 'release' in client) {
    return fn(client);
  }

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Execute a query and return all rows typed.
 */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
  clientOrPool?: pg.PoolClient | pg.Pool
): Promise<pg.QueryResult<T>> {
  const executor = clientOrPool ?? getPool();
  return executor.query<T>(sql, params as unknown[]);
}

/**
 * Execute a query and return the first row or undefined.
 */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
  clientOrPool?: pg.PoolClient | pg.Pool
): Promise<T | undefined> {
  const result = await query<T>(sql, params, clientOrPool);
  return result.rows[0];
}

/**
 * Send a pg_notify on a channel with a JSON payload.
 * The payload must be < 8000 bytes (Postgres pg_notify limit).
 */
export async function pgNotify(
  channel: string,
  payload: unknown,
  clientOrPool?: pg.PoolClient | pg.Pool
): Promise<void> {
  const json = JSON.stringify(payload);
  if (json.length > 7900) {
    // Truncate to avoid pg_notify limit; receivers must fetch full data
    console.warn(`[pgNotify] payload for ${channel} exceeds 7900 bytes, sending minimal hint`);
    const hint = JSON.stringify({ truncated: true });
    await query(`SELECT pg_notify($1, $2)`, [channel, hint], clientOrPool);
    return;
  }
  await query(`SELECT pg_notify($1, $2)`, [channel, json], clientOrPool);
}
