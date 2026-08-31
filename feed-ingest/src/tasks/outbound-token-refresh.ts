import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import { getAtprotoClient } from '@platform-pub/shared/lib/atproto-oauth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// outbound_token_refresh — daemon-style cron job
//
// Walks network_presences and refreshes any OAuth credentials that are inside
// the configured refresh window. Branching is on custody, not provenance
// (NETWORK-CONCIERGE-ADR): 'linked' and 'assisted' presences both carry OAuth
// sessions; only 'concierge' presences sign via key-custody and have no
// session to refresh.
// Mastodon tokens issued by the standard /oauth/token endpoint do not expire
// (the Mastodon docs are explicit) and have no refresh_token, so they are
// skipped here. The job is load-bearing for linked Bluesky, since AT Protocol
// access tokens are short-lived and DPoP-bound.
//
// On refresh failure the presence is marked is_valid=FALSE; the user sees a
// "reconnect" prompt the next time settings is opened, and any queued
// outbound_posts for that account short-circuit to 'failed'.
// =============================================================================

interface DueRow {
  id: string
  protocol: string
  handle: string | null
  token_expires_at: Date
}

export const outboundTokenRefresh: Task = async () => {
  const windowPct = await loadRefreshWindowPct()

  // Pick accounts whose token has burned through `windowPct`% of its
  // total lifetime (last_refreshed_at → token_expires_at). Accounts with no
  // expires_at are non-expiring (Mastodon) and are skipped.
  const { rows } = await pool.query<DueRow>(`
    SELECT id, protocol, handle, token_expires_at
    FROM network_presences
    WHERE is_valid = TRUE
      AND provenance <> 'concierge'
      AND lifecycle_state = 'active'
      AND credentials_enc IS NOT NULL
      AND token_expires_at IS NOT NULL
      AND last_refreshed_at IS NOT NULL
      AND EXTRACT(EPOCH FROM (now() - last_refreshed_at))
          >= ($1::numeric / 100.0)
           * EXTRACT(EPOCH FROM (token_expires_at - last_refreshed_at))
    ORDER BY token_expires_at ASC
    LIMIT 100
  `, [windowPct])

  for (const row of rows) {
    // credentials_enc-based OAuth refresh isn't wired up yet — Mastodon tokens
    // don't expire, so nothing currently lands here. Future protocols with
    // refresh_token semantics can branch on row.protocol below.
    logger.debug({ id: row.id, protocol: row.protocol }, 'no credentials_enc refresh handler; skipping')
  }

  // ---------------------------------------------------------------------------
  // AT Protocol: tokens live in atproto_oauth_sessions (credentials_enc IS NULL
  // in network_presences). The @atproto/oauth-client-node lib auto-refreshes on
  // use, but dormant accounts risk letting the refresh token expire. We
  // proactively touch each atproto session once a week by calling restore()
  // with refresh='auto' — the lib decides whether to refresh based on its
  // own TTL heuristics.
  // ---------------------------------------------------------------------------

  // Only touch rows that actually have a stored session — rows whose session
  // was deleted out-of-band would otherwise throw inside restore() on every
  // tick and produce alarming-looking warn logs.
  const { rows: atpRows } = await pool.query<{ id: string; external_id: string; has_session: boolean }>(`
    SELECT la.id, la.external_id,
           EXISTS (SELECT 1 FROM atproto_oauth_sessions s WHERE s.did = la.external_id) AS has_session
    FROM network_presences la
    WHERE la.protocol = 'atproto'
      AND la.provenance <> 'concierge'
      AND la.lifecycle_state = 'active'
      AND la.is_valid = TRUE
      AND (la.last_refreshed_at IS NULL OR la.last_refreshed_at < now() - INTERVAL '7 days')
    ORDER BY la.last_refreshed_at ASC NULLS FIRST
    LIMIT 50
  `)

  if (atpRows.length === 0) return

  const client = await getAtprotoClient()
  for (const row of atpRows) {
    if (!row.has_session) {
      logger.info({ id: row.id, did: row.external_id }, 'atproto session missing; marking invalid')
      await pool.query(
        `UPDATE network_presences SET is_valid = FALSE, updated_at = now() WHERE id = $1`,
        [row.id]
      )
      continue
    }
    try {
      await client.restore(row.external_id, 'auto')
      await pool.query(
        `UPDATE network_presences SET last_refreshed_at = now(), updated_at = now() WHERE id = $1`,
        [row.id]
      )
      logger.debug({ did: row.external_id }, 'atproto session touched')
    } catch (err) {
      // Don't log the raw err — we don't want a library that one day
      // embeds DPoP proof or access-token fragments in its error
      // message to smuggle them into our logs.
      const errName = err instanceof Error ? err.name : 'Unknown'
      const errMessage = err instanceof Error ? err.message?.slice(0, 200) : String(err).slice(0, 200)
      // A PDS outage or network blip looks identical to a revoked refresh
      // token at the top level. Flipping is_valid on a transient 5xx
      // prompts the user to reconnect for no reason — walk the cause chain
      // and look for a signature of something that will clear on its own.
      if (isTransientAtprotoError(err)) {
        logger.warn({ errName, errMessage, id: row.id, did: row.external_id }, 'atproto session refresh hit transient error; will retry next cycle')
      } else {
        logger.warn({ errName, errMessage, id: row.id, did: row.external_id }, 'atproto session restore failed; marking invalid')
        await pool.query(
          `UPDATE network_presences SET is_valid = FALSE, updated_at = now() WHERE id = $1`,
          [row.id]
        )
      }
    }
  }
}

const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
])

function isTransientAtprotoError(err: unknown): boolean {
  let cur: unknown = err
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    const code = (cur as { code?: string }).code
    if (typeof code === 'string' && TRANSIENT_NET_CODES.has(code)) return true
    const statusCode = (cur as { statusCode?: number }).statusCode
    if (typeof statusCode === 'number' && statusCode >= 500) return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}

async function loadRefreshWindowPct(): Promise<number> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = 'outbound_token_refresh_window_pct'`
  )
  return parseInt(rows[0]?.value ?? '80', 10)
}
