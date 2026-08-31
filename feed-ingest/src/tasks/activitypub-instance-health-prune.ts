import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// Deletes activitypub_instance_health rows for hosts we haven't heard from
// in 90 days. Prevents the table from accreting dead hosts forever as
// sources come and go — the counters are tallies, not archival data.
export const activityPubInstanceHealthPrune: Task = async () => {
  const { rowCount } = await pool.query(`
    DELETE FROM activitypub_instance_health
    WHERE COALESCE(last_success_at, '-infinity') < now() - interval '90 days'
      AND COALESCE(last_failure_at, '-infinity') < now() - interval '90 days'
  `)
  if (rowCount && rowCount > 0) {
    logger.info({ deleted: rowCount }, 'Pruned stale activitypub_instance_health rows')
  }
}
