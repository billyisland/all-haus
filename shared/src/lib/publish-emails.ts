import { sendBroadcastEmail } from './email.js'
import { pool } from '../db/client.js'
import {
  publishEmailSubject,
  publishEmailText,
  publishEmailBody,
  buildUnsubscribeUrl,
} from './publish-email-template.js'
import logger from './logger.js'

// =============================================================================
// Publish Notification Emails (v2 — broadcast stream)
//
// When a writer publishes a new article, notify all active subscribers who
// have opted in to publish notifications (notify_on_publish = true).
//
// Uses Postmark's broadcast stream for proper email reputation separation.
// Enforces a configurable daily send cap for broadcast warm-up.
// =============================================================================

const APP_URL = process.env.APP_URL ?? 'http://localhost:3010'
const CONCURRENCY = 10
const READER_HASH_KEY = process.env.READER_HASH_KEY ?? ''

// ---------------------------------------------------------------------------
// Daily send cap for broadcast warm-up
// ---------------------------------------------------------------------------

let dailySendCount = 0
let dailySendDate = ''

function getDailyLimit(): number {
  const raw = process.env.BROADCAST_DAILY_SEND_LIMIT
  if (raw === '0') return Infinity
  return parseInt(raw ?? '50', 10) || 50
}

function checkAndIncrementCap(batchSize: number): { allowed: number; skipped: number } {
  const today = new Date().toISOString().slice(0, 10)
  if (dailySendDate !== today) {
    dailySendDate = today
    dailySendCount = 0
  }

  const limit = getDailyLimit()
  const remaining = Math.max(0, limit - dailySendCount)
  const allowed = Math.min(batchSize, remaining)
  const skipped = batchSize - allowed
  dailySendCount += allowed
  return { allowed, skipped }
}

// ---------------------------------------------------------------------------
// Writer info
// ---------------------------------------------------------------------------

interface WriterInfo {
  displayName: string
  username: string
  avatarUrl: string | null
}

async function getWriterInfo(writerId: string): Promise<WriterInfo | null> {
  const { rows } = await pool.query<{
    display_name: string | null
    username: string
    avatar_blossom_url: string | null
  }>(
    `SELECT display_name, username, avatar_blossom_url FROM accounts WHERE id = $1`,
    [writerId]
  )
  if (rows.length === 0) return null
  return {
    displayName: rows[0].display_name ?? rows[0].username,
    username: rows[0].username,
    avatarUrl: rows[0].avatar_blossom_url,
  }
}

// ---------------------------------------------------------------------------
// Subscriber query (Phase 1: paid subscribers only)
// ---------------------------------------------------------------------------

interface Recipient {
  id: string
  email: string
  display_name: string | null
  username: string
}

async function getOptedInSubscribers(writerId: string): Promise<Recipient[]> {
  const { rows } = await pool.query<Recipient>(
    `SELECT a.id, a.email, a.display_name, a.username
     FROM subscriptions s
     JOIN accounts a ON s.reader_id = a.id
     WHERE s.writer_id = $1
       AND s.status = 'active'
       AND s.notify_on_publish = true
       AND a.email IS NOT NULL`,
    [writerId]
  )
  return rows
}

// ---------------------------------------------------------------------------
// Send one notification
// ---------------------------------------------------------------------------

async function sendOneNotification(
  recipient: Recipient,
  writerId: string,
  writer: WriterInfo,
  title: string,
  summary: string | null,
  contentFree: string | null,
  articleUrl: string,
): Promise<void> {
  const unsubscribeUrl = buildUnsubscribeUrl(
    recipient.id, writerId, 'subscription', READER_HASH_KEY
  )

  const params = {
    writerName: writer.displayName,
    writerAvatarUrl: writer.avatarUrl,
    title,
    summary,
    contentFree,
    articleUrl,
    unsubscribeUrl,
  }

  await sendBroadcastEmail({
    to: recipient.email,
    subject: publishEmailSubject(writer.displayName, title),
    textBody: publishEmailText(params),
    htmlBody: publishEmailBody(params),
  })
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface SendResult {
  recipientCount: number
  skippedCount: number
}

export async function sendPublishNotifications(
  writerId: string,
  articleId: string,
  title: string,
  dTag: string,
  summary?: string,
  contentFree?: string,
): Promise<SendResult> {
  const writer = await getWriterInfo(writerId)
  if (!writer) return { recipientCount: 0, skippedCount: 0 }

  const subscribers = await getOptedInSubscribers(writerId)
  if (subscribers.length === 0) return { recipientCount: 0, skippedCount: 0 }

  // Enforce daily send cap
  const { allowed, skipped } = checkAndIncrementCap(subscribers.length)

  if (skipped > 0) {
    logger.warn(
      { writerId, articleId, total: subscribers.length, allowed, skipped },
      'Broadcast daily send cap reached — some recipients skipped'
    )
  }

  const recipients = subscribers.slice(0, allowed)
  const articleUrl = `${APP_URL}/article/${dTag}`

  logger.info(
    { writerId, articleId, recipientCount: recipients.length, skippedCount: skipped },
    'Sending publish notification emails via broadcast stream'
  )

  // Send in batches to limit concurrency
  let sentCount = 0
  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const batch = recipients.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(sub =>
        sendOneNotification(sub, writerId, writer, title, summary ?? null, contentFree ?? null, articleUrl)
      )
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        sentCount++
      } else {
        logger.warn({ err: result.reason }, 'Failed to send publish notification')
      }
    }
  }

  // Mark article as email-sent
  if (sentCount > 0) {
    await pool.query(
      `UPDATE articles SET email_sent_at = now() WHERE id = $1`,
      [articleId]
    )
  }

  return { recipientCount: sentCount, skippedCount: skipped }
}
