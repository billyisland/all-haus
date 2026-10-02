import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { isSourceBlocked } from "@platform-pub/shared/lib/platform-blocks.js";
import {
  ApFetchStatusError,
  fetchActor,
  fetchMastodonTimeline,
  fetchOutbox,
} from "../adapters/activitypub.js";
import { isSignedFetchRefusal } from "@platform-pub/shared/lib/mastodon-api.js";
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
// newest item the previous poll PROCESSED — the adapter's cap keeps the oldest
// and the cursor is a resume point, never a high-water mark over what it
// dropped) or the cutoff. Updates source metadata + cursor on success; applies
// exponential backoff on failure; maintains per-instance success/failure
// counters so the admin UI can flag unreliable instances.
// =============================================================================

// Six hours. A source we cannot read for want of a signature is not going to
// become readable in five minutes, and it must not spin at the ordinary poll
// rate against an instance already refusing us — but it keeps a heartbeat, so
// the day signatures (or the instance's own setting) change it heals by
// itself. Deliberately not a dial: it is a property of the refusal, not tuning.
const UNSIGNABLE_RETRY_SECONDS = 6 * 60 * 60;

export const feedIngestActivityPub: Task = async (payload, helpers) => {
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

    // Which reader is the ACTOR's verdict, not a config choice: an instance in
    // secure mode (AUTHORIZED_FETCH) hands back no outbox to poll, and
    // `fetchActor` has already fallen back to its client API to say so.
    // The cap is the ADAPTER's: it keeps the OLDEST `maxItems` and hands back
    // the cursor of the newest item it kept, in its own id-space, so nothing
    // the walk saw falls past a cursor that claims it (CA-C1; the rule is
    // `planActivityPubBatch`'s header). A `.slice(0, maxItems)` here kept the
    // newest and left the rest in a gap no poll revisits.
    const { items, reposts, newCursor, deferred } =
      actor.reader === "mastodon_api" || !actor.outbox
        ? await fetchMastodonTimeline(actor, {
            cursor: source.cursor,
            cutoffMs,
            maxPages,
            itemsPerPage,
            maxItems,
          })
        : await fetchOutbox(actor, {
            outboxUrl: actor.outbox,
            cursor: source.cursor,
            cutoffMs,
            maxPages,
            itemsPerPage,
            maxItems,
          });

    // A PARTIAL OUTCOME IS NOT A TOTAL ONE (CA-C2). One item this loop cannot
    // write — a NUL in a title, which both `text` and `jsonb` refuse — is a
    // fact about that item. Let it escape and it reaches the outer catch as a
    // fact about the SOURCE: error_count + 1, backoff, cursor untouched, and
    // because the walk restarts at the top every poll the same item throws
    // every time until `maxErrors` sets is_active = FALSE. So each item is its
    // own unit: the failure is logged with the item's uri, COUNTED beside the
    // total, and the cursor still advances — the item was considered, and
    // holding the cursor for it spins the source on one window for ever.
    let inserted = 0;
    let skipped = 0;
    for (const item of items) {
      try {
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
      } catch (err) {
        skipped++;
        logger.warn(
          {
            sourceId: source.id,
            uri: item.sourceItemUri,
            err: err instanceof Error ? err.message : String(err),
          },
          "activitypub item skipped — insert or prefetch enqueue failed",
        );
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
        -- We just read it, so whatever we could not read it for is over.
        signed_fetch_refused_at = NULL,
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

    if (inserted > 0 || skipped > 0 || deferred > 0) {
      logger.info(
        { sourceId, host, inserted, skipped, deferred, seen: items.length },
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

    // A SIGNED-FETCH REFUSAL IS A FACT ABOUT US, NOT ABOUT THE SOURCE, SO IT
    // MUST NOT SPEND THE SOURCE'S LIFE.
    //
    // 401/403 here means the instance requires HTTP Signatures and the client
    // API could not stand in for the actor either — i.e. we cannot read this
    // account until the platform grows an instance actor. Counted as an
    // ordinary error it deactivates the member's follow at `maxErrors`, which
    // is what happened to 381 rows (every mastodon.social source) before the
    // fallback above existed: the member's feed went quiet, permanently,
    // because of a capability WE lack, and `is_active = FALSE` is not
    // something a later fix undoes by itself.
    //
    // So the error is recorded and the poll backs off hard — the source stays
    // ALIVE and starts working the day we can read it, with no migration and
    // nobody having to notice. The error budget still governs everything that
    // really is a fact about the source (404, malformed, unreachable).
    //
    // SINCE SIGNATURES, THIS MEANS MORE THAN IT DID. `fetchActor` and
    // `fetchOutbox` now escalate an unsigned refusal to a SIGNED request
    // before giving up, so a 401/403 arriving here has survived a signature as
    // well as the client-API fallback: the instance has blocked us, or it
    // cannot reach our actor document. Both are still facts about US.
    //
    // AND IT IS NOW COUNTED (migration 231). The state was real and invisible
    // — active source, on schedule, delivering nothing, for ever — which is
    // how the original 381-row deactivation went three months unnoticed.
    // `signed_fetch_refused_at` is what lets /admin/overview answer how much
    // of the fediverse we currently cannot read.
    const unsignable =
      err instanceof ApFetchStatusError && isSignedFetchRefusal(err.status);
    const deactivate = gone || (newErrorCount >= maxErrors && !unsignable);
    const backoff = unsignable
      ? UNSIGNABLE_RETRY_SECONDS
      : defaultInterval * Math.pow(backoffFac, Math.min(newErrorCount, 6));

    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at       = now(),
        error_count           = $2,
        last_error            = $3,
        is_active             = CASE WHEN $4 THEN FALSE ELSE is_active END,
        fetch_interval_seconds = $5,
        -- COALESCE keeps the date the current run of refusals STARTED; a poll
        -- that failed some other way clears it, because a source that has
        -- begun 404ing is no longer one we are locked out of and must not go
        -- on inflating the count.
        signed_fetch_refused_at = CASE
          WHEN $6 THEN COALESCE(signed_fetch_refused_at, now())
          ELSE NULL
        END,
        updated_at            = now()
      WHERE id = $1
    `,
      [
        sourceId,
        newErrorCount,
        msg,
        deactivate,
        Math.round(backoff),
        unsignable,
      ],
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
