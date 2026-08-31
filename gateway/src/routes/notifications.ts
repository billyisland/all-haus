import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Notification Routes
//
// GET  /notifications          — list recent notifications for current user
// POST /notifications/read-all — mark all notifications as read
// =============================================================================

export async function notificationRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /notifications — paginated notification log (newest first)
  //   ?cursor=<ISO timestamp>&limit=30
  // Returns both read and unread. Unread count is always the global total.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/notifications', { preHandler: requireAuth }, async (req, reply) => {
    const recipientId = req.session!.sub
    const limit = Math.min(parseInt(req.query.limit ?? '30', 10) || 30, 50)
    const cursor = req.query.cursor ?? null

    const cursorClause = cursor ? 'AND n.created_at < $3' : ''
    const params: (string | number)[] = [recipientId, limit + 1]
    if (cursor) params.push(cursor)

    const { rows } = await pool.query<{
      id: string
      type: string
      read: boolean
      created_at: Date
      actor_id: string | null
      actor_username: string | null
      actor_display_name: string | null
      actor_avatar: string | null
      article_id: string | null
      article_title: string | null
      article_slug: string | null
      article_writer_username: string | null
      comment_id: string | null
      comment_content: string | null
      note_id: string | null
      note_nostr_event_id: string | null
      conversation_id: string | null
      drive_id: string | null
      offer_id: string | null
      offer_code: string | null
      offer_revoked: boolean | null
    }>(
      `SELECT
         n.id, n.type, n.read, n.created_at,
         n.actor_id,
         a.username           AS actor_username,
         a.display_name       AS actor_display_name,
         a.avatar_blossom_url AS actor_avatar,
         n.article_id,
         ar.title             AS article_title,
         -- Named "slug", holds the D-TAG, and the name is the misleading half:
         -- the articles table has a real slug column and it is NOT this one (a
         -- d-tag is username-prefixed: alice-my-piece vs my-piece). The web
         -- builds /article/<this value> from the field at five sites in
         -- NotificationsPanel, and the article route keys on the d-tag — so
         -- those hrefs are CORRECT and only look like the 0q.3 bug class.
         -- Verified live rather than reasoned about: the real slug 404s there,
         -- this value 200s. Renaming the wire field would close the trap but is
         -- a client-visible change.
         ar.nostr_d_tag       AS article_slug,
         aw.username          AS article_writer_username,
         n.comment_id,
         LEFT(c.content, 200) AS comment_content,
         n.note_id,
         no.nostr_event_id    AS note_nostr_event_id,
         n.conversation_id,
         n.drive_id,
         n.offer_id,
         so.code              AS offer_code,
         (so.revoked_at IS NOT NULL) AS offer_revoked
       FROM notifications n
       LEFT JOIN accounts a   ON a.id   = n.actor_id
       LEFT JOIN articles ar  ON ar.id  = n.article_id
       LEFT JOIN accounts aw  ON aw.id  = ar.writer_id
       LEFT JOIN comments c   ON c.id   = n.comment_id
       LEFT JOIN notes no     ON no.id  = n.note_id
       LEFT JOIN subscription_offers so ON so.id = n.offer_id
       WHERE n.recipient_id = $1 AND n.type != 'new_message'
       ${cursorClause}
       ORDER BY n.created_at DESC
       LIMIT $2`,
      params
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore ? page[page.length - 1].created_at.toISOString() : null

    // Global unread count (cheap index scan)
    const { rows: countRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE recipient_id = $1 AND read = false AND type != 'new_message'`,
      [recipientId]
    )
    const unreadCount = parseInt(countRows[0].cnt, 10)

    const notifications = page.map((r) => ({
      id: r.id,
      type: r.type,
      read: r.read,
      createdAt: r.created_at.toISOString(),
      actor: r.actor_id
        ? {
            id: r.actor_id,
            username: r.actor_username,
            displayName: r.actor_display_name,
            avatar: r.actor_avatar,
          }
        : null,
      article: r.article_id
        ? { id: r.article_id, title: r.article_title, slug: r.article_slug, writerUsername: r.article_writer_username }
        : null,
      comment: r.comment_id
        ? { id: r.comment_id, content: r.comment_content }
        : null,
      note: r.note_id
        ? { id: r.note_id, nostrEventId: r.note_nostr_event_id }
        : null,
      conversationId: r.conversation_id ?? undefined,
      driveId: r.drive_id ?? undefined,
      // The CODE, not the id: /subscribe/:code is the addressing scheme, and
      // the client has no other way to reach the offer. Withheld once revoked —
      // the redeem page would 404 on it, so a live-looking link to a dead offer
      // is worse than a notification that simply no longer leads anywhere.
      offer:
        r.offer_id && r.offer_code && !r.offer_revoked
          ? { id: r.offer_id, code: r.offer_code }
          : null,
    }))

    return reply.status(200).send({ notifications, unreadCount, nextCursor })
  })

  // ---------------------------------------------------------------------------
  // GET /unread-counts — lightweight counts for nav badge
  // ---------------------------------------------------------------------------

  app.get('/unread-counts', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub

    const { rows } = await pool.query<{ notification_count: string; dm_count: string }>(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE recipient_id = $1 AND read = false AND type != 'new_message') AS notification_count,
         (SELECT COUNT(*) FROM direct_messages WHERE recipient_id = $1 AND read_at IS NULL) AS dm_count`,
      [userId]
    )

    return reply.status(200).send({
      notificationCount: parseInt(rows[0].notification_count, 10),
      dmCount: parseInt(rows[0].dm_count, 10),
    })
  })

  // ---------------------------------------------------------------------------
  // POST /notifications/:id/read — mark a single notification as read
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/read',
    { preHandler: requireAuth },
    async (req, reply) => {
      const recipientId = req.session!.sub
      const { id } = req.params

      await pool.query(
        `UPDATE notifications SET read = true WHERE id = $1 AND recipient_id = $2`,
        [id, recipientId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /notifications/read-all — mark all as read
  // ---------------------------------------------------------------------------

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (req, reply) => {
    const recipientId = req.session!.sub

    await pool.query(
      `UPDATE notifications SET read = true WHERE recipient_id = $1 AND read = false`,
      [recipientId]
    )

    logger.info({ recipientId }, 'Notifications marked as read')
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // GET /notifications/preferences — get notification preference toggles
  // ---------------------------------------------------------------------------

  const NOTIFICATION_CATEGORIES = [
    'new_follower',
    'new_reply',
    'new_mention',
    'new_quote',
    'commission_request',
    'pub_events',
    'subscription_activity',
  ] as const

  app.get('/notifications/preferences', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub

    const { rows } = await pool.query<{ category: string; enabled: boolean }>(
      'SELECT category, enabled FROM notification_preferences WHERE user_id = $1',
      [userId]
    )

    const prefs: Record<string, boolean> = {}
    for (const cat of NOTIFICATION_CATEGORIES) prefs[cat] = true
    for (const row of rows) prefs[row.category] = row.enabled

    return reply.send({ preferences: prefs })
  })

  // ---------------------------------------------------------------------------
  // PUT /notifications/preferences/:category — toggle a single category
  // ---------------------------------------------------------------------------

  app.put<{ Params: { category: string }; Body: { enabled: boolean } }>(
    '/notifications/preferences/:category',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { category } = req.params
      const { enabled } = req.body as { enabled: boolean }

      if (!NOTIFICATION_CATEGORIES.includes(category as any)) {
        return reply.status(400).send({ error: 'Invalid category' })
      }
      if (typeof enabled !== 'boolean') {
        return reply.status(400).send({ error: 'enabled must be a boolean' })
      }

      await pool.query(
        `INSERT INTO notification_preferences (user_id, category, enabled, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, category) DO UPDATE SET enabled = $3, updated_at = now()`,
        [userId, category, enabled]
      )

      return reply.send({ ok: true })
    }
  )
}
