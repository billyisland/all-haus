import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { isSourceBlocked } from "@platform-pub/shared/lib/platform-blocks.js";
import { fetchRssFeed } from "../adapters/rss.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { recordServed } from "../lib/item-membership.js";

// =============================================================================
// feed_ingest_rss — per-source RSS fetch job
//
// Fetches a single RSS/Atom feed, normalises items, and upserts into
// external_items. Updates source metadata and polling state.
// =============================================================================

export interface IntervalBounds {
  min: number;
  max: number;
  up: number; // > 1 — applied when the fetch produced no new items
  down: number; // < 1 — applied when the fetch produced new items
}

const DEFAULT_INTERVAL = 300;

/**
 * Multiplicative adaptive polling interval (#3 / B5).
 *
 * A 304 / no-new-items fetch is the signal a feed is quiet → back off (multiply
 * by `up`). A fetch that produced new items is the signal it's active → poll
 * sooner (multiply by `down`). The result is clamped to [min, max]. The
 * conditional GET is already paid for; this capitalises on it instead of
 * resetting every source to a flat 300s.
 */
export function nextRssInterval(
  current: number | null | undefined,
  hadNewItems: boolean,
  bounds: IntervalBounds,
): number {
  const base = current && current > 0 ? current : DEFAULT_INTERVAL;
  const next = hadNewItems ? base * bounds.down : base * bounds.up;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(next)));
}

export interface ConditionalHeaders {
  etag: string | null;
  lastModified: string | null;
  /** True when a stored validator was deliberately dropped (§8.16). */
  suppressed: boolean;
}

/**
 * The conditional-GET validators to send for this source — §8.16.
 *
 * **Hold no items, send no validators.** A validator is a claim about the
 * ORIGIN's state ("has this changed since you last fetched it?"), and it is
 * only safe to act on while our half of that sentence still holds: that we
 * still HAVE what we fetched. `external_items_prune` deleted on
 * `external_items.created_at` — our insert date, not the item's publish date —
 * so a live but infrequently updated feed, whose whole current window predated
 * the retention period, lost its rows. (It now keeps anything a source served
 * within retention, which a 304 re-stamps — CA-G10b — but a source can still
 * come to hold nothing, and this guard is what stops that being silent.) And a
 * source whose every item was first written by ANOTHER source held nothing
 * under the old `source_id` probe (CA-C4) — it asks its memberships now. The
 * stored validator then makes every
 * later fetch a *correct* 304, and the source stays empty forever while
 * reporting perfect health: subscribed, active, `error_count` 0, `last_error`
 * NULL. Every component behaves properly and the member's feed is silent.
 *
 * Proven against a live origin on 2026-08-13 (a subscribed feed that had been
 * empty for about a fortnight): the stored ETag as `If-None-Match` returned 304 while the
 * stored date as `If-Modified-Since` returned 200 — the origin's Last-Modified
 * had moved while its ETag had not, a static rebuild that touched the file
 * without changing the content. The loop is therefore **ETag-pinned**, which is
 * why this drops BOTH validators: reasoning only about dates would not have
 * closed it.
 *
 * Dropping them makes the next fetch unconditional, the window comes back, and
 * conditional GETs resume by themselves on the fetch after that — self-healing,
 * no schema change, and free for a healthy source, which always holds items and
 * so never takes this branch.
 */
export function conditionalHeadersFor(
  cursor: string | null,
  holdsItems: boolean,
): ConditionalHeaders {
  let etag: string | null = null;
  let lastModified: string | null = null;
  if (cursor) {
    try {
      const parsed = JSON.parse(cursor);
      etag = parsed.etag ?? null;
      lastModified = parsed.lastModified ?? null;
    } catch {
      // Legacy or corrupt cursor — ignore
    }
  }
  if (!holdsItems && (etag || lastModified)) {
    return { etag: null, lastModified: null, suppressed: true };
  }
  return { etag, lastModified, suppressed: false };
}

/**
 * The source load, exported so its `holds_items` probe can be run against a
 * real Postgres rather than asserted against a mock that was told the answer.
 */
export const RSS_SOURCE_LOAD_SQL = `
  SELECT es.id, es.source_uri, es.cursor, es.error_count, es.display_name,
         es.fetch_interval_seconds,
         EXISTS (SELECT 1 FROM external_item_sources m WHERE m.source_id = es.id)
           AS holds_items
    FROM external_sources es
   WHERE es.id = $1
`;

/**
 * A 304's re-stamp (CA-G10b): the window the origin is still serving is the
 * one we last fetched, and every membership of it carries the one `now()` of
 * the transaction that fetched it (step 1c below) — so the newest stamp among
 * the source's own memberships IS that window. Per source, so a window shared
 * with another feed is found exactly (CA-C4: the stamp on the item could be
 * the other source's). Exported so the integration test runs this statement,
 * not a copy.
 */
export const RSS_WINDOW_RESEEN_SQL = `
  UPDATE external_item_sources SET last_seen_at = now()
   WHERE source_id = $1
     AND last_seen_at = (
       SELECT max(last_seen_at) FROM external_item_sources WHERE source_id = $1
     )
`;

export const feedIngestRss: Task = async (payload, _helpers) => {
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

  // Load source
  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    cursor: string | null;
    error_count: number;
    display_name: string | null;
    fetch_interval_seconds: number;
    holds_items: boolean;
  }>(
    // `holds_items` is an index probe on the membership's primary key, not a count —
    // it exists only to answer "do we still have what our cursor claims we
    // fetched?" (see conditionalHeadersFor).
    RSS_SOURCE_LOAD_SQL,
    [sourceId],
  );

  if (!source) {
    logger.warn({ sourceId }, "Source not found — skipping");
    return;
  }

  // Load config (process-cached, 30s TTL — A5)
  const config = await getPlatformConfig();
  const maxItems = parseInt(
    config.get("feed_ingest_max_items_per_fetch") ?? "50",
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
  // Multiplicative adaptive-interval bounds (#3 / B5). A quiet feed (304 /
  // no-new) backs off; an active feed (new items) tightens. Clamped to
  // [min, max] from platform_config.
  const intervalBounds: IntervalBounds = {
    min: parseInt(
      config.get("feed_ingest_rss_min_interval_seconds") ?? "60",
      10,
    ),
    max: parseInt(
      config.get("feed_ingest_rss_max_interval_seconds") ?? "3600",
      10,
    ),
    up: parseFloat(config.get("feed_ingest_rss_interval_backoff_factor") ?? "1.5"),
    down: parseFloat(config.get("feed_ingest_rss_interval_decay_factor") ?? "0.5"),
  };

  const { etag, lastModified, suppressed } = conditionalHeadersFor(
    source.cursor,
    source.holds_items,
  );
  if (suppressed) {
    // Worth a line: a source that keeps landing here holds a cursor and never
    // any items, which is a PARSE failure rather than a prune — and the loop
    // this guard breaks would otherwise hide that just as effectively.
    logger.info(
      { sourceId, sourceUri: source.source_uri },
      "Source holds no items — dropping conditional headers to force a full re-fetch",
    );
  }

  try {
    const result = await fetchRssFeed({
      feedUrl: source.source_uri,
      etag,
      lastModified,
    });

    if (result.notModified) {
      // Feed hasn't changed (304) — the definitive "quiet" signal; back off.
      // The origin is still serving the window we last fetched, so it is
      // still SEEN (CA-G10b) — or a quiet feed's items are pruned at
      // retention and re-inserted as new rows by the next full fetch.
      await pool.query(RSS_WINDOW_RESEEN_SQL, [sourceId]);
      await pool.query(
        `UPDATE external_sources SET last_fetched_at = now(), error_count = 0, last_error = NULL, fetch_interval_seconds = $2, updated_at = now() WHERE id = $1`,
        [sourceId, nextRssInterval(source.fetch_interval_seconds, false, intervalBounds)],
      );
      return;
    }

    // Insert items (capped at maxItems) — dual-write to external_items + feed_items.
    // Sort newest-first so first-poll truncation drops oldest history, not new
    // content, and dedupe within the fetch (one batched INSERT can't carry the
    // same conflict key twice cleanly). 50 items used to be 50 transactions /
    // ~100 statements; now it's two statements in one transaction (#2 / B1).
    const sortedItems = [...result.items].sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
    );
    const seenUris = new Set<string>();
    const items: typeof sortedItems = [];
    for (const item of sortedItems) {
      if (items.length >= maxItems) break;
      if (seenUris.has(item.sourceItemUri)) continue;
      seenUris.add(item.sourceItemUri);
      items.push(item);
    }

    let inserted = 0;
    let newlyServed = 0;
    if (items.length > 0) {
      ({ inserted, newlyServed } = await withTransaction(async (client) => {
        // 1. Multi-row external_items insert. sourceId is reused as $1; each
        //    item contributes 13 params. Conflicting rows return no id and are
        //    naturally absent from RETURNING.
        const eiParams: unknown[] = [sourceId];
        const eiRows = items.map((item) => {
          const b = eiParams.length;
          eiParams.push(
            item.sourceItemUri,
            item.canonicalUrl,
            // Byte for byte the feed_items expression below (S17) — the two
            // columns must agree or feed_items_author_refresh repairs a row
            // every night that re-ingest puts back.
            item.authorName || null,
            item.authorHandle,
            item.authorUri,
            item.contentText,
            item.contentHtml,
            item.summary,
            item.title,
            item.language,
            JSON.stringify(item.media),
            JSON.stringify(item.interactionData ?? {}),
            item.publishedAt,
          );
          return `($1, 'rss', 'tier4', $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13})`;
        });

        const { rows: insertedEi } = await client.query<{
          id: string;
          source_item_uri: string;
        }>(
          `
          INSERT INTO external_items (
            source_id, protocol, tier,
            source_item_uri, canonical_url,
            author_name, author_handle, author_uri,
            content_text, content_html, summary, title, language,
            media, interaction_data, published_at
          ) VALUES ${eiRows.join(", ")}
          ON CONFLICT (protocol, source_item_uri) DO NOTHING
          RETURNING id, source_item_uri
        `,
          eiParams,
        );

        // 1b. Gap-fill `canonical_url` on rows that already existed.
        //
        // The INSERT above is DO NOTHING, and it has to stay that way: the
        // dual-write below keys off RETURNING, so a DO UPDATE would hand it
        // every unchanged row in the feed window as if it were new. But a poll
        // re-offers the whole window every tick, permalink and all, so a
        // separate statement heals every row ingested before this column was
        // carried — which is the entire historical corpus of any feed whose
        // guid is not a URL, i.e. exactly the rows the reader cannot open.
        //
        // FILL ONLY, NEVER OVERWRITE (`canonical_url IS NULL`): the same
        // COALESCE gap-fill discipline the shared-source upsert keeps, so a
        // feed that later drops or mangles a link cannot take away a permalink
        // we already hold.
        const fillable = items.filter((it) => it.canonicalUrl !== null);
        if (fillable.length > 0) {
          const fillParams: unknown[] = [];
          const fillRows = fillable.map((it) => {
            const b = fillParams.length;
            fillParams.push(it.sourceItemUri, it.canonicalUrl);
            return `($${b + 1}, $${b + 2})`;
          });
          await client.query(
            `
            UPDATE external_items ei
               SET canonical_url = v.url
              FROM (VALUES ${fillRows.join(", ")}) AS v(uri, url)
             WHERE ei.protocol = 'rss'
               AND ei.source_item_uri = v.uri
               AND ei.canonical_url IS NULL
          `,
            fillParams,
          );
        }

        // 1c. THIS SOURCE SERVED THE WINDOW (CA-C4), and every item of it is
        //     SEEN now (CA-G10b). The membership is what puts an item in a feed
        //     built on this source — including one another source wrote first,
        //     which the insert above refused — and the prune keeps anything a
        //     source served within retention. Each source's last window carries
        //     ONE stamp, the fact RSS_WINDOW_RESEEN_SQL finds it by on a 304.
        //     `fresh` counts the items NEW TO THIS SOURCE, shared ones included:
        //     that, not the insert count, is whether anything arrived.
        const fresh = await recordServed(
          client,
          sourceId,
          "rss",
          items.map((it) => it.sourceItemUri),
        );

        if (insertedEi.length === 0) return { inserted: 0, newlyServed: fresh };

        // 2. Dual-write: one batched feed_items insert keyed off the returned
        //    ids. Rows that conflicted in step 1 are absent here, so they are
        //    skipped — never null-keyed.
        const itemByUri = new Map(items.map((it) => [it.sourceItemUri, it]));
        const fiParams: unknown[] = [sourceId];
        const fiRows: string[] = [];
        for (const ei of insertedEi) {
          const item = itemByUri.get(ei.source_item_uri);
          if (!item) continue;
          const b = fiParams.length;
          // The author's own name or NULL — never the source's (migration
          // 184, BYLINE-AND-PROVENANCE D9 ⟂). '' is absent, as in the mapper.
          fiParams.push(
            ei.id,
            item.authorName || null,
            item.title,
            truncatePreview(item.contentText),
            item.publishedAt,
            item.sourceItemUri,
            JSON.stringify(item.media),
          );
          fiRows.push(
            `('external', $${b + 1}, $${b + 2}, NULL, $${b + 3}, $${b + 4}, $${b + 5}, 'rss', $${b + 6}, $1, $${b + 7}, FALSE)`,
          );
        }

        if (fiRows.length > 0) {
          await client.query(
            `
            INSERT INTO feed_items (
              item_type, external_item_id,
              author_name, author_avatar,
              title, content_preview,
              published_at,
              source_protocol, source_item_uri, source_id, media,
              is_reply
            ) VALUES ${fiRows.join(", ")}
            ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
          `,
            fiParams,
          );
        }

        return { inserted: insertedEi.length, newlyServed: fresh };
      }));
    }

    // Update source: cursor, metadata, reset errors
    const newCursor = JSON.stringify({
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
    });

    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor = $2,
        display_name = COALESCE($3, display_name),
        description = COALESCE($4, description),
        avatar_url = COALESCE($6, avatar_url),
        error_count = 0,
        last_error = NULL,
        fetch_interval_seconds = $5,
        updated_at = now()
      WHERE id = $1
    `,
      [
        sourceId,
        newCursor,
        result.feedTitle ?? null,
        result.feedDescription ?? null,
        nextRssInterval(source.fetch_interval_seconds, newlyServed > 0, intervalBounds),
        result.feedImageUrl ?? null,
      ],
    );

    if (newlyServed > 0) {
      logger.info(
        { sourceId, inserted, newlyServed, total: result.items.length },
        "RSS items ingested",
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const newErrorCount = source.error_count + 1;
    const shouldDeactivate = newErrorCount >= maxErrors;

    // Exponential backoff on the polling interval
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

    if (shouldDeactivate) {
      logger.warn(
        { sourceId, errorCount: newErrorCount },
        "Source deactivated after too many errors",
      );
    } else {
      logger.warn(
        { sourceId, errorCount: newErrorCount, err: errorMessage },
        "RSS fetch failed",
      );
    }
  }
};
