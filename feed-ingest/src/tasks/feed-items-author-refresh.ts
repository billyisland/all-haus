import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// feed_items_author_refresh — daily metadata propagation
//
// Propagates changed author metadata from source tables to the denormalised
// feed_items columns. Six passes:
//   1. Native accounts → feed_items (display_name, avatar, username)
//   2. External sources → feed_items (display_name, avatar_url)
//   3. Native reply-parent author → feed_items.reply_to_author
//   4. External reply-parent author → feed_items.reply_to_author
//   5. Native reply-parent gone → feed_items.reply_to_author = NULL
//   6. External reply-parent gone → feed_items.reply_to_author = NULL
//
// Passes 3/4 fill late-arriving parents (a reply ingested before its parent has
// reply_to_author NULL until the parent lands) and track parent renames; 5/6 are
// their inverse, clearing a name whose parent has since been deleted or become
// unresolvable (§7.4 — without them a stale byline persists indefinitely). The
// feed_items_post_identity trigger resolves reply_to_author best-effort on INSERT;
// these passes are the maintainer (migration 105, audit C4 / #11).
//
// Up to 24 hours of staleness is acceptable per design.
// Runs daily at 04:00 UTC. See docs/adr/UNIVERSAL-FEED-ADR.md §V.2.
// =============================================================================

// Pass 2's SQL, exported so feed-items-author-name-integration.test.ts runs
// the task's own text rather than a copy of it.
//
// author_name is the item's own author name or NULL — NEVER the source's
// display_name (migration 184, BYLINE-AND-PROVENANCE-ADR D9 ⟂): on a
// multi-author feed that drops a dc:creator, the source-name fallback recorded
// the publication as the author. '' is absent, as in the mapper. NULLIF with no
// btrim, because the ingesters write `authorName || null` and this pass must
// agree with them byte-for-byte or it rewrites a row every night that re-ingest
// puts back. The avatar keeps its source fallback — that is the ADR's open Q2.
export const REFRESH_EXTERNAL_AUTHOR_SQL = `
    UPDATE feed_items fi SET
      author_name = NULLIF(ei.author_name, ''),
      author_avatar = COALESCE(ei.author_avatar_url, xs.avatar_url, fi.author_avatar)
    FROM external_items ei
    JOIN external_sources xs ON xs.id = ei.source_id
    WHERE fi.external_item_id = ei.id
      AND fi.deleted_at IS NULL
      AND (
        fi.author_name IS DISTINCT FROM NULLIF(ei.author_name, '')
        OR fi.author_avatar IS DISTINCT FROM COALESCE(ei.author_avatar_url, xs.avatar_url, fi.author_avatar)
      )
`

export const feedItemsAuthorRefresh: Task = async (_payload, _helpers) => {
  // 1. Refresh native author metadata (articles + notes)
  const nativeResult = await pool.query(`
    UPDATE feed_items fi SET
      author_name = COALESCE(acc.display_name, acc.username, 'Unknown'),
      author_avatar = acc.avatar_blossom_url,
      author_username = acc.username
    FROM accounts acc
    WHERE fi.author_id = acc.id
      AND fi.deleted_at IS NULL
      AND (
        fi.author_name IS DISTINCT FROM COALESCE(acc.display_name, acc.username, 'Unknown')
        OR fi.author_avatar IS DISTINCT FROM acc.avatar_blossom_url
        OR fi.author_username IS DISTINCT FROM acc.username
      )
  `)

  // 2. Refresh external author metadata (see REFRESH_EXTERNAL_AUTHOR_SQL)
  const externalResult = await pool.query(REFRESH_EXTERNAL_AUTHOR_SQL)

  // 3. Refresh native reply-parent author (display_name of the parent note's author)
  const nativeReplyResult = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = acc_p.display_name
    FROM notes n
    JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
    JOIN accounts acc_p ON acc_p.id = n_p.author_id
    WHERE fi.note_id = n.id
      AND fi.is_reply
      AND fi.deleted_at IS NULL
      AND fi.reply_to_author IS DISTINCT FROM acc_p.display_name
  `)

  // 4. Refresh external reply-parent author (author_handle of the parent item).
  //    Constrain on protocol so the parent lookup hits UNIQUE(protocol, source_item_uri).
  //    Origin-deleted parents (deleted_at set by kind-5 / Jetstream delete) are
  //    excluded — resolving from one would re-pin the very name pass 6 clears.
  const externalReplyResult = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = ei_p.author_handle
    FROM external_items ei
    JOIN external_items ei_p
      ON ei_p.protocol = ei.protocol
     AND ei_p.source_item_uri = ei.source_reply_uri
    WHERE fi.external_item_id = ei.id
      AND fi.is_reply
      AND fi.deleted_at IS NULL
      AND ei_p.deleted_at IS NULL
      AND fi.reply_to_author IS DISTINCT FROM ei_p.author_handle
  `)

  // 5/6. Re-NULL rows whose parent no longer resolves. Passes 3/4 are inner
  //      joins, so they can only ever WRITE a name — a parent that is deleted or
  //      becomes unreachable leaves its stale name pinned forever. NULL is the
  //      correct terminal state here: it is the same "parent not resolved" value
  //      the trigger writes for a reply whose parent hasn't landed, and the read
  //      path already renders it as no parent attribution.
  //
  //      Pass 5 mirrors pass 3's join chain EXACTLY (and the trigger's — there
  //      is no third resolution path), so "unresolvable" means the same thing
  //      on the way out as on the way in; pass 6 deliberately diverges from
  //      pass 4 (see its own comment: soft-deleted ⇒ clear, hard-pruned ⇒
  //      retain). Note a resolvable parent with a NULL display_name is NOT
  //      this case: pass 3 already NULLs that row.
  const nativeReplyCleared = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = NULL
    WHERE fi.is_reply
      AND fi.note_id IS NOT NULL
      AND fi.reply_to_author IS NOT NULL
      AND fi.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM notes n
        JOIN notes n_p ON n_p.nostr_event_id = n.reply_to_event_id
        JOIN accounts acc_p ON acc_p.id = n_p.author_id
        WHERE n.id = fi.note_id
      )
  `)

  //      External deletion is SOFT (kind-5 / Jetstream delete set deleted_at;
  //      nostr-ingest.ts), while a HARD-gone parent row means retention prune /
  //      context GC — storage management, the post likely still live at origin.
  //      So pass 6 deliberately does NOT mirror pass 5's absence test: it clears
  //      only on an origin-deleted parent (deleted_at set — "author deleted
  //      their post", the byline is genuinely stale) and RETAINS the last-known
  //      attribution when the row is merely pruned (clearing there would strip
  //      valid attributions wholesale once prune churn starts). Native stays
  //      absence-based: notes hard-DELETE on origin deletion, so for pass 5
  //      absence IS the origin-deletion signal.
  const externalReplyCleared = await pool.query(`
    UPDATE feed_items fi SET reply_to_author = NULL
    WHERE fi.is_reply
      AND fi.external_item_id IS NOT NULL
      AND fi.reply_to_author IS NOT NULL
      AND fi.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM external_items ei
        JOIN external_items ei_p
          ON ei_p.protocol = ei.protocol
         AND ei_p.source_item_uri = ei.source_reply_uri
        WHERE ei.id = fi.external_item_id
          AND ei_p.deleted_at IS NOT NULL
      )
  `)

  const nativeUpdated = nativeResult.rowCount ?? 0
  const externalUpdated = externalResult.rowCount ?? 0
  const nativeReplyUpdated = nativeReplyResult.rowCount ?? 0
  const externalReplyUpdated = externalReplyResult.rowCount ?? 0
  const nativeReplyNulled = nativeReplyCleared.rowCount ?? 0
  const externalReplyNulled = externalReplyCleared.rowCount ?? 0

  if (
    nativeUpdated > 0 ||
    externalUpdated > 0 ||
    nativeReplyUpdated > 0 ||
    externalReplyUpdated > 0 ||
    nativeReplyNulled > 0 ||
    externalReplyNulled > 0
  ) {
    logger.info(
      {
        nativeUpdated,
        externalUpdated,
        nativeReplyUpdated,
        externalReplyUpdated,
        nativeReplyNulled,
        externalReplyNulled,
      },
      'feed_items author metadata refreshed',
    )
  }
}
