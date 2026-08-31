import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { verifyUnsubscribeToken } from '@platform-pub/shared/lib/publish-email-template.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Email Unsubscribe Route
//
// GET /email/unsubscribe?aid=X&tid=Y&type=Z&token=T
//
// Clicked from the unsubscribe link in publish notification emails.
// Verifies the HMAC-signed token and sets notify_on_publish = false
// on the relevant relationship. Returns a simple HTML confirmation page.
// =============================================================================

const READER_HASH_KEY = requireEnv('READER_HASH_KEY')

// Simple in-memory rate limiter per IP
const ipHits = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = ipHits.get(ip)
  if (!entry || now >= entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return false
  }
  entry.count++
  return entry.count > RATE_LIMIT
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — all.haus</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #1c1917; }
    h1 { font-size: 20px; font-weight: 600; }
    p { font-size: 15px; color: #57534e; line-height: 1.6; }
    a { color: #1c1917; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`
}

export async function unsubscribeRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { aid?: string; tid?: string; type?: string; token?: string }
  }>('/email/unsubscribe', async (req, reply) => {
    const ip = req.ip
    if (isRateLimited(ip)) {
      reply.type('text/html').status(429)
      return htmlPage('Too many requests', '<p>Please try again in a minute.</p>')
    }

    const { aid, tid, type, token } = req.query
    if (!aid || !tid || !type || !token) {
      reply.type('text/html').status(400)
      return htmlPage('Invalid link', '<p>This unsubscribe link is missing required parameters.</p>')
    }

    if (!['subscription', 'follow', 'publication_follow'].includes(type)) {
      reply.type('text/html').status(400)
      return htmlPage('Invalid link', '<p>Unknown notification type.</p>')
    }

    const valid = verifyUnsubscribeToken(
      token, aid, tid, type as 'subscription' | 'follow' | 'publication_follow', READER_HASH_KEY
    )
    if (!valid) {
      logger.warn({ aid, tid, type, ip }, 'Invalid unsubscribe token')
      reply.type('text/html').status(403)
      return htmlPage('Invalid link', '<p>This unsubscribe link is invalid or has been tampered with.</p>')
    }

    // Set notify_on_publish = false on the relevant relationship
    let updated = false
    try {
      if (type === 'subscription') {
        const result = await pool.query(
          `UPDATE subscriptions SET notify_on_publish = false, updated_at = now()
           WHERE reader_id = $1 AND writer_id = $2 AND status = 'active' AND notify_on_publish = true
           RETURNING id`,
          [aid, tid]
        )
        updated = (result.rowCount ?? 0) > 0
      } else if (type === 'follow') {
        const result = await pool.query(
          `UPDATE follows SET notify_on_publish = false
           WHERE follower_id = $1 AND followee_id = $2 AND notify_on_publish = true
           RETURNING follower_id`,
          [aid, tid]
        )
        updated = (result.rowCount ?? 0) > 0
      } else if (type === 'publication_follow') {
        const result = await pool.query(
          `UPDATE publication_follows SET notify_on_publish = false
           WHERE follower_id = $1 AND publication_id = $2 AND notify_on_publish = true
           RETURNING follower_id`,
          [aid, tid]
        )
        updated = (result.rowCount ?? 0) > 0
      }
    } catch (err) {
      logger.error({ err, aid, tid, type }, 'Unsubscribe DB update failed')
      reply.type('text/html').status(500)
      return htmlPage('Something went wrong', '<p>We couldn\'t process your request. Please try again later.</p>')
    }

    // Look up the writer/publication name for a friendly message
    let targetName = 'this writer'
    try {
      if (type === 'subscription' || type === 'follow') {
        const { rows } = await pool.query<{ display_name: string | null; username: string }>(
          `SELECT display_name, username FROM accounts WHERE id = $1`, [tid]
        )
        if (rows.length > 0) targetName = rows[0].display_name ?? rows[0].username
      } else if (type === 'publication_follow') {
        const { rows } = await pool.query<{ name: string }>(
          `SELECT name FROM publications WHERE id = $1`, [tid]
        )
        if (rows.length > 0) targetName = rows[0].name
      }
    } catch { /* best-effort name lookup */ }

    logger.info({ aid, tid, type, updated }, 'Unsubscribe processed')

    reply.type('text/html').status(200)
    return htmlPage(
      'Unsubscribed',
      `<p>You won't receive email notifications from <strong>${targetName}</strong> any more.</p>` +
      `<p>You can re-enable notifications from your <a href="${process.env.APP_URL ?? 'http://localhost:3010'}/account">account page</a>.</p>`
    )
  })
}
