import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Run all pending migrations from packages/db/migrations/ in lexicographic order.
 * Each migration runs in its own transaction. Tracks applied migrations in
 * schema_migrations table. Safe to run multiple times (idempotent).
 */
export async function migrate(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Ensure the tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows: applied } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[migrate] skip ${file} (already applied)`);
        continue;
      }

      console.log(`[migrate] applying ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    console.log('[migrate] all migrations up to date');
  } finally {
    client.release();
  }
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1]?.split('/').pop() ?? '')) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] error:', err);
      process.exit(1);
    });
}
