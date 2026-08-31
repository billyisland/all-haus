import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// external_items_prune — daily cleanup of old external items
//
// Deletes items older than the retention period, but preserves items still
// referenced (a native reply's parent, a citation edge, a vote) so pruning
// never breaks a thread or fails on a foreign key.
//
// Three prior defects (M15, 2026-07-16 deep audit):
//   • The "reply thread" guard was `NOT EXISTS (… WHERE FALSE)` — dead code, so
//     a native reply's external parent (notes.external_parent_id, ON DELETE SET
//     NULL) was deleted at retention and the thread broke. Replaced with a real
//     guard on notes.external_parent_id.
//   • citation_edges.source_external_item_id has NO ON DELETE action, so
//     deleting a cited item raised a RESTRICT violation that failed the whole
//     batch — after which nothing was ever pruned again (permanent wedge,
//     unbounded growth). Now we skip cited items.
//   • The `deleted_at IS NULL` filter EXCLUDED author-tombstoned items from the
//     prune, so exactly the content a user deleted was the one class retained
//     forever (inverted retention, a privacy problem). Dropped — tombstoned old
//     items are now pruned too (still subject to the reference guards).
// =============================================================================

// Exported so the integration test runs THIS exact DELETE, not a copy that could
// silently drift back into one of the three defects above (repo idiom: the M4
// reserve-path SQL constants, gateway/src/lib/dedup-sql.ts).
// $1 = retention days; $2 = batch limit (§0f-12): the M15 unwedge means the
// first run on a long-wedged DB faces the ENTIRE accumulated backlog — one
// unbatched statement/transaction over millions of rows. Deleting via a
// LIMIT-ed id subquery lets the task loop in bounded bites instead.
export const EXTERNAL_ITEMS_PRUNE_SQL = `
    DELETE FROM external_items
    WHERE id IN (
      SELECT ei.id FROM external_items ei
      WHERE ei.created_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM notes n WHERE n.external_parent_id = ei.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM citation_edges ce WHERE ce.source_external_item_id = ei.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM votes v WHERE v.target_nostr_event_id = ei.id::text
        )
      LIMIT $2
    )
  `

const PRUNE_BATCH_SIZE = 5_000
// Bounds a single run (~1M rows). A larger backlog carries to the next daily
// run — logged below so the cap is never silent.
const PRUNE_MAX_BATCHES = 200

export const externalItemsPrune: Task = async (_payload, _helpers) => {
  const { rows: [config] } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'external_items_retention_days'`
  )
  const retentionDays = parseInt(config?.value ?? '90', 10)

  let pruned = 0
  let batches = 0
  for (; batches < PRUNE_MAX_BATCHES; batches++) {
    const { rowCount } = await pool.query(EXTERNAL_ITEMS_PRUNE_SQL, [
      retentionDays,
      PRUNE_BATCH_SIZE,
    ])
    pruned += rowCount ?? 0
    if ((rowCount ?? 0) < PRUNE_BATCH_SIZE) break
  }

  if (pruned > 0) {
    logger.info({ pruned, batches: batches + 1, retentionDays }, 'Pruned old external items')
  }
  if (batches >= PRUNE_MAX_BATCHES) {
    logger.warn(
      { pruned, retentionDays, batchSize: PRUNE_BATCH_SIZE },
      'external_items_prune hit the per-run batch cap — backlog remains, next run continues'
    )
  }
}
