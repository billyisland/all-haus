import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// feed_items_reconcile — daily integrity check
//
// Detects and repairs drift between source tables and feed_items:
//   1. Published articles/notes with no feed_items row → INSERT
//   2. External items with no feed_items row → INSERT
//   3. feed_items pointing to deleted/missing sources → clean up
//
// Runs daily at 05:00 UTC. See docs/adr/UNIVERSAL-FEED-ADR.md §XV.7.
//
// Any non-zero count means a dual-write path leaked — transactional writes
// should keep feed_items in lockstep with the source tables. We log WARN
// (not INFO) with per-case counts so on-call sees *which* path regressed,
// rather than noticing only that "something" drifted.
// =============================================================================

// The two external-arm statements are exported so
// feed-items-author-name-integration.test.ts runs the task's own text.
//
// author_name is the item's own author name or NULL — NEVER the source's
// display_name and never a placeholder (migration 184, BYLINE-AND-PROVENANCE-ADR
// D9 ⟂). '' is absent, as in the mapper; NULLIF with no btrim so this agrees
// byte-for-byte with the ingesters' `authorName || null` — a repair pass that
// disagrees with the primary writer reports drift every night and repairs a
// row that re-ingest puts straight back. The avatar keeps its source fallback
// (the ADR's open Q2).
export const RECONCILE_EXTERNAL_INSERT_SQL = `
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      published_at,
      source_protocol, source_item_uri, source_id, media,
      is_reply
    )
    SELECT
      'external', ei.id,
      NULLIF(ei.author_name, ''),
      COALESCE(ei.author_avatar_url, xs.avatar_url),
      ei.title,
      LEFT(COALESCE(ei.content_text, ei.summary), 200),
      ei.published_at,
      ei.protocol::text,
      ei.source_item_uri,
      ei.source_id,
      ei.media,
      ei.source_reply_uri IS NOT NULL
    FROM external_items ei
    JOIN external_sources xs ON xs.id = ei.source_id
    WHERE ei.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.external_item_id = ei.id)
    ON CONFLICT DO NOTHING
`;

export const RECONCILE_EXTERNAL_DRIFT_SQL = `
    UPDATE feed_items fi SET
      title = ei.title,
      content_preview = LEFT(COALESCE(ei.content_text, ei.summary), 200),
      author_name = NULLIF(ei.author_name, ''),
      author_avatar = COALESCE(ei.author_avatar_url, xs.avatar_url)
    FROM external_items ei
    JOIN external_sources xs ON xs.id = ei.source_id
    WHERE fi.external_item_id = ei.id
      AND ei.deleted_at IS NULL
      AND fi.deleted_at IS NULL
      AND (
        fi.title IS DISTINCT FROM ei.title
        OR fi.content_preview IS DISTINCT FROM LEFT(COALESCE(ei.content_text, ei.summary), 200)
        OR fi.author_name IS DISTINCT FROM NULLIF(ei.author_name, '')
        OR fi.author_avatar IS DISTINCT FROM COALESCE(ei.author_avatar_url, xs.avatar_url)
      )
`;

export const feedItemsReconcile: Task = async (_payload, _helpers) => {
  // 1. Articles missing from feed_items
  const articlesResult = await pool.query(`
    INSERT INTO feed_items (
      item_type, article_id, author_id,
      author_name, author_avatar, author_username,
      title, content_preview, nostr_event_id,
      published_at, is_reply
    )
    SELECT
      'article', a.id, a.writer_id,
      COALESCE(acc.display_name, acc.username, 'Unknown'),
      acc.avatar_blossom_url,
      acc.username,
      a.title,
      LEFT(a.content_free, 200),
      a.nostr_event_id,
      a.published_at,
      FALSE
    FROM articles a
    JOIN accounts acc ON acc.id = a.writer_id
    WHERE a.published_at IS NOT NULL
      AND a.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.article_id = a.id)
    ON CONFLICT DO NOTHING
  `);
  const articlesInserted = articlesResult.rowCount ?? 0;

  // 2. Notes missing from feed_items
  const notesResult = await pool.query(`
    INSERT INTO feed_items (
      item_type, note_id, author_id,
      author_name, author_avatar, author_username,
      content_preview, nostr_event_id,
      published_at, is_reply
    )
    SELECT
      'note', n.id, n.author_id,
      COALESCE(acc.display_name, acc.username, 'Unknown'),
      acc.avatar_blossom_url,
      acc.username,
      LEFT(n.content, 200),
      n.nostr_event_id,
      n.published_at,
      n.reply_to_event_id IS NOT NULL
    FROM notes n
    JOIN accounts acc ON acc.id = n.author_id
    WHERE NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.note_id = n.id)
    ON CONFLICT DO NOTHING
  `);
  const notesInserted = notesResult.rowCount ?? 0;

  // 3. External items missing from feed_items (see RECONCILE_EXTERNAL_INSERT_SQL)
  const externalResult = await pool.query(RECONCILE_EXTERNAL_INSERT_SQL);
  const externalsInserted = externalResult.rowCount ?? 0;

  // 4. feed_items with soft-deleted articles that weren't caught
  const staleArticlesResult = await pool.query(`
    UPDATE feed_items fi SET deleted_at = now()
    FROM articles a
    WHERE fi.article_id = a.id
      AND a.deleted_at IS NOT NULL
      AND fi.deleted_at IS NULL
  `);
  const staleArticlesFixed = staleArticlesResult.rowCount ?? 0;

  // 5. feed_items for external items that were soft-deleted
  const staleExternalResult = await pool.query(`
    UPDATE feed_items fi SET deleted_at = now()
    FROM external_items ei
    WHERE fi.external_item_id = ei.id
      AND ei.deleted_at IS NOT NULL
      AND fi.deleted_at IS NULL
  `);
  const staleExternalsFixed = staleExternalResult.rowCount ?? 0;

  // 6–8. Repair denormalised field drift on rows that already exist. The
  // ON CONFLICT DO NOTHING inserts above close the "missing row" gap, but
  // if a title edit path ever misses its feed_items dual-write the row
  // stays present with a stale title — invisible to both existence checks.
  // These passes compare the denormalised column to the source-of-truth
  // and rewrite only the divergent rows.
  const articleDriftResult = await pool.query(`
    UPDATE feed_items fi SET
      title = a.title,
      content_preview = LEFT(a.content_free, 200)
    FROM articles a
    WHERE fi.article_id = a.id
      AND a.deleted_at IS NULL
      AND fi.deleted_at IS NULL
      AND (
        fi.title IS DISTINCT FROM a.title
        OR fi.content_preview IS DISTINCT FROM LEFT(a.content_free, 200)
      )
  `);
  const articleDriftFixed = articleDriftResult.rowCount ?? 0;

  const noteDriftResult = await pool.query(`
    UPDATE feed_items fi SET
      content_preview = LEFT(n.content, 200)
    FROM notes n
    WHERE fi.note_id = n.id
      AND fi.deleted_at IS NULL
      AND fi.content_preview IS DISTINCT FROM LEFT(n.content, 200)
  `);
  const noteDriftFixed = noteDriftResult.rowCount ?? 0;

  // (see RECONCILE_EXTERNAL_DRIFT_SQL)
  const externalDriftResult = await pool.query(RECONCILE_EXTERNAL_DRIFT_SQL);
  const externalDriftFixed = externalDriftResult.rowCount ?? 0;

  const anyDrift =
    articlesInserted +
    notesInserted +
    externalsInserted +
    staleArticlesFixed +
    staleExternalsFixed +
    articleDriftFixed +
    noteDriftFixed +
    externalDriftFixed;

  // Any non-zero case means a dual-write path leaked. Log at WARN so the
  // on-call dashboard surfaces it — reconcile existing at all is a safety
  // net, not a routine cleanup. Per-case counts point at which path.
  if (anyDrift > 0) {
    logger.warn(
      {
        articlesInserted,
        notesInserted,
        externalsInserted,
        staleArticlesFixed,
        staleExternalsFixed,
        articleDriftFixed,
        noteDriftFixed,
        externalDriftFixed,
        totalDrift: anyDrift,
      },
      "feed_items reconcile repaired dual-write drift",
    );
  }
};
