import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'

// =============================================================================
// Bookmark Routes
//
// POST   /bookmarks/:nostrEventId — bookmark an article (by Nostr event ID)
// DELETE /bookmarks/:nostrEventId — remove bookmark
// GET    /bookmarks               — list bookmarked articles (newest first)
// GET    /bookmarks/ids           — list bookmarked Nostr event IDs (for feed)
// =============================================================================

const HEX64_RE = /^[0-9a-f]{64}$/

export async function bookmarkRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /bookmarks/:nostrEventId — add bookmark
  // ---------------------------------------------------------------------------

  app.post<{ Params: { nostrEventId: string } }>(
    '/bookmarks/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { nostrEventId } = req.params

      if (!nostrEventId.match(HEX64_RE)) {
        return reply.status(400).send({ error: 'Invalid event ID' })
      }

      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL',
        [nostrEventId]
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      await pool.query(
        `INSERT INTO bookmarks (user_id, article_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, article_id) DO NOTHING`,
        [userId, rows[0].id]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /bookmarks/:nostrEventId — remove bookmark
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { nostrEventId: string } }>(
    '/bookmarks/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { nostrEventId } = req.params

      if (!nostrEventId.match(HEX64_RE)) {
        return reply.status(400).send({ error: 'Invalid event ID' })
      }

      await pool.query(
        `DELETE FROM bookmarks
         WHERE user_id = $1
           AND article_id = (SELECT id FROM articles WHERE nostr_event_id = $2)`,
        [userId, nostrEventId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /bookmarks — list bookmarked articles (newest bookmark first)
  //   ?limit=20&offset=0
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/bookmarks',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10) || 20, 50)
      const offset = parseInt(req.query.offset ?? '0', 10) || 0

      const { rows } = await pool.query(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.slug, a.summary,
                a.word_count, a.access_mode, a.price_pence, a.published_at,
                acc.username AS author_username, acc.display_name AS author_display_name,
                acc.nostr_pubkey AS author_pubkey, acc.avatar_blossom_url AS author_avatar,
                b.created_at AS bookmarked_at
         FROM bookmarks b
         JOIN articles a ON a.id = b.article_id
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE b.user_id = $1 AND a.deleted_at IS NULL AND a.published_at IS NOT NULL
         ORDER BY b.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit + 1, offset]
      )

      const hasMore = rows.length > limit
      const articles = rows.slice(0, limit)

      return reply.send({ articles, hasMore })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /bookmarks/ids — lightweight list of bookmarked Nostr event IDs
  //   Used by the feed to mark which articles are bookmarked.
  // ---------------------------------------------------------------------------

  app.get('/bookmarks/ids', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub

    const { rows } = await pool.query<{ nostr_event_id: string }>(
      `SELECT a.nostr_event_id FROM bookmarks b
       JOIN articles a ON a.id = b.article_id
       WHERE b.user_id = $1`,
      [userId]
    )

    return reply.send({ eventIds: rows.map(r => r.nostr_event_id) })
  })
}
