import { pool } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Article Access Checker
//
// Determines whether a reader has free access to a paywalled article.
// Checked before the payment flow in the gate-pass orchestrator.
//
// Free access granted if:
//   1. Reader is the article's author (own content)
//   2. Reader is a member of the article's Publication
//   3. Reader has a permanent unlock (previous purchase or subscription read)
//   4. Reader has an active/valid subscription to the writer/publication
//
// Returns { hasAccess: true, reason: '...' } or { hasAccess: false }
// =============================================================================

interface AccessCheckResult {
  hasAccess: boolean
  reason?: 'own_content' | 'already_unlocked' | 'subscription'
  subscriptionId?: string
}

export async function checkArticleAccess(
  readerId: string,
  articleId: string,
  writerId: string,
  publicationId?: string | null,
): Promise<AccessCheckResult> {

  // 1. Own content — always free
  if (readerId === writerId) {
    return { hasAccess: true, reason: 'own_content' }
  }

  // 2. Publication member — members read their own Publication's content free
  if (publicationId) {
    const memberResult = await pool.query<{ id: string }>(
      `SELECT id FROM publication_members
       WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
      [publicationId, readerId]
    )
    if (memberResult.rows.length > 0) {
      return { hasAccess: true, reason: 'own_content' }
    }
  }

  // 3. Permanent unlock — already purchased or read via subscription
  const unlockResult = await pool.query<{ id: string }>(
    `SELECT id FROM article_unlocks
     WHERE reader_id = $1 AND article_id = $2`,
    [readerId, articleId]
  )

  if (unlockResult.rows.length > 0) {
    return { hasAccess: true, reason: 'already_unlocked' }
  }

  // 4. Subscription — check Publication or individual writer
  if (publicationId) {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND publication_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, publicationId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  } else {
    const subResult = await pool.query<{ id: string }>(
      `SELECT id FROM subscriptions
       WHERE reader_id = $1 AND writer_id = $2
         AND status IN ('active', 'cancelled')
         AND current_period_end > now()`,
      [readerId, writerId]
    )
    if (subResult.rows.length > 0) {
      return {
        hasAccess: true,
        reason: 'subscription',
        subscriptionId: subResult.rows[0].id,
      }
    }
  }

  return { hasAccess: false }
}
