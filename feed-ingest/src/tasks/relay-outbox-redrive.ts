import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// relay_outbox_redrive — second heartbeat for the relay_outbox queue.
//
// Runs every minute. Enqueues a relay_publish job for any row in
// ('pending', 'failed') whose next_attempt_at is past. Covers the case where
// the original add_job call is lost (e.g. Graphile DB hiccup between the
// row INSERT and the job scheduling) and provides a path-independent
// heartbeat so nothing can silently stall in the queue.
//
// Uses `job_key` with a timestamp suffix so repeated redrives of the same
// stuck row don't collapse into a single pending job (which would prevent
// the next attempt from starting).
// =============================================================================

const BATCH_SIZE = 100

export const relayOutboxRedrive: Task = async (_payload, helpers) => {
  const { rows } = await pool.query<{ id: string; attempts: number }>(
    `SELECT id, attempts
       FROM relay_outbox
       WHERE status IN ('pending', 'failed')
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at
       LIMIT $1`,
    [BATCH_SIZE],
  )

  if (rows.length === 0) return

  for (const row of rows) {
    await helpers.addJob('relay_publish', { outboxId: row.id }, {
      // Distinct job_key per redrive tick so graphile-worker doesn't
      // collapse this into an already-pending entry; the worker itself
      // still dedupes via SELECT FOR UPDATE SKIP LOCKED.
      jobKey: `relay_publish_${row.id}_redrive_${Date.now()}`,
      maxAttempts: 1,
    })
  }

  logger.info({ redriven: rows.length }, 'relay_outbox_redrive: re-enqueued stuck rows')
}
