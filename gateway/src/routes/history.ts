import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'

// =============================================================================
// Reading History Routes
//
// GET /my/reading-history?limit=50&offset=0
//   Returns the current reader's previously-read articles, most recent first.
//   Deduplicates by article (DISTINCT ON) so each article appears only once.
// =============================================================================

export async function historyRoutes(app: FastifyInstance) {

  app.get('/my/reading-history', { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub
    const query = req.query as { limit?: string; offset?: string }
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50', 10) || 50))
    const offset = Math.max(0, parseInt(query.offset ?? '0', 10) || 0)

    // DISTINCT ON deduplicates by article; the outer ORDER BY sorts the results
    // by most-recently-read first.
    const { rows } = await pool.query<{
      article_id: string
      read_at: Date
      title: string | null
      slug: string | null
      nostr_d_tag: string | null
      word_count: number | null
      access_mode: string
      writer_username: string | null
      writer_display_name: string | null
      writer_avatar: string | null
    }>(
      `SELECT *
       FROM (
         SELECT DISTINCT ON (re.article_id)
           re.article_id,
           re.created_at AS read_at,
           a.title,
           a.slug,
           a.nostr_d_tag,
           a.word_count,
           a.access_mode,
           w.username          AS writer_username,
           w.display_name      AS writer_display_name,
           w.avatar_blossom_url AS writer_avatar
         FROM read_events re
         JOIN articles a ON a.id = re.article_id AND a.deleted_at IS NULL
         JOIN accounts w ON w.id = a.writer_id
         WHERE re.reader_id = $1
         ORDER BY re.article_id, re.created_at DESC
       ) sub
       ORDER BY read_at DESC
       LIMIT $2 OFFSET $3`,
      [readerId, limit, offset]
    )

    const items = rows.map((r) => ({
      articleId: r.article_id,
      readAt: r.read_at.toISOString(),
      title: r.title,
      slug: r.slug,
      dTag: r.nostr_d_tag,
      wordCount: r.word_count,
      accessMode: r.access_mode,
      isPaywalled: r.access_mode === 'paywalled',
      writer: {
        username: r.writer_username,
        displayName: r.writer_display_name,
        avatar: r.writer_avatar,
      },
    }))

    return reply.status(200).send({ items })
  })
}
