import { query, queryOne } from '@rtops/db';

/**
 * Get the current depth of the pending event queue.
 * Cached for ~1 second to avoid hammering the DB on every ingest request.
 */
let cachedDepth = 0;
let lastFetched = 0;
const CACHE_TTL_MS = 1000;

export async function getQueueDepth(): Promise<number> {
  const now = Date.now();
  if (now - lastFetched < CACHE_TTL_MS) {
    return cachedDepth;
  }

  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*) AS count FROM events WHERE status = 'pending'`
  );
  cachedDepth = parseInt(row?.count ?? '0', 10);
  lastFetched = now;
  return cachedDepth;
}

/** Force refresh of the queue depth cache */
export function invalidateQueueDepthCache(): void {
  lastFetched = 0;
}
