import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  ApFetchStatusError,
  fetchActor,
  fetchOutbox,
} from "../adapters/activitypub.js";
import {
  insertActivityPubItem,
  recordInstanceSuccess,
  recordInstanceFailure,
} from "../lib/activitypub-ingest.js";
import { recordRepostEdge } from "../lib/repost-edge.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// feed_ingest_activitypub — per-source Mastodon outbox poll.
//
// Fetches the actor's outbox newest-first, stops at the cursor (id of the
// previous newest item) or the cutoff. Updates source metadata + cursor on
// success; applies exponential backoff on failure; maintains per-instance
// success/failure counters so the admin UI can flag unreliable instances.
// =============================================================================

export const feedIngestActivityPub: Task = async (payload, helpers) => {
  const { sourceId } = payload as { sourceId: string };

  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    cursor: string | null;
    error_count: number;
    display_name: string | null;
    avatar_url: string | null;
  }>(
    `
    SELECT id, source_uri, cursor, error_count, display_name, avatar_url
    FROM external_sources
    WHERE id = $1 AND protocol = 'activitypub' AND is_active = TRUE
  `,
    [sourceId],
  );

  if (!source) {
    logger.warn({ sourceId }, "activitypub source not found — skipping");
    return;
  }

  // Config (process-cached, 30s TTL — A5)
  const cfg = await getPlatformConfig();
  const maxItems = parseInt(
    cfg.get("feed_ingest_max_items_per_fetch") ?? "50",
    10,
  );
  const maxErrors = parseInt(
    cfg.get("feed_ingest_max_error_count") ?? "10",
    10,
  );
  const backoffFac = parseInt(
    cfg.get("feed_ingest_error_backoff_factor") ?? "2",
    10,
  );
  const maxPages = parseInt(cfg.get("feed_ingest_ap_page_limit") ?? "20", 10);
  const itemsPerPage = parseInt(
    cfg.get("feed_ingest_ap_items_per_page") ?? "20",
    10,
  );
  const backfillHrs = parseInt(
    cfg.get("feed_ingest_ap_backfill_hours") ?? "24",
    10,
  );
  const defaultInterval = parseInt(
    cfg.get("feed_ingest_ap_default_interval") ?? "300",
    10,
  );

  // First-time poll (no cursor) only looks back `backfillHrs`; steady-state
  // polls use a generous cutoff so we never miss items that straddled the
  // previous run.
  const cutoffMs = source.cursor
    ? Date.now() - 7 * 24 * 60 * 60 * 1000
    : Date.now() - backfillHrs * 60 * 60 * 1000;

  let host: string;
  try {
    host = new URL(source.source_uri).hostname;
  } catch {
    host = source.source_uri;
  }

  try {
    const actor = await fetchActor(source.source_uri);

    const { items, reposts, newCursor } = await fetchOutbox(actor, {
      outboxUrl: actor.outbox,
      cursor: source.cursor,
      cutoffMs,
      maxPages,
      itemsPerPage,
    });

    let inserted = 0;
    for (const item of items.slice(0, maxItems)) {
      const didInsert = await withTransaction(async (client) => {
        return insertActivityPubItem(client, source, item);
      });
      if (didInsert) {
        inserted++;
        if (item.sourceReplyUri || item.sourceQuoteUri) {
          await helpers.addJob("external_parent_prefetch", {
            sourceReplyUri: item.sourceReplyUri,
            sourceQuoteUri: item.sourceQuoteUri,
            protocol: "activitypub",
            sourceId: source.id,
          });
        }
      }
    }

    // Record Announce boosts as repost edges (UNIVERSAL-POST §2.2): a boost has
    // no body, so it is an edge to the boosted THING, not a THING of its own.
    for (const repost of reposts) {
      try {
        await withTransaction(async (client) =>
          recordRepostEdge(client, repost),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { sourceId: source.id, originUri: repost.originUri, err: msg },
          "Failed to record ActivityPub repost edge",
        );
      }
    }

    // Reset error state, refresh metadata, advance cursor (only if we have
    // a new newest — an empty outbox leaves the existing cursor intact).
    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor          = COALESCE($2, cursor),
        display_name    = COALESCE($3, display_name),
        description     = COALESCE($4, description),
        avatar_url      = COALESCE($5, avatar_url),
        fetch_interval_seconds = $6,
        error_count     = 0,
        last_error      = NULL,
        updated_at      = now()
      WHERE id = $1
    `,
      [
        sourceId,
        newCursor,
        actor.name,
        actor.summary,
        actor.icon,
        defaultInterval,
      ],
    );

    await withTransaction(async (client) =>
      recordInstanceSuccess(client, host),
    );

    if (inserted > 0) {
      logger.info(
        { sourceId, host, inserted, seen: items.length },
        "activitypub outbox ingested",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const newErrorCount = source.error_count + 1;
    // HTTP 410 Gone is the fediverse's account-deletion tombstone — permanent,
    // so deactivate immediately (no point burning the error budget) and stamp
    // the author-level tombstone the known-world discovery index reads
    // (RESOLVER-DISCOVERY-ADR §8.3; migration 151). AP stable_handle is the
    // actor URI, i.e. this source's source_uri.
    const gone = err instanceof ApFetchStatusError && err.status === 410;
    const deactivate = gone || newErrorCount >= maxErrors;
    const backoff =
      defaultInterval * Math.pow(backoffFac, Math.min(newErrorCount, 6));

    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at       = now(),
        error_count           = $2,
        last_error            = $3,
        is_active             = CASE WHEN $4 THEN FALSE ELSE is_active END,
        fetch_interval_seconds = $5,
        updated_at            = now()
      WHERE id = $1
    `,
      [sourceId, newErrorCount, msg, deactivate, Math.round(backoff)],
    );

    if (gone) {
      await pool.query(
        `UPDATE external_authors SET deleted_at = COALESCE(deleted_at, now())
          WHERE protocol = 'activitypub' AND stable_handle = $1`,
        [source.source_uri],
      );
    }

    await withTransaction(async (client) =>
      recordInstanceFailure(client, host, msg),
    );

    if (deactivate) {
      logger.warn(
        { sourceId, host, errorCount: newErrorCount },
        "activitypub source deactivated",
      );
    } else {
      logger.warn(
        { sourceId, host, errorCount: newErrorCount, err: msg },
        "activitypub fetch failed",
      );
    }
  }
};
