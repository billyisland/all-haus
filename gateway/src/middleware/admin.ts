import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { requireAuth } from './auth.js'

// =============================================================================
// Admin authorisation — extracted from routes/moderation.ts so route files
// (moderation, external-feeds, admin-dashboard) can share it without importing
// each other.
//
// Admin check reads platform_config.admin_account_ids (comma-separated UUIDs),
// cached for 1 minute, falling back to the ADMIN_ACCOUNT_IDS env var.
// =============================================================================

let adminIdsCache: string[] | null = null
let adminIdsCacheExpiry = 0

export async function getAdminIds(): Promise<string[]> {
  if (adminIdsCache && Date.now() < adminIdsCacheExpiry) return adminIdsCache
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'admin_account_ids'`
    )
    const dbValue = rows[0]?.value ?? ''
    // Trim entries so "id1, id2" parses as two ids, not one id + one " id2".
    const ids = dbValue.split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length > 0) {
      adminIdsCache = ids
      adminIdsCacheExpiry = Date.now() + 60_000 // cache for 1 minute
      return ids
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read admin_account_ids from platform_config')
  }
  // Fallback to env var
  return (process.env.ADMIN_ACCOUNT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function isAdmin(accountId: string): Promise<boolean> {
  const ids = await getAdminIds()
  return ids.includes(accountId)
}

export async function requireAdmin(req: any, reply: any): Promise<void> {
  await requireAuth(req, reply)
  if (reply.sent) return

  if (!(await isAdmin(req.session!.sub))) {
    return reply.status(403).send({ error: 'Admin access required' })
  }
}
