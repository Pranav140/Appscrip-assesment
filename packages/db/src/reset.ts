import { getPool } from './pool.js';

/**
 * Drop and recreate the public schema. DESTROYS ALL DATA.
 * Only for use in development/test environments.
 */
export async function reset(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('db:reset is not allowed in production');
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    console.log('[db:reset] schema reset complete');
  } finally {
    client.release();
  }
}

// CLI entry point
reset()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[db:reset] error:', err);
    process.exit(1);
  });
