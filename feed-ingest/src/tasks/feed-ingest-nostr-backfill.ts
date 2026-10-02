import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { isSourceBlocked } from "@platform-pub/shared/lib/platform-blocks.js";
import {
  pinnedWebSocketOptions,
  type PinnedWebSocketOptions,
} from "@platform-pub/shared/lib/http-client.js";
import { recordRepostEdge } from "../lib/repost-edge.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { mergeNostrRelayUrls } from "@platform-pub/shared/lib/nip65.js";
import {
  NOSTR_FALLBACK_RELAYS,
  fetchNostrWriteRelays,
} from "@platform-pub/shared/lib/nostr-relay-req.js";
import {
  type NostrEvent,
  type Queryable,
  validateNostrEvents,
  insertNostrItem,
  applyNostrDeletions,
  detectNostrRepost,
  nostrNip05,
  nostrProfileUpdate,
  fetchNostrRelayEvents,
} from "../lib/nostr-ingest.js";

// =============================================================================
// feed_ingest_nostr_backfill — one-shot historical backfill for a newly
// subscribed nostr_external source (EXTERNAL-AUTHOR-HISTORY-ADR §2).
//
// Twin of feed_ingest_atproto_backfill in role, enqueue point and idempotency
// posture: enqueued once from the subscribe endpoint (under the DISTINCT job
// key feed_ingest_backfill_<sourceId> — the poll scheduler's
// feed_ingest_<sourceId> key would job-key-replace a still-queued backfill
// with a plain poll job, §2.1), safe to re-run (every write is the shared
// (protocol, source_item_uri) ratchet upsert), steady state owned by the 60s
// poll job thereafter.
//
// Nostr REQ has no server cursor, so it pages BACKWARDS with `until`, stopping
// on the lookback cutoff (feed_ingest_nostr_backfill_hours, default 168h),
// an empty/undersized page, MAX_PAGES, or the total-accepted item cap. The
// relay set is NIP-65-first (§2.2): the author's kind-10002 write relays are
// discovered over the source hints + fallbacks, merged ahead of them, and
// persisted onto external_sources.relay_urls so every subsequent poll also
// queries relays that actually carry the author.
// =============================================================================

export const NOSTR_BACKFILL_PAGE_LIMIT = 100;
export const NOSTR_BACKFILL_MAX_PAGES = 5;
export const NOSTR_BACKFILL_MAX_ITEMS = 200;
// Match NOSTR_THREAD_RELAY_CAP (gateway external-hydration) per §2.2.
export const NOSTR_BACKFILL_RELAY_CAP = 6;
// Never let discovered relays push out user-supplied entries (§2.2 step 3).
export const NOSTR_RELAY_PERSIST_CAP = 10;

// Query set: author write relays first (most likely to carry the history),
// then the source's own hints, then the high-coverage fallbacks. Deduped,
// scheme-checked, capped.
export function buildBackfillRelaySet(
  writeRelays: string[],
  sourceRelays: string[],
): string[] {
  return [...new Set([...writeRelays, ...sourceRelays, ...NOSTR_FALLBACK_RELAYS])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, NOSTR_BACKFILL_RELAY_CAP);
}

// Persistence union for external_sources.relay_urls: existing entries first
// (user-supplied relays are never dropped), discovered write relays appended,
// deduped, capped at 10. Rule lives in shared/ (the gateway's profile-view
// hydration applies the same union to shadow sources).
export function mergeRelayUrls(
  existing: string[],
  discovered: string[],
): string[] {
  return mergeNostrRelayUrls(existing, discovered, NOSTR_RELAY_PERSIST_CAP);
}

export interface CollectedBackfill {
  items: NostrEvent[]; // THING kinds (1, 30023) inside the window
  deletions: NostrEvent[]; // kind 5
  reposts: NostrEvent[]; // kind 6 / 16
  latestProfile: NostrEvent | null; // newest kind 0 (first page only)
  newestCreatedAt: number; // newest accepted created_at (0 ⇒ nothing)
  pagesFetched: number;
}

// The `until` pager (§2.3), separated from relay IO so it is unit-testable:
// fetchPage receives the filter array for one REQ round (already the merged +
// validated events across the relay set) and the pager owns descent and the
// stop conditions. The first page's REQ also carries the poll job's kind-0
// filter so the source's display metadata is fresh at subscribe time.
export async function collectNostrBackfill(
  pubkey: string,
  fetchPage: (filters: Record<string, unknown>[]) => Promise<NostrEvent[]>,
  opts: { nowSecs: number; cutoffSecs: number },
): Promise<CollectedBackfill> {
  const items = new Map<string, NostrEvent>();
  const deletions = new Map<string, NostrEvent>();
  const reposts = new Map<string, NostrEvent>();
  let latestProfile: NostrEvent | null = null;
  let newestCreatedAt = 0;
  let accepted = 0;
  let until = opts.nowSecs;
  let pagesFetched = 0;

  for (let page = 0; page < NOSTR_BACKFILL_MAX_PAGES; page++) {
    const filters: Record<string, unknown>[] = [
      {
        // Same kind set as the poll job: 1 note, 5 deletion, 30023 long-form
        // (THINGs); 6/16 reposts (edges).
        kinds: [1, 5, 6, 16, 30023],
        authors: [pubkey],
        until,
        limit: NOSTR_BACKFILL_PAGE_LIMIT,
      },
    ];
    if (page === 0) {
      filters.push({ kinds: [0], authors: [pubkey], limit: 1 });
    }

    const events = await fetchPage(filters);
    pagesFetched++;

    let oldest = Infinity;
    let reachedCutoff = false;
    let pageCount = 0;
    for (const event of events) {
      if (event.kind === 0) {
        if (!latestProfile || event.created_at > latestProfile.created_at) {
          latestProfile = event;
        }
        continue; // profile events don't page
      }
      pageCount++;
      if (event.created_at < oldest) oldest = event.created_at;
      if (event.created_at < opts.cutoffSecs) {
        reachedCutoff = true;
        continue;
      }
      if (event.kind === 5) {
        deletions.set(event.id, event);
      } else if (event.kind === 6 || event.kind === 16) {
        if (!reposts.has(event.id)) {
          reposts.set(event.id, event);
          accepted++;
        }
      } else {
        if (!items.has(event.id)) {
          items.set(event.id, event);
          accepted++;
        }
      }
      if (event.created_at > newestCreatedAt) newestCreatedAt = event.created_at;
    }

    if (pageCount === 0) break; // empty page — history exhausted
    if (reachedCutoff) break; // window covered
    if (accepted >= NOSTR_BACKFILL_MAX_ITEMS) break; // chatty-account cap
    if (pageCount < NOSTR_BACKFILL_PAGE_LIMIT) break; // undersized — no more
    until = oldest - 1;
  }

  return {
    items: [...items.values()],
    deletions: [...deletions.values()],
    reposts: [...reposts.values()],
    latestProfile,
    newestCreatedAt,
    pagesFetched,
  };
}

// Cursor handoff (§2.4): advance external_sources.cursor to the newest
// created_at seen — only FORWARD, guarding against a concurrently completed
// poll job that already moved it further. Also stamps last_fetched_at and
// resets error accounting, plus the metadata ratchet fields.
export async function completeBackfillSource(
  db: Queryable,
  sourceId: string,
  newestCreatedAt: number,
  profile: {
    profileName: string | null;
    profileAvatar: string | null;
    profileCreatedAt: number | null;
  },
): Promise<void> {
  await db.query(
    `
    UPDATE external_sources SET
      last_fetched_at = now(),
      cursor = CASE
        WHEN $2::bigint IS NOT NULL
         AND (cursor IS NULL OR cursor::bigint < $2::bigint)
        THEN $2::text
        ELSE cursor
      END,
      error_count = 0,
      last_error = NULL,
      -- Reset the poll interval to the base on a successful backfill (M18) — a
      -- source that recovered here must not stay on a backed-off interval.
      fetch_interval_seconds = 300,
      display_name = COALESCE($3, display_name),
      avatar_url = COALESCE($4, avatar_url),
      metadata_updated_at = CASE
        WHEN $5::bigint IS NOT NULL THEN to_timestamp($5::bigint)
        ELSE metadata_updated_at
      END,
      updated_at = now()
    WHERE id = $1
  `,
    [
      sourceId,
      newestCreatedAt > 0 ? newestCreatedAt : null,
      profile.profileName,
      profile.profileAvatar,
      profile.profileCreatedAt,
    ],
  );
}

export const feedIngestNostrBackfill: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string };
  // THE OPERATOR'S REFUSAL (L6.5, D7 §7). Checked per fetch rather than only at
  // the poll selector, because a job can be enqueued from several places (the
  // poll, a re-add, a backfill) and the guard has to sit where the work
  // actually happens. One indexed lookup against an HTTP fetch we are about to
  // spend.
  if (await isSourceBlocked(sourceId)) {
    logger.info({ sourceId }, "Source is blocked platform-wide — skipping fetch");
    return;
  }

  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    relay_urls: string[] | null;
    error_count: number;
    display_name: string | null;
    avatar_url: string | null;
    metadata_updated_at: Date | null;
  }>(
    `SELECT id, source_uri, relay_urls, error_count, display_name, avatar_url, metadata_updated_at
      FROM external_sources
      WHERE id = $1 AND protocol = 'nostr_external' AND is_active = TRUE`,
    [sourceId],
  );

  if (!source) {
    logger.warn({ sourceId }, "Nostr source not found for backfill — skipping");
    return;
  }

  const pubkey = source.source_uri;
  const sourceRelays = source.relay_urls ?? [];

  const config = await getPlatformConfig();
  const lookbackHours = parseInt(
    config.get("feed_ingest_nostr_backfill_hours") ?? "168",
    10,
  );
  const maxErrors = parseInt(
    config.get("feed_ingest_max_error_count") ?? "10",
    10,
  );
  const backoffFactor = parseInt(
    config.get("feed_ingest_error_backoff_factor") ?? "2",
    10,
  );

  try {
    // §2.2 — NIP-65 first: discover the author's write relays over the source
    // hints + fallbacks, and persist them (union, user entries first, cap 10)
    // so every subsequent poll also queries relays that carry the author. This
    // is the first place NIP-65 becomes load-bearing for ingest.
    const writeRelays = await fetchNostrWriteRelays(pubkey, sourceRelays);
    if (writeRelays.length > 0) {
      const merged = mergeRelayUrls(sourceRelays, writeRelays);
      if (
        merged.length !== sourceRelays.length ||
        merged.some((r, i) => r !== sourceRelays[i])
      ) {
        await pool.query(
          `UPDATE external_sources SET relay_urls = $2, updated_at = now()
            WHERE id = $1`,
          [sourceId, merged],
        );
      }
    }

    const relays = buildBackfillRelaySet(writeRelays, sourceRelays);

    // Resolve each relay's pinned options once, up front (SSRF invariant).
    const opened = (
      await Promise.all(
        relays.map(async (url) => {
          try {
            return { url, opts: await pinnedWebSocketOptions(url) };
          } catch {
            return null; // unresolvable / blocked host
          }
        }),
      )
    ).filter((r): r is { url: string; opts: PinnedWebSocketOptions } => !!r);

    if (opened.length === 0) {
      throw new Error("No reachable relays for nostr backfill");
    }

    // One page = one REQ against every relay, merged + deduped + validated.
    const fetchPage = async (
      filters: Record<string, unknown>[],
    ): Promise<NostrEvent[]> => {
      const perRelay = await Promise.all(
        opened.map(({ url, opts }) =>
          fetchNostrRelayEvents(url, filters, opts).catch((err) => {
            logger.warn(
              {
                sourceId,
                relayUrl: url,
                err: err instanceof Error ? err.message : String(err),
              },
              "Nostr backfill relay fetch failed — continuing without it",
            );
            return [] as NostrEvent[];
          }),
        ),
      );
      const byId = new Map<string, NostrEvent>();
      for (const evs of perRelay) {
        for (const ev of evs) {
          if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev);
        }
      }
      const validated = await validateNostrEvents([...byId.values()], pubkey, {
        sourceId,
        task: "feed_ingest_nostr_backfill",
      });
      return validated.filter((e): e is NostrEvent => e !== null);
    };

    const nowSecs = Math.floor(Date.now() / 1000);
    const collected = await collectNostrBackfill(pubkey, fetchPage, {
      nowSecs,
      cutoffSecs: nowSecs - lookbackHours * 60 * 60,
    });

    const sourceNip05 = nostrNip05(collected.latestProfile);

    // Writes go through the SAME ratchet writer as the poll job (§4.3), so
    // identity encoding is byte-identical (C1) and re-runs / a concurrently
    // running poll are idempotent.
    let inserted = 0;
    let updated = 0;
    for (const event of collected.items) {
      const outcome = await withTransaction(async (client) =>
        insertNostrItem(client, source, event, {
          relays,
          sourceNip05,
        }),
      );
      if (outcome === "inserted") inserted++;
      else if (outcome === "updated") updated++;
    }

    // Kind 6/16 → repost edges, same as the poll path.
    let repostEdges = 0;
    for (const event of collected.reposts) {
      const repost = detectNostrRepost(event);
      if (!repost) continue;
      try {
        const created = await withTransaction(async (client) =>
          recordRepostEdge(client, repost),
        );
        if (created) repostEdges++;
      } catch (err) {
        logger.warn(
          {
            sourceId,
            eventId: event.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to record nostr repost edge (backfill)",
        );
      }
    }

    // Kind 5s within the window — applied AFTER the item writes so we don't
    // backfill posts their author has deleted.
    await applyNostrDeletions(pool, sourceId, collected.deletions, pubkey);

    // Metadata ratchet + forward-only cursor handoff (§2.4).
    const profileUpdate = nostrProfileUpdate(
      collected.latestProfile,
      source.metadata_updated_at,
    );
    await completeBackfillSource(
      pool,
      sourceId,
      collected.newestCreatedAt,
      profileUpdate,
    );

    // Author-level deletion tombstone (RESOLVER-DISCOVERY-ADR §8.3, migration
    // 151) — mirrored from the poll task. The backfill advances the metadata
    // ratchet, so if it swallows a deleted:true kind-0 without stamping here,
    // the poll would never see it as "newer" and the tombstone would be lost.
    if (profileUpdate.profileDeleted !== null) {
      await pool.query(
        `UPDATE external_authors
            SET deleted_at = CASE
              WHEN $2 THEN COALESCE(deleted_at, now())
              ELSE NULL
            END
          WHERE protocol = 'nostr_external' AND stable_handle = $1`,
        [pubkey, profileUpdate.profileDeleted],
      );
    }

    logger.info(
      {
        sourceId,
        inserted,
        updated,
        repostEdges,
        deletions: collected.deletions.length,
        pages: collected.pagesFetched,
        relays: relays.length,
        nip65Relays: writeRelays.length,
        lookbackHours,
      },
      "Nostr backfill complete",
    );
  } catch (err) {
    // Same error-count / backoff accounting as the poll job.
    const errorMessage = err instanceof Error ? err.message : String(err);
    const newErrorCount = source.error_count + 1;
    const shouldDeactivate = newErrorCount >= maxErrors;
    const backoffInterval =
      300 * Math.pow(backoffFactor, Math.min(newErrorCount, 6));

    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at = now(),
        error_count = $2,
        last_error = $3,
        is_active = CASE WHEN $4 THEN FALSE ELSE is_active END,
        fetch_interval_seconds = $5,
        updated_at = now()
      WHERE id = $1
    `,
      [
        sourceId,
        newErrorCount,
        errorMessage.slice(0, 1000),
        shouldDeactivate,
        Math.round(backoffInterval),
      ],
    );

    logger.warn(
      { sourceId, errorCount: newErrorCount, err: errorMessage },
      "Nostr backfill failed",
    );
  }
};
