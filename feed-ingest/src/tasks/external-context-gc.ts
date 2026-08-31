import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

export const externalContextGc: Task = async (_payload, _helpers) => {
  const {
    rows: [config],
  } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'external_context_gc_retention_days'`,
  );
  const retentionDays = parseInt(config?.value ?? "30", 10);

  // Reclaim aged context-only external items AND any feed_items rows backing them.
  // Live /thread hydration (external-items.ts::hydrateExternalThreadContext) now
  // dual-writes context-only thread nodes into feed_items so the pure-DB projector
  // can resolve them; the old "NOT EXISTS feed_items" guard would pin those rows
  // forever. Real feed content is is_context_only = FALSE, so the predicate never
  // touches it. feed_items is deleted first (FK from feed_items.external_item_id).
  // The notes guard stays: a context item that became a reply's parent is kept.
  const { rowCount } = await pool.query(
    `
    WITH stale AS (
      SELECT ei.id
        FROM external_items ei
       WHERE ei.is_context_only = TRUE
         AND ei.created_at < now() - ($1 || ' days')::interval
         AND NOT EXISTS (
           SELECT 1 FROM notes n WHERE n.external_parent_id = ei.id
         )
         -- citation_edges.source_external_item_id has no ON DELETE action, so a
         -- cited item would fail the DELETE with a RESTRICT violation and wedge
         -- the whole batch permanently (M15, same as external-items-prune).
         AND NOT EXISTS (
           SELECT 1 FROM citation_edges ce WHERE ce.source_external_item_id = ei.id
         )
    ),
    del_fi AS (
      DELETE FROM feed_items WHERE external_item_id IN (SELECT id FROM stale)
    )
    DELETE FROM external_items WHERE id IN (SELECT id FROM stale)
  `,
    [retentionDays],
  );

  if (rowCount && rowCount > 0) {
    logger.info(
      { pruned: rowCount, retentionDays },
      "Pruned context-only external items",
    );
  }
};
