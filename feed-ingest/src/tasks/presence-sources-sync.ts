import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { authoritativeId, httpOrigin } from "@platform-pub/shared/lib/activitypub-origin.js";
import { fetchMastodonAccountById } from "@platform-pub/shared/lib/mastodon-api.js";
import { sourceBlockedSql } from "@platform-pub/shared/lib/platform-blocks.js";

// =============================================================================
// presence_sources_sync — a member's own posts elsewhere are ingested because
// they linked the account (CROSS-NETWORK-ROUNDTRIP-ADR rung D2).
//
// A linked Bluesky DID or Mastodon actor used to arrive only if the member put
// their own account into one of their feeds, and then as an ordinary stranger's
// source. Rung D makes the presence itself the reason to ingest. The source is
// the ordinary shared `external_sources` row, so everything downstream is the
// path every source takes: the Jetstream DID set and the poll selector read
// `is_active`, the ingesters write `external_items`/`feed_items`, and the
// identity trigger files the posts under the `external_authors` row the member
// claims (migration 237). NO `external_subscriptions` row is written — that
// row is a projection of feed membership, and a presence is not a feed — so
// the GC spares the source on the presence instead (`presenceSourceSql`).
//
// TWO PHASES, each looping over rows that fail ALONE (a partial outcome is
// counted, never an abort):
//
//   1. The KEY. A Mastodon presence stores an instance-local account id, in
//      nobody's id-space. The link callback now records the actor URI; a
//      presence linked before migration 237 has none, so it is read here off
//      the instance's public account endpoint and accepted only if the
//      instance that answered is authoritative for it (§2.9 — an instance
//      claiming another host's actor would otherwise make a member the author
//      of a stranger's posts). A presence whose instance serves no `uri`
//      (Mastodon before 4.2, most non-Mastodon servers) stays unkeyed and is
//      counted: guessing `/users/<name>` would be right on Mastodon and wrong
//      elsewhere, and a wrong key is a false attribution.
//   2. The SOURCE. Every active, keyed presence of an active member gets an
//      active source, and a NEW or GC-revived one gets its first fetch (the
//      same task and job key the add path uses, so the two dedupe). A source
//      the ingest task switched off for failing is left off: reviving it here
//      every tick would spin a dead source for ever. Concierge presences are
//      skipped, because everything on them is an all.haus cross-post.
//      A platform-blocked identity is skipped and counted — the operator's
//      refusal holds however a source would reach us.
// =============================================================================

const KEY_BATCH = 50;
const SOURCE_BATCH = 200;

export const UNKEYED_AP_PRESENCES_SQL = `
    SELECT np.id, np.external_id, np.service_url
      FROM network_presences np
      JOIN accounts a ON a.id = np.account_id AND a.status = 'active'
     WHERE np.protocol = 'activitypub'
       AND np.lifecycle_state = 'active'
       AND np.stable_handle IS NULL
       AND np.service_url IS NOT NULL
     ORDER BY np.created_at
     LIMIT $1`;

// A presence whose source is absent, or was switched off by the GC
// (orphaned_at set before the presence guard existed). One switched off by the
// ingest task for failing has orphaned_at NULL and is not selected.
export const PRESENCES_NEEDING_SOURCE_SQL = `
    SELECT np.id, np.protocol::text AS protocol, np.stable_handle,
           ${sourceBlockedSql("k")} AS blocked
      FROM network_presences np
      JOIN accounts a ON a.id = np.account_id AND a.status = 'active'
      CROSS JOIN LATERAL (SELECT np.protocol, np.stable_handle AS source_uri) k
     WHERE np.lifecycle_state = 'active'
       AND np.provenance <> 'concierge'
       AND np.protocol IN ('atproto', 'activitypub')
       AND np.stable_handle IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM external_sources es
          WHERE es.protocol = np.protocol
            AND es.source_uri = np.stable_handle
            AND (es.is_active OR es.orphaned_at IS NULL)
       )
     ORDER BY np.created_at
     LIMIT $1`;

// The INSERT arm names nothing: the first subscriber may name a shared source
// and a presence is not one; the metadata refresh and the atproto enrichment
// fill the blanks. The UPDATE arm revives only what the GC switched off.
export const PRESENCE_SOURCE_UPSERT_SQL = `
    INSERT INTO external_sources (protocol, source_uri)
    VALUES ($1::external_protocol, $2)
    ON CONFLICT (protocol, source_uri) DO UPDATE
       SET is_active = TRUE, orphaned_at = NULL, updated_at = now()
     WHERE external_sources.orphaned_at IS NOT NULL
    RETURNING id`;

// The subscribe-time fetch, as gateway/src/routes/feeds/sources.ts spells it
// (externalFetchTask / externalFetchJobKey / externalFetchMaxAttempts — no
// import path between the workspaces). The shared job key means an add and a
// sync of the same source enqueue one job, not two.
const FIRST_FETCH: Record<string, { task: string; maxAttempts: number }> = {
  atproto: { task: "feed_ingest_atproto_backfill", maxAttempts: 5 },
  activitypub: { task: "feed_ingest_activitypub", maxAttempts: 1 },
};

export interface SyncTally {
  keyed: number;
  /** Mastodon presences still without an actor URI after asking. */
  unkeyed: number;
  sourced: number;
  blocked: number;
  failed: number;
}

/** Phase 1: the actor URI for an activitypub presence linked before 237. */
async function keyActivityPubPresences(tally: SyncTally): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    external_id: string;
    service_url: string;
  }>(UNKEYED_AP_PRESENCES_SQL, [KEY_BATCH]);

  for (const p of rows) {
    const origin = httpOrigin(p.service_url);
    const account = origin ? await fetchMastodonAccountById(origin, p.external_id) : null;
    const actor = account?.uri ? authoritativeId(account.uri, p.service_url) : null;
    if (!actor) {
      tally.unkeyed++;
      logger.debug(
        { presenceId: p.id, claimed: account?.uri ?? null },
        "presence_sources_sync: no authoritative actor uri",
      );
      continue;
    }
    try {
      // Its own transaction: the UPDATE fires the claim trigger (migration
      // 237), and a failure must take the claim down with the key.
      await withTransaction((client) =>
        client.query(
          `UPDATE network_presences SET stable_handle = $2, updated_at = now()
            WHERE id = $1 AND stable_handle IS NULL`,
          [p.id, actor],
        ),
      );
      tally.keyed++;
    } catch (err) {
      // 23505: another presence already holds this identity. Counted, never
      // resolved by moving the claim — which of two members owns an actor is
      // not a question this task can answer.
      tally.failed++;
      logger.warn({ err, presenceId: p.id, actor }, "presence_sources_sync: key write failed");
    }
  }
}

/** Phase 2: an active source, and its first fetch, for each keyed presence. */
async function ensurePresenceSources(tally: SyncTally): Promise<void> {
  const { rows } = await pool.query<{
    id: string;
    protocol: string;
    stable_handle: string;
    blocked: boolean;
  }>(PRESENCES_NEEDING_SOURCE_SQL, [SOURCE_BATCH]);

  for (const p of rows) {
    if (p.blocked) {
      tally.blocked++;
      continue;
    }
    const fetch = FIRST_FETCH[p.protocol];
    try {
      await withTransaction(async (client) => {
        const { rows: src } = await client.query<{ id: string }>(
          PRESENCE_SOURCE_UPSERT_SQL,
          [p.protocol, p.stable_handle],
        );
        // No row: the source exists and is live, or was switched off by
        // ingest for failing — neither is ours to touch.
        if (src.length === 0 || !fetch) return;
        await client.query(
          `SELECT graphile_worker.add_job(
             $2,
             json_build_object('sourceId', $1::text),
             job_key := 'feed_ingest_' || $1::text,
             max_attempts := $3
           )`,
          [src[0].id, fetch.task, fetch.maxAttempts],
        );
        tally.sourced++;
      });
    } catch (err) {
      tally.failed++;
      logger.warn({ err, presenceId: p.id }, "presence_sources_sync: source write failed");
    }
  }
}

export async function syncPresenceSources(): Promise<SyncTally> {
  const tally: SyncTally = { keyed: 0, unkeyed: 0, sourced: 0, blocked: 0, failed: 0 };
  await keyActivityPubPresences(tally);
  await ensurePresenceSources(tally);
  return tally;
}

export const presenceSourcesSync: Task = async () => {
  const tally = await syncPresenceSources();
  // Logged when something moved or failed. `unkeyed` and `blocked` are
  // steady states that would otherwise print every tick; they ride along.
  if (tally.keyed || tally.sourced || tally.failed) {
    logger.info(tally, "presence_sources_sync");
  }
};
