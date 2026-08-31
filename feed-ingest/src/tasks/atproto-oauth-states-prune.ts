import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// Deletes expired rows from atproto_oauth_pending_states.
// These are short-lived PKCE/DPoP state records; anything past expires_at
// is never usable again.
export const atprotoOauthStatesPrune: Task = async () => {
  const { rowCount } = await pool.query(
    'DELETE FROM atproto_oauth_pending_states WHERE expires_at < now()'
  )
  if (rowCount && rowCount > 0) {
    logger.info({ deleted: rowCount }, 'Pruned expired atproto OAuth pending states')
  }
}
