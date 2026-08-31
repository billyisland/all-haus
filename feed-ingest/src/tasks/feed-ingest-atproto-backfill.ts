import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  normaliseAtprotoPost,
  type BskyPostRecord,
} from "../adapters/atproto.js";
import { insertAtprotoItem } from "../lib/atproto-ingest.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// feed_ingest_atproto_backfill — one-time backfill for a new Bluesky source.
//
// The Jetstream listener only sees posts published after it picks up the DID
// on its next 60s DID-refresh poll. This task fetches recent history via the
// AppView's app.bsky.feed.getAuthorFeed and writes it into external_items +
// feed_items, so a fresh subscription has content immediately rather than
// appearing empty until the author posts again.
//
// Runs once per subscription (enqueued from the subscribe endpoint). Duplicate
// or re-run invocations are safe — the ON CONFLICT DO NOTHING in the ingest
// writer dedupes against anything the listener has already captured.
//
// Failure semantics (2026-07-09 audit F2): a fetch failure records the same
// error-count / backoff / deactivation accounting as the other protocols'
// tasks, then RE-THROWS. Unlike rss/activitypub/nostr — which recover via the
// 60s poll scheduler — atproto has no poll fallback while Jetstream is healthy
// (feed-ingest-poll.ts skips the protocol), so graphile-worker's retry
// (subscribe-time max_attempts, gateway sources.ts) is the only retry path.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";
const PAGE_LIMIT = 100;

// Fetch the actor's profile (handle + display name) from the public AppView.
// Used to enrich the source row so the Jetstream listener — whose live commits
// carry only the DID — always has a handle to attribute posts to. Returns null
// on any failure; enrichment then falls back to the first post's author.
async function fetchAtprotoProfile(
  actor: string,
): Promise<{ handle: string; displayName: string | null } | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.actor.getProfile`);
    url.searchParams.set("actor", actor);
    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as {
      handle?: unknown;
      displayName?: unknown;
    };
    if (typeof data.handle !== "string") return null;
    return {
      handle: data.handle,
      displayName:
        typeof data.displayName === "string" && data.displayName.trim() !== ""
          ? data.displayName
          : null,
    };
  } catch {
    return null;
  }
}

interface FeedViewPost {
  post: {
    uri: string;
    cid: string;
    author: {
      did: string;
      handle: string;
      displayName?: string;
      avatar?: string;
    };
    record: BskyPostRecord;
    indexedAt: string;
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
  };
  reason?: { $type: string }; // e.g. reasonRepost — skip these
}

interface AuthorFeedResponse {
  cursor?: string;
  feed: FeedViewPost[];
}

// The enrichment-failure marker written to external_sources.last_error when
// getProfile fails. The Jetstream listener's 60s self-heal keys on it (its
// enrichMissingHandles filter): a rename whose one-shot re-resolve failed
// transiently would otherwise be lost forever — the source keeps its OLD
// handle, so the NULL-handle heal never sees it (§0i.10). Keep string and
// filter in lockstep via this constant.
export const ATPROTO_ENRICH_FAILED_ERROR =
  "atproto handle enrichment failed (getProfile)";

export const feedIngestAtprotoBackfill: Task = async (payload, helpers) => {
  const { sourceId } = payload as { sourceId: string };

  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
    error_count: number;
  }>(
    `SELECT id, source_uri, handle, display_name, avatar_url, error_count
      FROM external_sources
      WHERE id = $1 AND protocol = 'atproto' AND is_active = TRUE`,
    [sourceId],
  );

  if (!source) {
    logger.warn(
      { sourceId },
      "atproto source not found for backfill — skipping",
    );
    return;
  }

  // Resolve and persist the account's handle + display name onto the source
  // row. The listener attributes live posts from this handle (its commits have
  // no profile inline), and it also repairs any historical items that were
  // ingested before the handle was known (the "EXTERNAL" byline bug). Best
  // effort — a fetch failure just leaves enrichment to a later run — but a
  // failure on a source that STILL has no handle is recorded on the source
  // (error_count/last_error) instead of being wiped by the completion UPDATE
  // below: that wipe made a permanently-unresolvable DID (deleted account)
  // look "healthy, fetched a minute ago" forever while the listener's 60s
  // self-heal re-enqueued this task unbounded (2026-07-06 audit residual).
  // The listener's enrichment filter backs off on error_count.
  const profile = await fetchAtprotoProfile(source.source_uri);
  const enrichmentFailed = !profile && (!source.handle || source.handle.trim() === "");
  if (profile) {
    source.handle = profile.handle;
    source.display_name = source.display_name ?? profile.displayName;
    await pool.query(
      `UPDATE external_sources
          SET handle = $2,
              display_name = COALESCE(NULLIF(display_name, ''), $3),
              updated_at = now()
        WHERE id = $1`,
      [sourceId, profile.handle, profile.displayName],
    );
    await repairAtprotoAuthors(
      sourceId,
      source.source_uri,
      profile.handle,
      profile.displayName,
    );
  }

  const config = await getPlatformConfig();
  const lookbackHours = parseInt(
    config.get("feed_ingest_atproto_backfill_hours") ?? "24",
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
  const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;

  let cursor: string | undefined;
  let inserted = 0;
  let seen = 0;
  // Hard cap on pages so a pathological actor can't trap the worker.
  const MAX_PAGES = 5;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed`);
      url.searchParams.set("actor", source.source_uri);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("filter", "posts_no_replies");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await safeFetch(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        // First page failing means zero history was fetched — that is a
        // failed backfill, not a short one; route it through the error
        // accounting below. A mid-pagination failure keeps what landed.
        if (page === 0)
          throw new Error(`getAuthorFeed HTTP ${res.status}`);
        logger.warn(
          { sourceId, status: res.status, page },
          "getAuthorFeed failed mid-pagination — keeping partial backfill",
        );
        break;
      }

      const data = JSON.parse(res.text) as AuthorFeedResponse;
      if (!data.feed || data.feed.length === 0) break;

      let reachedCutoff = false;
      for (const entry of data.feed) {
        seen++;
        // Skip reposts in backfill — they're handled via the listener's
        // real-time feed once we ingest repost records (future work).
        if (entry.reason) continue;
        const post = entry.post;
        if (!post?.record || post.record.$type !== "app.bsky.feed.post")
          continue;

        const publishedAt =
          Date.parse(post.record.createdAt) ||
          Date.parse(post.indexedAt) ||
          Date.now();
        if (publishedAt < cutoff) {
          reachedCutoff = true;
          continue;
        }

        const item = normaliseAtprotoPost({
          did: post.author.did,
          uri: post.uri,
          cid: post.cid,
          record: post.record,
          fallbackDate: new Date(publishedAt),
          author: {
            handle: post.author.handle,
            displayName: post.author.displayName,
          },
        });

        try {
          const didInsert = await withTransaction(async (client) => {
            return insertAtprotoItem(client, source, item, {
              likeCount: post.likeCount,
              replyCount: post.replyCount,
              repostCount: post.repostCount,
            });
          });
          if (didInsert) {
            inserted++;
            if (item.sourceReplyUri || item.sourceQuoteUri) {
              void helpers.addJob("external_parent_prefetch", {
                sourceReplyUri: item.sourceReplyUri,
                sourceQuoteUri: item.sourceQuoteUri,
                protocol: "atproto",
                sourceId: source.id,
              });
            }
          }
        } catch (err) {
          logger.warn(
            {
              sourceId,
              uri: post.uri,
              err: err instanceof Error ? err.message : String(err),
            },
            "atproto backfill insert failed",
          );
        }
      }

      if (reachedCutoff) break;
      if (!data.cursor) break;
      cursor = data.cursor;
    }

    // Bump last_fetched_at so the poll-fallback scheduler respects the
    // fetch_interval_seconds cadence when Jetstream is unhealthy. The
    // listener also updates this column on every real-time event, so a
    // healthy source stays "recent" without hitting this path. Error
    // accounting resets ONLY when enrichment isn't still failing — see above.
    if (enrichmentFailed) {
      await pool.query(
        `UPDATE external_sources
            SET last_fetched_at = now(),
                error_count = error_count + 1,
                last_error = $2,
                updated_at = now()
          WHERE id = $1`,
        [sourceId, ATPROTO_ENRICH_FAILED_ERROR],
      );
    } else {
      await pool.query(
        `
        UPDATE external_sources
        SET last_fetched_at = now(),
            error_count = 0,
            last_error = NULL,
            updated_at = now()
        WHERE id = $1
      `,
        [sourceId],
      );
    }

    if (inserted > 0 || seen > 0) {
      logger.info(
        { sourceId, inserted, seen, lookbackHours },
        "atproto backfill complete",
      );
    }
  } catch (err) {
    // Same error-count / backoff / deactivation accounting as the nostr
    // backfill and the poll tasks (audit F2) — a failed backfill must never
    // leave the source looking healthy (error_count 0, no last_error).
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
      "atproto backfill failed",
    );

    // Re-throw so graphile-worker retries (see the header note: the poll
    // scheduler never re-runs atproto while Jetstream is healthy, so the
    // job's own max_attempts is the only retry this backfill gets).
    throw err;
  }
};

// Heal historical rows that were ingested before the source's handle was known
// and so carry a null/empty author name+handle (the byline that renders as
// "EXTERNAL"). Every item under an atproto source is authored by that source's
// single account, so the resolved (handle, displayName) applies to all of them.
// Only fills gaps — never overwrites an already-populated name/handle.
async function repairAtprotoAuthors(
  sourceId: string,
  did: string,
  handle: string,
  displayName: string | null,
): Promise<void> {
  const name = displayName ?? `@${handle}`;
  try {
    await pool.query(
      `UPDATE external_items
          SET author_name   = COALESCE(NULLIF(author_name, ''), $2),
              author_handle = COALESCE(NULLIF(author_handle, ''), $3)
        WHERE source_id = $1
          AND protocol = 'atproto'
          AND (author_name IS NULL OR author_name = ''
               OR author_handle IS NULL OR author_handle = '')`,
      [sourceId, name, handle],
    );
    // external_authors (migration 099) is minted from the external_items author
    // fields and keyed by stable_handle = the DID; its null display_name/handle
    // is what the byline reads via the xa join, so heal it directly by DID.
    await pool.query(
      `UPDATE external_authors
          SET display_name = COALESCE(NULLIF(display_name, ''), $1),
              handle       = COALESCE(NULLIF(handle, ''), $2)
        WHERE protocol = 'atproto'
          AND stable_handle = $3
          AND (display_name IS NULL OR display_name = ''
               OR handle IS NULL OR handle = '')`,
      [name, handle, did],
    );
    // A Bluesky handle is MUTABLE; the DID is the stable identity. The gap-fill
    // above can only ever populate an empty handle, so a renamed account kept
    // its old @handle forever (§7.13). The DID key makes an overwrite safe —
    // this row IS that account — and post-mapper reads xa_handle ahead of the
    // per-item snapshot, so refreshing here updates every byline at once.
    // Scoped to `handle` deliberately: external_items.author_handle stays a
    // per-post historical snapshot, and display_name keeps its fill-only rule
    // (an account with no displayName resolves `name` to "@handle", which must
    // not overwrite a real stored name).
    await pool.query(
      `UPDATE external_authors
          SET handle = $1
        WHERE protocol = 'atproto'
          AND stable_handle = $2
          AND handle IS DISTINCT FROM $1`,
      [handle, did],
    );
    // feed_items carries its own denormalised author_name (legacy display path);
    // repair the "Bluesky user" / null placeholders for consistency.
    await pool.query(
      `UPDATE feed_items fi
          SET author_name = $2
         FROM external_items ei
        WHERE fi.external_item_id = ei.id
          AND ei.source_id = $1
          AND ei.protocol = 'atproto'
          AND (fi.author_name IS NULL OR fi.author_name = ''
               OR fi.author_name = 'Bluesky user')`,
      [sourceId, name],
    );
  } catch (err) {
    logger.warn(
      { sourceId, err: err instanceof Error ? err.message : String(err) },
      "atproto author repair failed",
    );
  }
}
