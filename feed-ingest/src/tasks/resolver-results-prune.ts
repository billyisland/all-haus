import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// Deletes expired rows from resolver_async_results.
// Phase B resolver results live for ~60s after their initiating request;
// once expires_at passes, the row is never read again.
export const resolverResultsPrune: Task = async () => {
  const { rowCount } = await pool.query(
    'DELETE FROM resolver_async_results WHERE expires_at < now()'
  )
  if (rowCount && rowCount > 0) {
    logger.info({ deleted: rowCount }, 'Pruned expired resolver async results')
  }
}
