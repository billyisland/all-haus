import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// This prune referenced `updated_at`, and `relay_outbox` has no such column —
// so every nightly run failed with `column "updated_at" does not exist` and
// NOTHING was ever pruned. Harmless at today's row counts, wrong in principle,
// and *invisible*: a graphile job that exhausts its 25 attempts simply sits in
// `_private_jobs` and nobody is told. Dev held 17 rows for this task, 10 of
// them permanently dead, every one red since at least 2026-08-03.
//
// `sent_at` is the column that records when the row reached the relay
// (relay-publish.ts writes `status='sent', sent_at=now()` in one UPDATE), so it
// is what "sent 30 days ago" means. It is COALESCEd onto `created_at` so a
// 'sent' row whose `sent_at` was never stamped — a hand-run recovery UPDATE
// that sets the status and forgets the timestamp — ages out on its creation
// date instead of becoming immortal; a NULL there would silently exempt the row
// from every future prune.
//
// Only 'sent' is pruned. 'abandoned' rows are the ones needing manual
// intervention and `relay_outbox_reconcile` alerts on their count, so deleting
// them would erase the evidence the alert exists to raise.
export const RELAY_OUTBOX_PRUNE_SQL = `
  DELETE FROM relay_outbox
  WHERE status = 'sent'
    AND COALESCE(sent_at, created_at) < now() - INTERVAL '30 days'
`;

export const relayOutboxPrune: Task = async (_payload, _helpers) => {
  const { rowCount } = await pool.query(RELAY_OUTBOX_PRUNE_SQL);

  if (rowCount && rowCount > 0) {
    logger.info(
      { pruned: rowCount },
      "Pruned sent relay_outbox entries older than 30 days",
    );
  }
};
