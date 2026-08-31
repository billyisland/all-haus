import { withTransaction } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Drive expiry worker — runs hourly from gateway/index.ts under an advisory
// lock. Flips drives past their deadline to status='expired' and voids any
// still-active pledges against them.
// =============================================================================

export async function expireOverdueDrives(): Promise<number> {
  const result = await withTransaction(async (client) => {
    const expired = await client.query<{ id: string }>(
      `UPDATE pledge_drives
       SET status = 'expired', pinned = FALSE
       WHERE status IN ('open', 'funded')
         AND deadline IS NOT NULL
         AND deadline < now()
       RETURNING id`
    )

    if (expired.rows.length > 0) {
      const expiredIds = expired.rows.map(r => r.id)
      await client.query(
        `UPDATE pledges SET status = 'void'
         WHERE drive_id = ANY($1) AND status = 'active'`,
        [expiredIds]
      )
    }

    return expired.rowCount ?? 0
  })

  if (result > 0) {
    logger.info({ count: result }, 'Expired overdue pledge drives')
  }

  return result
}
