import { pool } from '@platform-pub/shared/db/client.js'
import type { PaymentVerification } from '../types/index.js'

// =============================================================================
// Payment Verification
//
// Before issuing a content key, the key service verifies that the reader has
// a valid payment record for the article. This queries the shared PostgreSQL
// database — the key service and payment service share the same DB.
//
// Valid states for key issuance: provisional, accrued, platform_settled,
// writer_paid. All four represent a real purchase — provisional reads are
// paid from the reader's free £5 starting credit and grant permanent access.
//
// Re-issuance: a reader who has previously unlocked an article can request
// the key again at any time (new device, session expiry, account recovery).
// =============================================================================

export async function verifyPayment(
  readerId: string,
  articleId: string
): Promise<PaymentVerification> {
  const { rows } = await pool.query<{
    id: string
    state: string
  }>(
    `SELECT id, state
     FROM read_events
     WHERE reader_id = $1
       AND article_id = $2
       AND state IN ('provisional', 'accrued', 'platform_settled', 'writer_paid')
     ORDER BY read_at DESC
     LIMIT 1`,
    [readerId, articleId]
  )

  if (rows.length === 0) {
    return {
      isVerified: false,
      readEventId: null,
      state: null,
      readEventExists: false,
    }
  }

  return {
    isVerified: true,
    readEventId: rows[0].id,
    state: rows[0].state as PaymentVerification['state'],
    readEventExists: true,
  }
}

// ---------------------------------------------------------------------------
// resolveArticleId — translates a Nostr event ID to the internal UUID
// The client sends the Nostr event ID; the key service works with UUIDs
// ---------------------------------------------------------------------------

export async function resolveArticleId(
  nostrEventId: string
): Promise<{ articleId: string; writerId: string } | null> {
  const { rows } = await pool.query<{ id: string; writer_id: string }>(
    `SELECT id, writer_id FROM articles WHERE nostr_event_id = $1`,
    [nostrEventId]
  )

  if (rows.length === 0) return null
  return { articleId: rows[0].id, writerId: rows[0].writer_id }
}
