import { pool, withTransaction } from '@platform-pub/shared/db/client.js'

// =============================================================================
// Record a subscription read — called when a subscriber accesses an article
// they haven't unlocked yet. Logs the zero-cost read and creates a permanent
// unlock record.
// =============================================================================

export async function recordSubscriptionRead(
  readerId: string,
  articleId: string,
  writerId: string,
  subscriptionId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via, subscription_id)
       VALUES ($1, $2, 'subscription', $3)
       ON CONFLICT (reader_id, article_id) DO NOTHING`,
      [readerId, articleId, subscriptionId]
    )

    await client.query(
      `INSERT INTO subscription_events
         (subscription_id, event_type, reader_id, writer_id, article_id, amount_pence, description)
       VALUES ($1, 'subscription_read', $2, $3, $4, 0, 'Article read via subscription')`,
      [subscriptionId, readerId, writerId, articleId]
    )
  })
}

// =============================================================================
// Record a purchase unlock — called after a successful gate-pass payment.
// Idempotent: a retry that re-runs after payment but before key issuance
// hits ON CONFLICT and the subsequent access check returns 'already_unlocked'.
// =============================================================================

export async function recordPurchaseUnlock(
  readerId: string,
  articleId: string,
  isProvisional = false,
): Promise<void> {
  // F3: a provisional (card-less) read's unlock is marked non-permanent; it is
  // cleared to permanent when the reader connects a card (convertProvisionalReads).
  await pool.query(
    `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via, is_provisional)
     VALUES ($1, $2, 'purchase', $3)
     ON CONFLICT (reader_id, article_id) DO NOTHING`,
    [readerId, articleId, isProvisional]
  )
}
