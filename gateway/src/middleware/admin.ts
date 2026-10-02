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
// Whether the LAST resolution came off the environment rather than the DB, so
// the warning below fires on the transition rather than once a minute for ever.
let lastSourceWasEnv: boolean | null = null

function parseIds(raw: string): string[] {
  // Trim entries so "id1, id2" parses as two ids, not one id + one " id2".
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * The one home for "who is an admin" — `platform_config.admin_account_ids`,
 * cached a minute, falling back to the `ADMIN_ACCOUNT_IDS` env var.
 *
 * THE ENV FALLBACK IS LOAD-BEARING AND MUST STAY. `config-defaults.sql` seeds
 * the key as the EMPTY STRING, so a freshly-migrated database has the row and
 * has nobody in it; without the fallback there would be no way to reach
 * `/admin/*` at all on a new deployment, and no way to grant the first admin.
 * That also rules out the absent-vs-empty split this repo uses elsewhere: here
 * "empty" is the default state, not a decision somebody took.
 *
 * WHAT IT MUST NOT BE IS SILENT. Clearing the list in the config editor reads
 * as revoking admin access, and if the env var is set it revokes nothing — so
 * the fallback now says so in the log, on the transition, with the count. That
 * line is the difference between "the revoke did not work" being discoverable
 * and being invisible.
 *
 * The env branch is cached like the DB one. It was not, so every request from
 * an env-granted admin re-read `platform_config` — the cache existed and the
 * one deployment shape that needs it most never got it.
 */
export async function getAdminIds(): Promise<string[]> {
  if (adminIdsCache && Date.now() < adminIdsCacheExpiry) return adminIdsCache

  let dbIds: string[] = []
  let dbReadFailed = false
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'admin_account_ids'`
    )
    dbIds = parseIds(rows[0]?.value ?? '')
  } catch (err) {
    dbReadFailed = true
    logger.warn({ err }, 'Failed to read admin_account_ids from platform_config')
  }

  const envIds = parseIds(process.env.ADMIN_ACCOUNT_IDS ?? '')
  const usingEnv = dbIds.length === 0
  const ids = usingEnv ? envIds : dbIds

  if (usingEnv && envIds.length > 0 && lastSourceWasEnv !== true) {
    logger.warn(
      { adminCount: envIds.length, dbReadFailed },
      dbReadFailed
        ? 'ADMIN IDS FROM ENV: platform_config could not be read, so admin access is being granted from ADMIN_ACCOUNT_IDS'
        : 'ADMIN IDS FROM ENV: platform_config.admin_account_ids is empty, so admin access is being granted from ADMIN_ACCOUNT_IDS. Clearing the list in the config editor does NOT revoke these accounts — unset the env var and redeploy.',
    )
  } else if (!usingEnv && lastSourceWasEnv === true) {
    logger.info(
      { adminCount: ids.length },
      'Admin ids now come from platform_config.admin_account_ids',
    )
  }
  lastSourceWasEnv = usingEnv

  // A failed DB read is AMBIGUOUS, not an answer, so it is not cached: the next
  // request retries rather than serving a possibly-wrong set for a minute.
  if (!dbReadFailed) {
    adminIdsCache = ids
    adminIdsCacheExpiry = Date.now() + 60_000
  }
  return ids
}

/** Drop the cached set (and the log-transition memory). Called by the config
 *  PATCH when `admin_account_ids` changes, and by suites that drive both
 *  branches in one process. */
export function invalidateAdminIdsCache(): void {
  adminIdsCache = null
  adminIdsCacheExpiry = 0
  lastSourceWasEnv = null
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
