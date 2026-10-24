import pg from 'pg';
import { getEnv } from '@rtops/shared';

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * Get (or lazily create) the shared pg connection pool.
 * Pool size defaults are suitable for both API and worker.
 */
export function getPool(options?: { max?: number }): pg.Pool {
  if (_pool) return _pool;

  const env = getEnv();
  _pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: options?.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'rtops',
  });

  _pool.on('error', (err) => {
    // Log pool errors — don't crash, the pool will reconnect
    console.error('[pg-pool] idle client error', err.message);
  });

  return _pool;
}

/** Close the pool (for graceful shutdown / tests) */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/** Reset the pool reference (for tests that need a fresh pool) */
export function resetPool(): void {
  _pool = null;
}

export type { PoolClient } from 'pg';
export { pg };
