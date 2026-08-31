import { pool } from "@platform-pub/shared/db/client.js";

// =============================================================================
// platform_config in-process cache (gateway copy)
//
// Deliberate sibling of feed-ingest/src/lib/platform-config.ts, not a shared
// module: the useful part IS the per-process state, so "sharing" it would move
// ~30 lines into shared/ while each service still kept its own cache instance.
// Keep the two in step if the shape changes.
//
// The gateway reads tuning dials on the feed read path (D6 proof blend), which
// is the hottest path in the service — a SELECT per feed page, multiplied by
// every feed in a /bootstrap fan-out, for a table that changes only when an
// operator tunes it. One cached snapshot of the whole table as Map<key, value>;
// a single in-flight refresh is shared so a burst of concurrent requests
// collapses to one query, and past the TTL the stale map is still served until
// the refresh resolves.
// =============================================================================

const TTL_MS = 30_000;

let cache: Map<string, string> | null = null;
let fetchedAt = 0;
let inflight: Promise<Map<string, string>> | null = null;

async function refresh(): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config`,
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  cache = map;
  fetchedAt = Date.now();
  return map;
}

/**
 * platform_config as a Map<key, value>, cached for TTL_MS in-process.
 * Concurrent callers within the TTL share the cached map (and a single
 * in-flight refresh after expiry).
 */
export async function getPlatformConfig(): Promise<Map<string, string>> {
  if (cache && Date.now() - fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = refresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Drop the cached snapshot — for tests, or after a known config write. */
export function invalidatePlatformConfig(): void {
  cache = null;
  fetchedAt = 0;
}
