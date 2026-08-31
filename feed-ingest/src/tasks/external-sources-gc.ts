import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

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
//      external_items and feed_items cascade-delete via their FKs.
//
// Grace / cull windows come from platform_config, defaults 7 and 90 days.
// =============================================================================

export const externalSourcesGc: Task = async (_payload, _helpers) => {
  const { rows: configRows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config
     WHERE key IN ('external_sources_gc_grace_days', 'external_sources_gc_cull_days')`
  )
  const config = new Map(configRows.map(r => [r.key, r.value]))
  const graceDays = Math.max(1, parseInt(config.get('external_sources_gc_grace_days') ?? '7', 10) || 7)
  const cullDays = Math.max(graceDays, parseInt(config.get('external_sources_gc_cull_days') ?? '90', 10) || 90)

  // Phase 0 — mark newly-orphaned sources.
  const marked = await pool.query(`
    UPDATE external_sources
       SET orphaned_at = now()
     WHERE orphaned_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
  `)

  // Phase A — deactivate orphans past the grace window.
  const deactivated = await pool.query(`
    UPDATE external_sources
       SET is_active = FALSE
     WHERE is_active = TRUE
       AND orphaned_at IS NOT NULL
       AND orphaned_at < now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
  `, [graceDays])

  // Phase B — hard-delete orphans past the cull window. A source referenced by
  // a cross-source identity link (Slice 8) is in use even with no subscription —
  // it may be a link-only target the asserter pasted but doesn't follow — and a
  // cull here would CASCADE-delete the link. So spare any linked source; it's
  // still deactivated (Phase A), just never hard-deleted while a link survives.
  const deleted = await pool.query(`
    DELETE FROM external_sources
     WHERE is_active = FALSE
       AND orphaned_at IS NOT NULL
       AND orphaned_at < now() - ($1 || ' days')::interval
       AND NOT EXISTS (
         SELECT 1 FROM external_subscriptions es
          WHERE es.source_id = external_sources.id
       )
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
  `, [cullDays])

  if ((marked.rowCount ?? 0) > 0 || (deactivated.rowCount ?? 0) > 0 || (deleted.rowCount ?? 0) > 0) {
    logger.info(
      {
        marked: marked.rowCount ?? 0,
        deactivated: deactivated.rowCount ?? 0,
        deleted: deleted.rowCount ?? 0,
        graceDays,
        cullDays,
      },
      'external_sources_gc'
    )
  }
}
