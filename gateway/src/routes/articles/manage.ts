import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { signEvent } from '../../lib/key-custody-client.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { UUID_RE } from './shared.js'

// =============================================================================
// Writer-side article management (dashboard, edit, soft-delete, pin, unpublish)
//
// GET    /my/articles               — List the authenticated writer's articles
// PATCH  /articles/:id              — Update article metadata (replies toggle)
// DELETE /articles/:id              — Soft-delete an article + kind 5 event
// POST   /articles/:id/pin          — Toggle pin on writer's profile
// POST   /articles/:id/unpublish    — Revert a personal article to draft
// GET    /articles/deleted          — Deleted-article lookup for feed filtering
// =============================================================================

const PatchArticleSchema = z.object({
  repliesEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
})

export async function articleManageRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /my/articles — list the authenticated writer's articles
  //
  // Returns articles joined with comment counts and earnings data.
  // Used by the editorial dashboard.
  // ---------------------------------------------------------------------------

  app.get('/my/articles', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub

    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag,
                a.nostr_event_id, a.access_mode, a.price_pence,
                a.word_count, a.published_at, a.comments_enabled,
                COALESCE(c.cnt, 0)::int AS comment_count,
                COALESCE(r.read_count, 0)::int AS read_count,
                COALESCE(r.net_earnings, 0)::int AS net_earnings_pence
         FROM articles a
         LEFT JOIN (
           SELECT target_event_id, COUNT(*) AS cnt
           FROM comments WHERE deleted_at IS NULL
           GROUP BY target_event_id
         ) c ON c.target_event_id = a.nostr_event_id
         LEFT JOIN (
           SELECT article_id, COUNT(*) AS read_count,
                  SUM(amount_pence) AS net_earnings
           FROM read_events
           WHERE state IN ('platform_settled', 'writer_paid')
           GROUP BY article_id
         ) r ON r.article_id = a.id
         WHERE a.writer_id = $1 AND a.deleted_at IS NULL
         ORDER BY a.published_at DESC`,
        [writerId]
      )

      return reply.status(200).send({
        articles: rows.map(r => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          dTag: r.d_tag,
          nostrEventId: r.nostr_event_id,
          accessMode: r.access_mode,
          isPaywalled: r.access_mode === 'paywalled',
          pricePence: r.price_pence,
          wordCount: r.word_count,
          publishedAt: r.published_at?.toISOString() ?? null,
          repliesEnabled: r.comments_enabled,
          replyCount: r.comment_count,
          readCount: r.read_count,
          netEarningsPence: r.net_earnings_pence,
        })),
      })
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to load writer articles')
      return reply.status(500).send({ error: 'Failed to load articles' })
    }
  })

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id — update article metadata
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const parsed = PatchArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const writerId = req.session!.sub
      const body = parsed.data

      const updates: string[] = []
      const params: any[] = []
      let paramIdx = 1

      const repliesEnabledValue = body.repliesEnabled ?? body.commentsEnabled
      if (typeof repliesEnabledValue === 'boolean') {
        updates.push(`comments_enabled = $${paramIdx++}`)
        params.push(repliesEnabledValue)
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' })
      }

      params.push(req.params.id, writerId)
      const result = await pool.query(
        `UPDATE articles SET ${updates.join(', ')}, updated_at = now()
         WHERE id = $${paramIdx++} AND writer_id = $${paramIdx} AND deleted_at IS NULL
         RETURNING id`,
        params
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /articles/:id — soft-delete an article
  //
  // Sets deleted_at on the articles row. Also publishes a Nostr kind 5
  // deletion event to signal to the relay and federated clients.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      const { rows } = await pool.query<{ id: string; nostr_event_id: string; nostr_d_tag: string; nostr_pubkey: string }>(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.id = $1 AND a.writer_id = $2 AND a.deleted_at IS NULL`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const article = rows[0]

      // Soft-delete all live rows for this d-tag (there may be duplicates from
      // previous publishes/edits that pre-date the unique-live-row constraint).
      // Dual-write to feed_items + enqueue the kind-5 tombstone in the same
      // transaction so a crash can't leave the DB marked deleted while the
      // relay still serves the article.
      const deletionEvent = await signEvent(writerId, {
        kind: 5,
        content: '',
        tags: [
          ['e', article.nostr_event_id],
          ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      })
      await withTransaction(async (client) => {
        await client.query(
          'UPDATE articles SET deleted_at = now() WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL',
          [writerId, article.nostr_d_tag]
        )
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE article_id IN (SELECT id FROM articles WHERE writer_id = $1 AND nostr_d_tag = $2)
             AND deleted_at IS NULL`,
          [writerId, article.nostr_d_tag]
        )
        await enqueueRelayPublish(client, {
          entityType: 'article_deletion',
          entityId: article.id,
          signedEvent: deletionEvent as SignedNostrEvent,
        })
      })

      logger.info(
        { articleId: article.id, nostrEventId: article.nostr_event_id, deletionEventId: deletionEvent.id, writerId },
        'Article soft-deleted and deletion event enqueued'
      )

      return reply.status(200).send({
        ok: true,
        deletedArticleId: article.id,
        nostrEventId: article.nostr_event_id,
        dTag: article.nostr_d_tag,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:id/pin — toggle pin on writer's profile
  //
  // Writers can pin articles to the top of their profile's Work tab.
  // Follows the same toggle pattern as POST /drives/:id/pin.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/articles/:id/pin',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const writerId = req.session!.sub

      const result = await pool.query<{ id: string; pinned_on_profile: boolean }>(
        `UPDATE articles SET pinned_on_profile = NOT pinned_on_profile, updated_at = now()
         WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL
         RETURNING id, pinned_on_profile`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      return reply.status(200).send({ pinned: result.rows[0].pinned_on_profile })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:id/unpublish — revert a personal article to draft
  //
  // Sets published_at = NULL so the article disappears from the writer's
  // public profile and the feed, but remains accessible as a draft.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/articles/:id/unpublish',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.params.id.match(UUID_RE)) {
        return reply.status(400).send({ error: 'Invalid article ID' })
      }

      const writerId = req.session!.sub

      const result = await pool.query<{ id: string }>(
        `UPDATE articles SET published_at = NULL, updated_at = now()
         WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL AND published_at IS NOT NULL
           AND publication_id IS NULL
         RETURNING id`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found or already unpublished' })
      }

      // Remove from feed (unpublished articles are drafts, not in the feed)
      await pool.query(
        `DELETE FROM feed_items WHERE article_id = $1`,
        [req.params.id]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /articles/deleted?pubkeys=<hex>,<hex>,…
  //
  // Returns recently deleted article identifiers for the given Nostr pubkeys.
  // Used by the feed to cross-reference the DB's soft-delete state against
  // events returned from the relay, so feed filtering doesn't rely solely on
  // kind 5 events having been successfully published.
  //
  // Looks back 90 days — long enough that any article a follower could
  // reasonably encounter in a paginated feed is covered.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { pubkeys?: string } }>(
    '/articles/deleted',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = req.query.pubkeys ?? ''
      const pubkeys = raw.split(',').map(s => s.trim()).filter(Boolean)

      if (pubkeys.length === 0) {
        return reply.status(200).send({ deletedEventIds: [], deletedCoords: [] })
      }

      const { rows } = await pool.query<{
        nostr_event_id: string
        nostr_d_tag: string
        nostr_pubkey: string
      }>(
        `SELECT a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE acc.nostr_pubkey = ANY($1)
           AND a.deleted_at IS NOT NULL
           AND a.deleted_at > now() - interval '90 days'`,
        [pubkeys]
      )

      return reply.status(200).send({
        deletedEventIds: rows.map(r => r.nostr_event_id),
        deletedCoords: rows.map(r => `30023:${r.nostr_pubkey}:${r.nostr_d_tag}`),
      })
    }
  )
}
