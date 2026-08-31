import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Gift Link Routes
//
// POST   /articles/:articleId/gift-link           — create a capped gift link
// GET    /articles/:articleId/gift-links           — list gift links (author view)
// DELETE /articles/:articleId/gift-link/:linkId    — revoke a gift link
// POST   /articles/:articleId/redeem-gift          — redeem a gift link token
// =============================================================================

export async function giftLinkRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /articles/:articleId/gift-link — create a capped gift link
  // ---------------------------------------------------------------------------

  const CreateGiftLinkSchema = z.object({
    maxRedemptions: z.number().int().min(1).max(1000).default(5),
  })

  app.post<{ Params: { articleId: string } }>(
    '/articles/:articleId/gift-link',
    { preHandler: requireAuth },
    async (req, reply) => {
      const creatorId = req.session!.sub
      const { articleId } = req.params

      const parsed = CreateGiftLinkSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      // Verify author owns the article
      const article = await pool.query<{ id: string; nostr_d_tag: string }>(
        'SELECT id, nostr_d_tag FROM articles WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL',
        [articleId, creatorId]
      )
      if (article.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const token = crypto.randomBytes(16).toString('base64url')
      const { maxRedemptions } = parsed.data

      const { rows } = await pool.query<{ id: string; token: string }>(
        `INSERT INTO gift_links (article_id, creator_id, token, max_redemptions)
         VALUES ($1, $2, $3, $4)
         RETURNING id, token`,
        [articleId, creatorId, token, maxRedemptions]
      )

      const dTag = article.rows[0].nostr_d_tag
      const url = `/article/${dTag}?gift=${rows[0].token}`

      logger.info({ creatorId, articleId, token, maxRedemptions }, 'Gift link created')
      return reply.status(201).send({
        id: rows[0].id,
        token: rows[0].token,
        url,
        maxRedemptions,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /articles/:articleId/gift-links — list gift links (author view)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { articleId: string } }>(
    '/articles/:articleId/gift-links',
    { preHandler: requireAuth },
    async (req, reply) => {
      const creatorId = req.session!.sub
      const { articleId } = req.params

      // Verify author owns the article
      const article = await pool.query<{ id: string }>(
        'SELECT id FROM articles WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL',
        [articleId, creatorId]
      )
      if (article.rowCount === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const { rows } = await pool.query<{
        id: string
        token: string
        max_redemptions: number
        redemption_count: number
        revoked_at: Date | null
        created_at: Date
      }>(
        `SELECT id, token, max_redemptions, redemption_count, revoked_at, created_at
         FROM gift_links
         WHERE article_id = $1 AND creator_id = $2
         ORDER BY created_at DESC`,
        [articleId, creatorId]
      )

      return reply.status(200).send({
        giftLinks: rows.map(r => ({
          id: r.id,
          token: r.token,
          maxRedemptions: r.max_redemptions,
          redemptionCount: r.redemption_count,
          revoked: r.revoked_at !== null,
          createdAt: r.created_at.toISOString(),
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /articles/:articleId/gift-link/:linkId — revoke a gift link
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { articleId: string; linkId: string } }>(
    '/articles/:articleId/gift-link/:linkId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const creatorId = req.session!.sub
      const { articleId, linkId } = req.params

      const result = await pool.query(
        `UPDATE gift_links SET revoked_at = now()
         WHERE id = $1 AND article_id = $2 AND creator_id = $3 AND revoked_at IS NULL`,
        [linkId, articleId, creatorId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Gift link not found' })
      }

      logger.info({ creatorId, articleId, linkId }, 'Gift link revoked')
      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:articleId/redeem-gift — redeem a gift link token
  // ---------------------------------------------------------------------------

  app.post<{ Params: { articleId: string }; Body: { token: string } }>(
    '/articles/:articleId/redeem-gift',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { articleId } = req.params
      const { token } = req.body as { token: string }

      if (!token) {
        return reply.status(400).send({ error: 'Token is required' })
      }

      // Validate and atomically redeem
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE gift_links
         SET redemption_count = redemption_count + 1
         WHERE token = $1 AND article_id = $2
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
           AND redemption_count < max_redemptions
         RETURNING id`,
        [token, articleId]
      )

      if (rows.length === 0) {
        return reply.status(410).send({ error: 'Gift link is expired, revoked, or fully redeemed' })
      }

      // Grant access
      await pool.query(
        `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
         VALUES ($1, $2, 'author_grant')
         ON CONFLICT (reader_id, article_id) DO NOTHING`,
        [readerId, articleId]
      )

      logger.info({ readerId, articleId, token }, 'Gift link redeemed')
      return reply.status(200).send({ ok: true, unlocked: true })
    }
  )
}
