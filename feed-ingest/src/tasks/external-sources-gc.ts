import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { presenceSourceSql } from '@platform-pub/shared/lib/presence-claim.js'

// =============================================================================
// external_sources_gc — daily garbage-collect orphaned external_sources rows
//
// A source is "orphaned" once no external_subscriptions rows point at it.
// Without cleanup, every churned subscription leaves a source behind that
// the feed_ingest_poll cron keeps fetching forever, burning budget and
// filling external_items with content nobody reads.
//
// Three phases:
//   0. Mark orphans: set orphaned_at = now() for sources with zero
//      subscribers and NULL orphaned_at. Covers the race where two
//      concurrent unsubscribes both see count > 0 and neither stamps
//      orphaned_at, as well as seeding pre-existing zero-sub sources.
//   A. Deactivate: is_active = FALSE for orphans past the grace window.
//      The poll cron skips is_active = FALSE rows, and a re-subscribe
//      flips it back via ON CONFLICT in POST /feeds/subscribe.
//   B. Cull: hard-delete sources still orphaned past the cull window.
//      external_items and feed_items cascade-delete via their FKs — after
//      any item another live source also serves is re-homed onto it
//      (GC_REHOME_SQL, CA-C4).
//
// Grace / cull windows come from platform_config, defaults 7 and 90 days.
//
// Three guards every phase carries, and more that only the cull needs
// (MIRROR-AUDIT §3 *Data integrity and ingest*, S17):
//
//   • feed_sources. An external_subscriptions row is a PROJECTION of feed
//     membership (UNIVERSAL-FEED-ADR; addSource/removeSource are its only
//     writers), so in a healthy database "no subscribers" and "in nobody's
//     feed" are the same fact and this guard is redundant. It is here for the
//     day they are not: feed_sources.external_source_id is ON DELETE CASCADE,
//     so a source the projection has lost track of would be culled out of a
//     member's feed with nothing raised anywhere — the feed simply stops
//     carrying it. CLAUDE.md warns that any external add path forgetting the
//     upsert "orphans an in-use source"; this is what stops that costing data.
//     It guards phase 0 as well as A and B: a drifted source must not even be
//     MARKED, or the grace window starts ticking on a live one.
//
//   • A member's own presence (CROSS-NETWORK-ROUNDTRIP-ADR D2). A linked
//     Bluesky DID or Mastodon actor is ingested because the member linked it,
//     so its source carries no external_subscriptions row — that row is a
//     projection of feed membership and must not be written for this — and
//     without the guard the GC would mark it on the next run, switch it off a
//     week later and cull the member's posts with it at 90 days. All three
//     phases, for the same reason as feed_sources.
//
//   • The reference guards on the cull, mirroring external_items_prune's
//     (M15). Culling CASCADEs to external_items, so every guard the prune
//     applies per ITEM has to be applied here per SOURCE or the cull is a way
//     around it: notes.external_parent_id (ON DELETE SET NULL — a native
//     reply's external parent, silently unhooked and the thread broken) and
//     votes.target_nostr_event_id (no FK at all — the vote survives pointing
//     at nothing). citation_edges was already spared, because there the FK has
//     no ON DELETE action and the violation wedged the whole batch; these two
//     fail SILENTLY instead, which is why nobody noticed they were missing.
// =============================================================================

// The three statements are EXPORTED so external-sources-gc-integration.test.ts
// runs the task's own text rather than a copy of it — the repo idiom
// (EXTERNAL_ITEMS_PRUNE_SQL, EXTERNAL_SOURCE_UPSERT_SQL). A guard tested
// against a transcription is a test of the transcription.
export const GC_MARK_SQL = `
    UPDATE external_sources
       SET orphaned_at = now()
     WHERE orphaned_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM feed_sources fs
          WHERE fs.external_source_id = external_sources.id
       )
       AND NOT ${presenceSourceSql('external_sources')}
  `

export const GC_DEACTIVATE_SQL = `
    UPDATE external_sources
       SET is_active = FALSE
     WHERE is_active = TRUE
       AND orphaned_at IS NOT NULL
       AND orphaned_at < now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM feed_sources fs
          WHERE fs.external_source_id = external_sources.id
       )
       AND NOT ${presenceSourceSql('external_sources')}
  `

// Before the cull: an item the doomed source HOMES but another live source
// also SERVES (CA-C4, external_item_sources) is re-homed onto that source, on
// both tables, so the cull's CASCADE does not take it out of the other
// source's feeds. The candidate set is the cull's own window (inactive,
// orphaned past the cull days) — a SUPERSET of what the cull deletes, since
// the cull's guards may yet spare a source; re-homing an item onto a live
// source that genuinely serves it is harmless either way. The newest serving
// source wins, then the lowest id, so a rerun picks the same one.
export const GC_REHOME_SQL = `
    WITH moves AS (
      SELECT DISTINCT ON (ei.id) ei.id AS item_id, m.source_id AS new_source
        FROM external_sources doomed
        JOIN external_items ei ON ei.source_id = doomed.id
        JOIN external_item_sources m
          ON m.external_item_id = ei.id AND m.source_id <> doomed.id
        JOIN external_sources s
          ON s.id = m.source_id AND s.orphaned_at IS NULL
       WHERE doomed.is_active = FALSE
         AND doomed.orphaned_at IS NOT NULL
         AND doomed.orphaned_at < now() - ($1 || ' days')::interval
       ORDER BY ei.id, m.last_seen_at DESC, m.source_id
    ),
    fi_moved AS (
      UPDATE feed_items f SET source_id = mv.new_source
        FROM moves mv
       WHERE f.external_item_id = mv.item_id
    )
    UPDATE external_items e SET source_id = mv.new_source
      FROM moves mv
     WHERE e.id = mv.item_id
  `

export const GC_CULL_SQL = `
    DELETE FROM external_sources
     WHERE is_active = FALSE
       AND orphaned_at IS NOT NULL
       AND orphaned_at < now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM feed_sources fs
          WHERE fs.external_source_id = external_sources.id
       )
       AND NOT ${presenceSourceSql('external_sources')}
       AND NOT EXISTS (
         SELECT 1 FROM external_identity_links l
          WHERE l.source_a_id = external_sources.id
             OR l.source_b_id = external_sources.id
       )
       -- Culling a source CASCADEs to its external_items; if one of those items
       -- is cited by a citation_edge (source_external_item_id FK has no ON DELETE
       -- action), the cascade hits a RESTRICT violation and fails the whole
       -- batch — nothing culled ever again (M15 wedge). Spare such a source.
       AND NOT EXISTS (
         SELECT 1 FROM external_items ei
           JOIN citation_edges ce ON ce.source_external_item_id = ei.id
          WHERE ei.source_id = external_sources.id
       )
       -- A native reply's external parent (notes.external_parent_id, ON DELETE
       -- SET NULL). The cascade would not fail — it would silently unhook the
       -- reply and break the thread, which is M15's first defect reached
       -- through the source instead of the item.
       AND NOT EXISTS (
         SELECT 1 FROM external_items ei
           JOIN notes n ON n.external_parent_id = ei.id
          WHERE ei.source_id = external_sources.id
       )
       -- A vote's target. votes.target_nostr_event_id holds the item id as
       -- text and carries no FK, so the cascade leaves the vote pointing at a
       -- row that no longer exists.
       AND NOT EXISTS (
         SELECT 1 FROM external_items ei
           JOIN votes v ON v.target_nostr_event_id = ei.id::text
          WHERE ei.source_id = external_sources.id
       )
       -- A notification's target (migration 236, ON DELETE CASCADE). The
       -- linked-notification poller anchors each reply on its author's SHADOW
       -- source — exactly the inactive, orphaned row this cull is for — so
       -- without this guard every such notification would vanish at 90 days.
       AND NOT EXISTS (
         SELECT 1 FROM external_items ei
           JOIN notifications nt ON nt.external_item_id = ei.id
          WHERE ei.source_id = external_sources.id
       )
  `

export const externalSourcesGc: Task = async (_payload, _helpers) => {
  const { rows: configRows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config
     WHERE key IN ('external_sources_gc_grace_days', 'external_sources_gc_cull_days')`
  )
  const config = new Map(configRows.map(r => [r.key, r.value]))
  const graceDays = Math.max(1, parseInt(config.get('external_sources_gc_grace_days') ?? '7', 10) || 7)
  const cullDays = Math.max(graceDays, parseInt(config.get('external_sources_gc_cull_days') ?? '90', 10) || 90)

  // Phase 0 — mark newly-orphaned sources.
  const marked = await pool.query(GC_MARK_SQL)

  // Phase A — deactivate orphans past the grace window.
  const deactivated = await pool.query(GC_DEACTIVATE_SQL, [graceDays])

  // Phase B — hard-delete orphans past the cull window. A source referenced by
  // a cross-source identity link (Slice 8) is in use even with no subscription —
  // it may be a link-only target the asserter pasted but doesn't follow — and a
  // cull here would CASCADE-delete the link. So spare any linked source; it's
  // still deactivated (Phase A), just never hard-deleted while a link survives.
  // First hand any item another live source also serves over to that source,
  // or the CASCADE takes it out of that source's feeds too (CA-C4).
  const rehomed = await pool.query(GC_REHOME_SQL, [cullDays])
  const deleted = await pool.query(GC_CULL_SQL, [cullDays])

  if ((marked.rowCount ?? 0) > 0 || (deactivated.rowCount ?? 0) > 0 || (rehomed.rowCount ?? 0) > 0 || (deleted.rowCount ?? 0) > 0) {
    logger.info(
      {
        marked: marked.rowCount ?? 0,
        deactivated: deactivated.rowCount ?? 0,
        rehomed: rehomed.rowCount ?? 0,
        deleted: deleted.rowCount ?? 0,
        graceDays,
        cullDays,
      },
      'external_sources_gc'
    )
  }
}
