import type { FastifyInstance } from 'fastify'
import crypto from 'node:crypto'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { requireWriter } from '../lib/writer-gate.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { isUuid } from '../lib/request-inputs.js'

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
    { preHandler: [requireAuth, requireWriter] },
    async (req, reply) => {
      const creatorId = req.session!.sub
      const { articleId } = req.params
      if (!isUuid(articleId)) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      const parsed = CreateGiftLinkSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
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

      // THE LINK'S ID, NEVER ITS TOKEN. The token is a bearer capability: it
      // grants free access to a paywalled article to whoever holds it, and
      // writing it to the log hands that capability to everyone who can read
      // the log (and to whatever aggregator ships it onward) for as long as the
      // link is live. The id identifies the row for support and audit and
      // unlocks nothing — the same split as the S15 finding about the inbound
      // mail secret in the URL path.
      logger.info(
        { creatorId, articleId, giftLinkId: rows[0].id, maxRedemptions },
        'Gift link created',
      )
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
      if (!isUuid(articleId)) {
        return reply.status(404).send({ error: 'Article not found' })
      }

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
      if (!isUuid(articleId) || !isUuid(linkId)) {
        return reply.status(404).send({ error: 'Gift link not found' })
      }

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

  // A REDEMPTION IS SPENT ONLY WHERE IT GRANTED SOMETHING (CA-B6, 2026-09-29).
  // This incremented `redemption_count` in an autocommit UPDATE and then
  // inserted the unlock `ON CONFLICT DO NOTHING` — so a reader who already
  // held the piece (a prior redemption, a purchase, a second device) or the
  // writer themselves burned one of the link's redemptions and got nothing
  // for it. Now, in ONE transaction: the link is read `FOR UPDATE` and its
  // three refusals asked; the unlock is `INSERT … RETURNING`; and the count
  // moves only where a row came back. The body is validated like every
  // other route's — `req.body.token` on an absent body was a 500.
  app.post<{ Params: { articleId: string } }>(
    '/articles/:articleId/redeem-gift',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { articleId } = req.params
      // The answer a well-formed id naming no link already gets.
      if (!isUuid(articleId)) {
        return reply.status(410).send({ error: 'Gift link is expired, revoked, or fully redeemed' })
      }
      const parsed = z.object({ token: z.string().min(1) }).safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }
      const { token } = parsed.data

      const outcome = await withTransaction(async (client) => {
        const { rows: links } = await client.query<{
          id: string
          revoked_at: Date | null
          expires_at: Date | null
          redemption_count: number
          max_redemptions: number
        }>(
          `SELECT id, revoked_at, expires_at, redemption_count, max_redemptions
             FROM gift_links
            WHERE token = $1 AND article_id = $2
            FOR UPDATE`,
          [token, articleId],
        )
        const link = links[0]
        if (
          !link ||
          link.revoked_at !== null ||
          (link.expires_at !== null && link.expires_at.getTime() <= Date.now()) ||
          Number(link.redemption_count) >= Number(link.max_redemptions)
        ) {
          return { kind: 'refused' as const }
        }
        const { rows: granted } = await client.query(
          `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
           VALUES ($1, $2, 'author_grant')
           ON CONFLICT (reader_id, article_id) DO NOTHING
           RETURNING reader_id`,
          [readerId, articleId],
        )
        if (granted.length === 0) {
          return { kind: 'already_unlocked' as const, linkId: link.id }
        }
        await client.query(
          `UPDATE gift_links SET redemption_count = redemption_count + 1 WHERE id = $1`,
          [link.id],
        )
        return { kind: 'redeemed' as const, linkId: link.id }
      })

      if (outcome.kind === 'refused') {
        return reply.status(410).send({ error: 'Gift link is expired, revoked, or fully redeemed' })
      }

      // Again the row id, not the bearer token — and here it is the id the
      // locked read returned, so the line still names exactly which link was
      // spent, and says when it was not.
      logger.info(
        { readerId, articleId, giftLinkId: outcome.linkId, redeemed: outcome.kind === 'redeemed' },
        outcome.kind === 'redeemed' ? 'Gift link redeemed' : 'Gift link presented for a piece the reader already holds — nothing spent',
      )
      return reply.status(200).send({ ok: true, unlocked: true, redeemed: outcome.kind === 'redeemed' })
    }
  )
}
