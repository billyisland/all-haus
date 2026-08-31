import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// relay_outbox_reconcile — daily metrics emission for the relay_outbox queue.
//
// Does NOT attempt to reconcile DB entities against outbox rows — per the
// ADR, the outbox is the record of what was published; divergence between
// entity state and outbox state is a symptom, not a source of truth worth
// rebuilding.
//
// Emits three counters via the log stream for dashboard ingestion:
//   - abandoned_total         — alert target; any >0 needs manual attention
//   - failed_retrying_total   — ops signal; persistent-failure tail
//   - sent_last_24h           — throughput metric
// =============================================================================

export const relayOutboxReconcile: Task = async () => {
  const { rows } = await pool.query<{
    abandoned: string
    failed_high_retry: string
    sent_last_24h: string
  }>(
    `SELECT
       (SELECT count(*) FROM relay_outbox WHERE status = 'abandoned')::text AS abandoned,
       (SELECT count(*) FROM relay_outbox WHERE status = 'failed' AND attempts > 3)::text AS failed_high_retry,
       (SELECT count(*) FROM relay_outbox WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::text AS sent_last_24h`,
  )

  const abandoned = parseInt(rows[0].abandoned, 10)
  const failed_high_retry = parseInt(rows[0].failed_high_retry, 10)
  const sent_last_24h = parseInt(rows[0].sent_last_24h, 10)

  if (abandoned > 0) {
    logger.warn({ abandoned }, 'relay_outbox_reconcile: abandoned rows present — manual intervention required')
  }

  logger.info(
    { abandoned, failed_high_retry, sent_last_24h },
    'relay_outbox_reconcile: queue metrics',
  )
}
