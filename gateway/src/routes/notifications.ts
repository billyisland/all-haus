import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { parseTimestampCursor } from '@platform-pub/shared/lib/timestamp-cursor.js'
import { isUuid, parseLimit } from '../lib/request-inputs.js'
import { hiddenFromViewerSql } from '../lib/blocks.js'

// =============================================================================
// Notification Routes
//
// GET  /notifications          — list recent notifications for current user
// POST /notifications/read-all — mark all notifications as read
//
// MUTES AND BLOCKS ARE APPLIED ON THE READ SIDE (W2, 2026-09-24). A row whose
// actor the recipient has muted, or with whom a block runs either way, is left
// out of the list AND out of both unread counts — one predicate, `VISIBLE`
// below, so the badge can never promise a notification the panel will not
// show. Filtered here rather than refused at the insert, so the rows are still
// written and an UNMUTE brings them back; a system row with no actor is never
// hidden. Mark-read writes are deliberately unfiltered: marking a hidden row
// read is harmless, and leaving it unread would resurface it as new on unmute.
// =============================================================================

const VISIBLE = `NOT ${hiddenFromViewerSql('$1', 'n.actor_id')}`

/** `<created_at::text>|<uuid>`, or the bare timestamp older clients hold.
 *  Null for anything else — the caller answers 400 rather than letting the
 *  value reach a cast. */
export function parseNotificationCursor(raw: string): { at: string; id: string | null } | null {
  const bar = raw.lastIndexOf('|')
  if (bar === -1) {
    const at = parseTimestampCursor(raw)
    return at ? { at, id: null } : null
  }
  const at = parseTimestampCursor(raw.slice(0, bar))
  const id = raw.slice(bar + 1)
  if (!at || !isUuid(id)) return null
  return { at, id }
}

export async function notificationRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /notifications — paginated notification log (newest first)
  //   ?cursor=<ISO timestamp>&limit=30
  // Returns both read and unread. Unread count is always the global total.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/notifications', { preHandler: requireAuth }, async (req, reply) => {
    const recipientId = req.session!.sub
    const limit = parseLimit(req.query.limit, 30, 50)
    // The cursor is carried as `created_at::text` and fed back as
    // `$3::timestamptz` — never through a JS Date, which would drop the
    // microseconds. This is a DESCENDING cursor compared with `<`, so a
    // truncated position skips the rows inside the lost microsecond rather than
    // repeating them: a notification nobody ever sees. See the header of
    // shared/lib/timestamp-cursor.ts. Malformed reaches Postgres as a cast
    // error, so it is a 400 here rather than a 500 with a DB message in it.
    //
    // AND IT CARRIES THE ROW ID AS A TIEBREAK (CA-B12, 2026-09-29):
    // `<created_at::text>|<id>`, compared as a row `(n.created_at, n.id) <
    // ($3, $4)` under `ORDER BY n.created_at DESC, n.id DESC`, so two rows
    // sharing an instant cannot straddle a page boundary. A bare timestamp —
    // the shape every client minted before this change — is still accepted
    // and compared as it was, so no open pagination 400s on deploy.
    const rawCursor = req.query.cursor ?? null
    const cursor = rawCursor === null ? null : parseNotificationCursor(rawCursor)
    if (rawCursor !== null && cursor === null) {
      return reply.status(400).send({ error: 'invalid_cursor' })
    }

    const cursorClause = cursor
      ? cursor.id
        ? 'AND (n.created_at, n.id) < ($3::timestamptz, $4::uuid)'
        : 'AND n.created_at < $3::timestamptz'
      : ''
    const params: (string | number)[] = [recipientId, limit + 1]
    if (cursor) {
      params.push(cursor.at)
      if (cursor.id) params.push(cursor.id)
    }

    const { rows } = await pool.query<{
      id: string
      type: string
      read: boolean
      created_at: Date
      created_at_exact: string
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
      parent_comment_id: string | null
      note_id: string | null
      note_nostr_event_id: string | null
      focus_post_id: string | null
      focus_is_reply: boolean
      conversation_id: string | null
      drive_id: string | null
      offer_id: string | null
      offer_code: string | null
      offer_revoked: boolean | null
      publication_id: string | null
      publication_name: string | null
      publication_slug: string | null
      cross_post_failures: { protocol: string; error: string | null }[] | null
      external_item_id: string | null
      ext_protocol: string | null
      ext_author_name: string | null
      ext_author_handle: string | null
      ext_author_avatar: string | null
      ext_author_id: string | null
      ext_excerpt: string | null
    }>(
      `SELECT
         n.id, n.type, n.read, n.created_at,
         n.created_at::text   AS created_at_exact,
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
         -- THE COMMENT THAT WAS REPLIED TO, and it is a different comment from
         -- the one above (migration 230). comment_id is the NEW reply -- what
         -- the panel renders and what focus_post_id opens; this is the remark
         -- it answers, bound only on the row whose recipient is that remark's
         -- author. Its PRESENCE is the whole payload, so no join: the client
         -- needs to know which of the two sentences it is holding ("replied to
         -- your comment" against "replied to <title>"), not what the recipient
         -- already wrote and can read on the page it opens.
         n.parent_comment_id,
         n.note_id,
         no.nostr_event_id    AS note_nostr_event_id,
         -- THE CONVERSATION THIS ROW IS ABOUT, addressed the way a card is.
         -- A notification that names a person because it is about something
         -- they WROTE has to be able to say which thing, or the profile it
         -- opens is the right person and the wrong page. post_id is that
         -- address, and for a native note or comment it is the event-id
         -- derivation -- NOT a read of feed_items (post-mapper.ts: "a NOTE
         -- target falls THROUGH to the event-id derivation, which is its real
         -- post_id"), which also keeps this off the squattable table and its
         -- LIMIT 1. Verified rather than reasoned: over all 88 notes in dev,
         -- the stored feed_items.post_id and this derivation agree on every
         -- one.
         --
         -- THE COMMENT WINS WHERE THERE IS ONE, because that is where the
         -- mention was written -- POST /replies binds article_id/note_id AND
         -- comment_id, so the note here is the thing commented ON, not the
         -- thing to open.
         CASE
           WHEN c.nostr_event_id IS NOT NULL
             THEN feed_items_derive_post_id('nostr', c.nostr_event_id)
           WHEN no.nostr_event_id IS NOT NULL
             THEN feed_items_derive_post_id('nostr', no.nostr_event_id)
         END                  AS focus_post_id,
         (c.nostr_event_id IS NOT NULL) AS focus_is_reply,
         -- Selected, and bound by no insert anywhere — see the column COMMENT
         -- (migration 198). Kept on the wire because the client already
         -- declares it; binding it is a product decision, not a repair.
         n.conversation_id,
         n.drive_id,
         n.offer_id,
         so.code              AS offer_code,
         (so.revoked_at IS NOT NULL) AS offer_revoked,
         -- The publication a pub_* notification is about (migration 198). It
         -- is what makes the row DISTINGUISHABLE now that two publications no
         -- longer collapse into one: "invited you to a publication" twice is
         -- worse than once, and naming it is the other half of the fix.
         n.publication_id,
         p.name               AS publication_name,
         p.slug               AS publication_slug,
         -- WHICH NETWORKS A NOTE NEVER REACHED, AND WHY (cross_post_failed,
         -- CROSS-NETWORK-ROUNDTRIP-ADR A7). One row stands for every failed
         -- target of its note (the dedup index collapses them), so the list is
         -- read here, live, rather than bound at the insert. Scoped to the
         -- recipient's own rows by the leading columns of
         -- uniq_outbound_posts_dedup. The message is the worker's; the
         -- adapters write the member-facing ones ("Reconnect your Mastodon
         -- account…"), and it is truncated because an ambiguous failure that
         -- exhausted its retries carries the far end's body.
         CASE WHEN n.type = 'cross_post_failed' THEN (
           SELECT json_agg(json_build_object(
                    'protocol', op.protocol,
                    'error', LEFT(op.error_message, 240))
                  ORDER BY op.created_at)
             FROM outbound_posts op
            WHERE op.account_id = n.recipient_id
              AND op.nostr_event_id = no.nostr_event_id
              AND op.status = 'failed'
         ) END                AS cross_post_failures,
         -- THE EXTERNAL POST an external_reply / _mention / _quote is about
         -- (CROSS-NETWORK-ROUNDTRIP-ADR C3, migration 236). The replier is not
         -- a member, so actor_id is NULL and the row names them from the post
         -- itself: its own author fields, never its source's (a context row's
         -- source is its author's shadow, but the rule is the byline's). The
         -- external_authors id is what a profile pane opens on.
         n.external_item_id,
         ei.protocol::text    AS ext_protocol,
         NULLIF(ei.author_name, '') AS ext_author_name,
         ei.author_handle     AS ext_author_handle,
         ei.author_avatar_url AS ext_author_avatar,
         efi.external_author_id AS ext_author_id,
         LEFT(ei.content_text, 200) AS ext_excerpt
       FROM notifications n
       LEFT JOIN accounts a   ON a.id   = n.actor_id
       LEFT JOIN articles ar  ON ar.id  = n.article_id
       LEFT JOIN accounts aw  ON aw.id  = ar.writer_id
       LEFT JOIN comments c   ON c.id   = n.comment_id
       LEFT JOIN notes no     ON no.id  = n.note_id
       LEFT JOIN subscription_offers so ON so.id = n.offer_id
       LEFT JOIN publications p ON p.id = n.publication_id
       LEFT JOIN external_items ei ON ei.id = n.external_item_id
       LEFT JOIN feed_items efi ON efi.external_item_id = n.external_item_id
       WHERE n.recipient_id = $1 AND n.type != 'new_message'
         AND ${VISIBLE}
       ${cursorClause}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2`,
      params
    )

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore
      ? `${page[page.length - 1].created_at_exact}|${page[page.length - 1].id}`
      : null

    // Global unread count (cheap index scan)
    const { rows: countRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications n
        WHERE n.recipient_id = $1 AND n.read = false AND n.type != 'new_message'
          AND ${VISIBLE}`,
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
      // Nested rather than a bare id, so it reads like its siblings and can
      // grow one. Null is the ordinary case and means "this row is not about a
      // comment of yours" -- on a `new_reply` that is the root author's copy,
      // and on every other type it is simply never set.
      parentComment: r.parent_comment_id ? { id: r.parent_comment_id } : null,
      note: r.note_id
        ? { id: r.note_id, nostrEventId: r.note_nostr_event_id }
        : null,
      // The view is the POPULATION the post belongs to on a profile, which is
      // what decides which of the five the pane opens on: a kind-1111 comment
      // is a reply, a note is a post. Absent for everything not about a piece
      // of writing (a follow, a subscription, an invite), and the pane then
      // opens where it always has.
      focus: r.focus_post_id
        ? {
            postId: r.focus_post_id,
            view: r.focus_is_reply ? ("replies" as const) : ("posts" as const),
          }
        : null,
      publication: r.publication_id
        ? { id: r.publication_id, name: r.publication_name, slug: r.publication_slug }
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
      ...(r.type === 'cross_post_failed'
        ? { crossPostFailures: r.cross_post_failures ?? [] }
        : {}),
      // Only on the three external types. Where the post answers or quotes one
      // of the recipient's own cross-posts the row also carries `note` and
      // `focus` (bound by the poller), and the pane opens on that
      // conversation; otherwise the author is who it can open on.
      external: r.external_item_id
        ? {
            itemId: r.external_item_id,
            protocol: r.ext_protocol,
            authorName: r.ext_author_name,
            authorHandle: r.ext_author_handle,
            authorAvatar: r.ext_author_avatar,
            authorId: r.ext_author_id,
            excerpt: r.ext_excerpt,
          }
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
         (SELECT COUNT(*) FROM notifications n
           WHERE n.recipient_id = $1 AND n.read = false AND n.type != 'new_message'
             AND ${VISIBLE}) AS notification_count,
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
      if (!isUuid(id)) {
        return reply.status(404).send({ error: 'not_found' })
      }

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
