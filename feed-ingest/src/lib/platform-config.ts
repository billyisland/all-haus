import { pool } from "@platform-pub/shared/db/client.js";

// =============================================================================
// platform_config in-process cache (audit Tranche A · A5)
//
// Every feed-ingest task (poll, rss, activitypub, nostr, listener reconnect)
// used to SELECT from platform_config on each job. The poll alone fires every
// 60s and each fetch job re-reads the same handful of rows. The table changes
// rarely (operator tweaks), so a short-TTL process cache removes that per-job
// round trip with no observable behaviour change at steady state.
//
// One cached snapshot of the WHOLE table as Map<key, value>; callers .get()
// the keys they need. A single in-flight refresh is shared so a burst of
// concurrent jobs collapses to one query. Past the TTL the next caller triggers
// a refresh; until it resolves, the (slightly) stale map is still served.
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
 * Returns platform_config as a Map<key, value>, cached for TTL_MS in-process.
 * Concurrent callers within the TTL share the cached map (and a single in-flight
 * refresh after expiry).
 */
export async function getPlatformConfig(): Promise<Map<string, string>> {
  if (cache && Date.now() - fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = refresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

