import { randomBytes, createHash } from 'crypto'
import { pool } from '../db/client.js'
import logger from '../lib/logger.js'

// =============================================================================
// Magic Link Service
//
// Passwordless email login flow:
//   1. User enters email → requestMagicLink() generates a token, stores hash,
//      and returns the raw token for emailing.
//   2. User clicks the link → verifyMagicLink() checks the token hash,
//      marks it as used, and returns the account ID.
//   3. The auth route creates a session for the account.
//
// Security:
//   - Token is 32 random bytes, URL-safe base64 encoded
//   - Only the SHA-256 hash is stored in the DB — raw token never persisted
//   - Single-use: marked as used_at on verification
//   - 15-minute expiry
//   - Rate limiting is handled at the gateway (Fastify rate-limit plugin)
//
// A TOKEN CARRIES WHAT IT IS FOR, AND BOTH READERS FILTER ON IT (migration 192,
// MIRROR-AUDIT §2.6). The same primitive now also backs the step-up on the nsec
// export, and the two kinds must not be interchangeable in EITHER direction: a
// login link forwarded to a phisher must not authorise a key export, and an
// export link must not be a way in. `verifyMagicLink` therefore claims only
// `purpose = 'login'` and `claimStepUpToken` only its own purpose — a filter
// missing from either side silently re-merges them, and the token that is
// misused is by construction the one already in an attacker's hands.
// =============================================================================

const TOKEN_EXPIRY_MINUTES = 15

// ---------------------------------------------------------------------------
// requestMagicLink — generates a token for an email address
// Returns the raw token (to embed in the email link) or null if no account
// ---------------------------------------------------------------------------

export interface MagicLinkResult {
  token: string           // raw token — put this in the email link
  accountId: string
  expiresAt: Date
}

export async function requestMagicLink(email: string): Promise<MagicLinkResult | null> {
  // Look up account by email. Deactivated accounts are eligible: the deactivate
  // flow promises "you can reactivate by logging back in", so the login link
  // must reach them — the /auth/verify route flips status back to 'active' on
  // successful verification. Suspended accounts (admin action) stay locked out.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE email = $1 AND status IN ('active', 'deactivated')`,
    [email.toLowerCase().trim()]
  )

  if (rows.length === 0) {
    // Don't reveal whether the email exists — return null silently
    // The route should return a generic "if an account exists..." message
    logger.debug({ email: email.slice(0, 3) + '***' }, 'Magic link requested for unknown email')
    return null
  }

  const accountId = rows[0].id

  // Generate token
  const tokenBytes = randomBytes(32)
  const token = tokenBytes.toString('base64url')  // URL-safe, no padding
  const tokenHash = hashToken(token)

  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000)

  // Store the hash (never the raw token)
  await pool.query(
    `INSERT INTO magic_links (account_id, token_hash, expires_at, purpose)
     VALUES ($1, $2, $3, 'login')`,
    [accountId, tokenHash, expiresAt]
  )

  logger.info({ accountId }, 'Magic link generated')

  return { token, accountId, expiresAt }
}

// ---------------------------------------------------------------------------
// verifyMagicLink — validates and consumes a token
// Returns the account ID if valid, null otherwise
// ---------------------------------------------------------------------------

export async function verifyMagicLink(token: string): Promise<string | null> {
  const tokenHash = hashToken(token)

  // Claim the token in ONE atomic UPDATE — the single-use guarantee is the
  // defence against a link intercepted in transit, so a SELECT-then-UPDATE
  // (two statements) let concurrent verifications of the same token both find
  // it unused and both mint a session. `used_at IS NULL` in the WHERE means
  // exactly one racer's UPDATE matches a row; the loser's RETURNING is empty.
  const { rows } = await pool.query<{ account_id: string }>(
    `UPDATE magic_links SET used_at = now()
     WHERE token_hash = $1
       AND purpose = 'login'
       AND used_at IS NULL
       AND expires_at > now()
     RETURNING account_id`,
    [tokenHash]
  )

  if (rows.length === 0) {
    logger.debug('Magic link verification failed — token not found, used, or expired')
    return null
  }

  logger.info({ accountId: rows[0].account_id }, 'Magic link verified')

  return rows[0].account_id
}

// ---------------------------------------------------------------------------
// Step-up tokens — the same primitive, for confirming an irreversible action
// the caller is ALREADY authenticated for (MIRROR-AUDIT §2.6).
//
// Not a login: the account is known before the token is minted, so it is minted
// FOR that account and claimed against it. The `account_id = $2` predicate is
// belt and braces — a caller cannot present a token they were never sent — but
// it is what makes the claim a statement about one member rather than a lookup
// over everyone's tokens, and it costs nothing.
//
// Claimed on a caller's CLIENT, not the pool, so the claim can ride the same
// transaction as whatever it authorises. A token that has been spent must be a
// token whose consequence was recorded, and the only way to guarantee that is
// for both to commit or neither.
// ---------------------------------------------------------------------------

// `key_export` confirms an irreversible action the caller is ALREADY
// authenticated for; `appeal` is the opposite case and is why this is a union
// rather than a constant. A suspended member gets 403 from `requireAuth` on
// every route, so the appeal D7 §5 promises them cannot be claimed with a
// session — the token in their notice email is the only channel they have
// left. Same primitive, and the `purpose` filter on both readers is what stops
// one being spent as the other. `email_change_undo` is the appeal's shape
// again: it is mailed to the address a change REPLACED, and its holder is the
// member a stolen session has just locked out, so it too is claimed without a
// session (POST /auth/undo-email-change, migration 273).
export type StepUpPurpose = 'key_export' | 'appeal' | 'email_change_undo'

interface QueryClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
}

export interface StepUpLinkResult {
  token: string
  expiresAt: Date
}

export async function requestStepUpToken(
  accountId: string,
  purpose: StepUpPurpose,
  // The lifetime is the RIGHT's, not the primitive's. `key_export` wants the
  // login expiry (minutes — it confirms something the caller is doing now); an
  // appeal window is seven days (D7 §5), and a token that dies before the
  // window it carries closes is the same fault one layer down. Omitted keeps
  // the short default, so the export path is unchanged.
  expiresAt: Date = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000),
  // A caller minting the token as part of a write passes its transaction, so
  // the token exists exactly when the write it undoes does.
  client: QueryClient = pool
): Promise<StepUpLinkResult> {
  const token = randomBytes(32).toString('base64url')

  await client.query(
    `INSERT INTO magic_links (account_id, token_hash, expires_at, purpose)
     VALUES ($1, $2, $3, $4)`,
    [accountId, hashToken(token), expiresAt, purpose]
  )

  logger.info({ accountId, purpose }, 'Step-up token generated')

  return { token, expiresAt }
}

/** True iff this exact token was minted for this account and this purpose, and is unspent. */
export async function claimStepUpToken(
  client: QueryClient,
  token: string,
  accountId: string,
  purpose: StepUpPurpose
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE magic_links SET used_at = now()
     WHERE token_hash = $1
       AND account_id = $2
       AND purpose = $3
       AND used_at IS NULL
       AND expires_at > now()`,
    [hashToken(token), accountId, purpose]
  )
  return (rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// cleanupExpiredLinks — housekeeping, run periodically
// ---------------------------------------------------------------------------

export async function cleanupExpiredLinks(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM magic_links
     WHERE expires_at < now() - INTERVAL '1 hour'`
  )

  if (rowCount && rowCount > 0) {
    logger.debug({ deleted: rowCount }, 'Cleaned up expired magic links')
  }

  return rowCount ?? 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
