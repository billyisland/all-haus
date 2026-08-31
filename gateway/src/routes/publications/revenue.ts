import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { requirePublicationPermission } from '../../middleware/publication-auth.js'
import { readNetSql } from '@platform-pub/shared/lib/per-read-net.js'

// =============================================================================
// Publication revenue — rate card, payroll (standing shares + per-article
// overrides), and earnings dashboard.
//
// GET   /publications/:id/rate-card                          — View pricing
// PATCH /publications/:id/rate-card                          — Update pricing
// GET   /publications/:id/payroll                            — View payroll
// PATCH /publications/:id/payroll                            — Standing shares
// PATCH /publications/:id/payroll/article/:articleId         — Per-article override
// GET   /publications/:id/earnings                           — Revenue dashboard
// =============================================================================

const RateCardSchema = z.object({
  subscriptionPricePence: z.number().int().min(0).max(999999).optional(),
  annualDiscountPct: z.number().int().min(0).max(100).optional(),
  defaultArticlePricePence: z.number().int().min(0).max(999999).optional(),
  articlePriceMode: z.enum(['per_article', 'per_1000_words']).optional(),
})

const UpdatePayrollSchema = z.object({
  shares: z.array(z.object({
    memberId: z.string().uuid(),
    revenueShareBps: z.number().int().min(0).max(10000),
  })),
})

const ArticleShareSchema = z.object({
  accountId: z.string().uuid(),
  shareType: z.enum(['revenue_bps', 'flat_fee_pence']),
  shareValue: z.number().int().min(0),
})

export async function publicationRevenueRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /publications/:id/rate-card — View pricing
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/rate-card',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params
      const { rows } = await pool.query<{
        subscription_price_pence: number
        annual_discount_pct: number
        default_article_price_pence: number
        article_price_mode: string
      }>(
        `SELECT subscription_price_pence, annual_discount_pct, default_article_price_pence, article_price_mode
         FROM publications WHERE id = $1`,
        [id]
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'Publication not found' })
      const r = rows[0]
      return reply.send({
        subscriptionPricePence: r.subscription_price_pence,
        annualDiscountPct: r.annual_discount_pct,
        defaultArticlePricePence: r.default_article_price_pence,
        articlePriceMode: r.article_price_mode,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/rate-card — Update pricing
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id/rate-card',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = RateCardSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { subscriptionPricePence, annualDiscountPct, defaultArticlePricePence, articlePriceMode } = parsed.data

      const sets: string[] = []
      const vals: any[] = []
      let idx = 1

      if (subscriptionPricePence !== undefined) { sets.push(`subscription_price_pence = $${idx++}`); vals.push(subscriptionPricePence) }
      if (annualDiscountPct !== undefined) { sets.push(`annual_discount_pct = $${idx++}`); vals.push(annualDiscountPct) }
      if (defaultArticlePricePence !== undefined) { sets.push(`default_article_price_pence = $${idx++}`); vals.push(defaultArticlePricePence) }
      if (articlePriceMode !== undefined) { sets.push(`article_price_mode = $${idx++}`); vals.push(articlePriceMode) }

      if (sets.length === 0) return reply.status(400).send({ error: 'No fields to update' })

      sets.push(`updated_at = now()`)
      vals.push(req.params.id)

      await pool.query(
        `UPDATE publications SET ${sets.join(', ')} WHERE id = $${idx}`,
        vals
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:id/payroll — View payroll card
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/payroll',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params

      // Standing members with their shares
      const { rows: members } = await pool.query(
        `SELECT pm.id AS member_id, pm.account_id, pm.role, pm.contributor_type, pm.title,
                pm.revenue_share_bps, pm.is_owner,
                a.username, a.display_name, a.avatar_blossom_url
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL
         ORDER BY pm.revenue_share_bps DESC NULLS LAST, a.display_name ASC`,
        [id]
      )

      // Per-article overrides
      const { rows: articleShares } = await pool.query(
        `SELECT pas.id, pas.article_id, pas.account_id, pas.share_type, pas.share_value, pas.paid_out,
                art.title AS article_title, art.slug AS article_slug,
                a.username, a.display_name
         FROM publication_article_shares pas
         JOIN articles art ON art.id = pas.article_id
         JOIN accounts a ON a.id = pas.account_id
         WHERE pas.publication_id = $1
         ORDER BY art.published_at DESC NULLS LAST`,
        [id]
      )

      const totalStandingBps = members.reduce((sum: number, m: any) => sum + (m.revenue_share_bps || 0), 0)

      return reply.send({
        members: members.map((m: any) => ({
          memberId: m.member_id,
          accountId: m.account_id,
          username: m.username,
          displayName: m.display_name,
          avatarBlossomUrl: m.avatar_blossom_url,
          role: m.role,
          contributorType: m.contributor_type,
          title: m.title,
          isOwner: m.is_owner,
          revenueShareBps: m.revenue_share_bps,
        })),
        articleShares: articleShares.map((s: any) => ({
          id: s.id,
          articleId: s.article_id,
          accountId: s.account_id,
          username: s.username,
          displayName: s.display_name,
          articleTitle: s.article_title,
          articleSlug: s.article_slug,
          shareType: s.share_type,
          shareValue: s.share_value,
          paidOut: s.paid_out,
        })),
        totalStandingBps,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/payroll — Update standing shares
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/publications/:id/payroll',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = UpdatePayrollSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { shares } = parsed.data

      const { id } = req.params

      // F10 hardening (2026-07-06 audit P1): the cap must hold over the FINAL
      // state of ALL members, not the submitted subset — a partial payload
      // (member A at 10000) previously left unlisted member B's 5000 in place,
      // Σ 15000. The advisory lock serialises concurrent share edits (this
      // route and the member PATCH share the key), closing the
      // read-then-write race both guards otherwise have.
      return withTransaction(async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('pub_shares:' || $1::text))`,
          [id]
        )

        const { rows: members } = await client.query<{ id: string; revenue_share_bps: number }>(
          `SELECT id, revenue_share_bps FROM publication_members
           WHERE publication_id = $1 AND removed_at IS NULL`,
          [id]
        )
        const currentBps = new Map(members.map(m => [m.id, m.revenue_share_bps]))
        for (const s of shares) {
          if (!currentBps.has(s.memberId)) {
            return reply.status(400).send({ error: `Member ${s.memberId} not found in this publication` })
          }
        }

        const submitted = new Map(shares.map(s => [s.memberId, s.revenueShareBps]))
        let totalBps = 0
        for (const [memberId, bps] of currentBps) {
          totalBps += submitted.get(memberId) ?? bps
        }
        if (totalBps > 10000) {
          return reply.status(400).send({ error: 'Total standing shares cannot exceed 10,000 bps (100%)' })
        }

        for (const s of shares) {
          await client.query(
            `UPDATE publication_members SET revenue_share_bps = $1, updated_at = now()
             WHERE id = $2 AND publication_id = $3`,
            [s.revenueShareBps, s.memberId, id]
          )
        }

        return reply.send({ ok: true, totalBps })
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/payroll/article/:articleId — Per-article override
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; articleId: string } }>(
    '/publications/:id/payroll/article/:articleId',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const parsed = ArticleShareSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
      const { accountId, shareType, shareValue } = parsed.data
      const { id, articleId } = req.params

      // Verify article belongs to this publication
      const { rows: articles } = await pool.query(
        `SELECT id FROM articles WHERE id = $1 AND publication_id = $2`,
        [articleId, id]
      )
      if (articles.length === 0) {
        return reply.status(404).send({ error: 'Article not found in this publication' })
      }

      // F10: revenue_bps is a FIXED share of the article's revenue — the sum of
      // all revenue_bps overrides on one article cannot exceed 10,000 bps (100%).
      // A single override is capped at 10,000; the total (this upsert + the other
      // recipients' existing revenue_bps shares on this article) is checked too.
      if (shareType === 'revenue_bps') {
        if (shareValue > 10000) {
          return reply.status(400).send({ error: 'A revenue share cannot exceed 10,000 bps (100%)' })
        }
        const { rows: [otherBps] } = await pool.query<{ sum: string }>(
          `SELECT COALESCE(SUM(share_value), 0) AS sum
             FROM publication_article_shares
            WHERE article_id = $1 AND share_type = 'revenue_bps' AND account_id <> $2`,
          [articleId, accountId]
        )
        if (parseInt(otherBps.sum, 10) + shareValue > 10000) {
          return reply.status(400).send({
            error: 'Total revenue shares for this article cannot exceed 10,000 bps (100%)',
          })
        }
      }

      // Upsert the share
      await pool.query(
        `INSERT INTO publication_article_shares (publication_id, article_id, account_id, share_type, share_value)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (article_id, account_id) DO UPDATE SET
           share_type = EXCLUDED.share_type,
           share_value = EXCLUDED.share_value,
           paid_out = FALSE`,
        [id, articleId, accountId, shareType, shareValue]
      )

      return reply.send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:id/earnings — Revenue dashboard data
  // ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/publications/:id/earnings',
    { preHandler: [requireAuth, requirePublicationPermission('can_manage_finances')] },
    async (req, reply) => {
      const { id } = req.params

      // Load platform fee from config
      const { rows: feeRows } = await pool.query<{ value: string }>(
        `SELECT value FROM platform_config WHERE key = 'platform_fee_bps'`
      )
      const feeBps = feeRows.length > 0 ? parseInt(feeRows[0].value, 10) : 800

      // Summary totals: gross reads for publication articles, net after platform fee.
      // Keyed on the denormalised r.publication_id — the same column the payout
      // cycle selects/claims on — never articles.publication_id (an article
      // moving publications must not re-home its historical reads; the display
      // must match what the pool actually distributes).
      const { rows: [summary] } = await pool.query<{
        gross_pence: string
        net_pence: string
        pending_pence: string
        paid_pence: string
        read_count: string
      }>(
        `SELECT
           COALESCE(SUM(r.chargeable_pence), 0) AS gross_pence,
           COALESCE(SUM(${readNetSql('r.chargeable_pence', '$2')}), 0) AS net_pence,
           COALESCE(SUM(CASE WHEN r.state = 'platform_settled'
             THEN ${readNetSql('r.chargeable_pence', '$2')} ELSE 0 END), 0) AS pending_pence,
           COALESCE(SUM(CASE WHEN r.state = 'writer_paid'
             THEN ${readNetSql('r.chargeable_pence', '$2')} ELSE 0 END), 0) AS paid_pence,
           COUNT(r.id) AS read_count
         FROM read_events r
         WHERE r.publication_id = $1
           AND r.state IN ('platform_settled', 'writer_paid')`,
        [id, feeBps]
      )

      // Subscription income (§1.3): already NET (fee floored per charge).
      // Collected (settled_at NOT NULL) mirrors the reads' platform_settled
      // gate — uncollected charges are excluded from all three buckets, same
      // as accrued reads. Pending = collected but unclaimed; paid = claimed by
      // a publication payout.
      const { rows: [subSummary] } = await pool.query<{
        sub_net_pence: string
        sub_pending_pence: string
        sub_paid_pence: string
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN settled_at IS NOT NULL
             THEN amount_pence ELSE 0 END), 0) AS sub_net_pence,
           COALESCE(SUM(CASE WHEN settled_at IS NOT NULL AND publication_payout_id IS NULL
             THEN amount_pence ELSE 0 END), 0) AS sub_pending_pence,
           COALESCE(SUM(CASE WHEN publication_payout_id IS NOT NULL
             THEN amount_pence ELSE 0 END), 0) AS sub_paid_pence
         FROM subscription_events
         WHERE publication_id = $1
           AND event_type = 'subscription_earning'`,
        [id]
      )

      // Per-article breakdown
      const { rows: articles } = await pool.query(
        `SELECT
           a.id AS article_id, a.title, a.slug, a.published_at,
           COUNT(r.id) AS read_count,
           COALESCE(SUM(${readNetSql('r.chargeable_pence', '$2')}), 0) AS net_pence
         FROM articles a
         LEFT JOIN read_events r ON r.article_id = a.id
           AND r.publication_id = $1
           AND r.state IN ('platform_settled', 'writer_paid')
         WHERE a.publication_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
         GROUP BY a.id, a.title, a.slug, a.published_at
         ORDER BY net_pence DESC`,
        [id, feeBps]
      )

      // Recent payouts
      const { rows: payouts } = await pool.query(
        `SELECT pp.id, pp.total_pool_pence, pp.sub_net_pence, pp.platform_fee_pence,
                pp.flat_fees_paid_pence,
                pp.remaining_pool_pence, pp.status, pp.triggered_at, pp.completed_at,
                json_agg(json_build_object(
                  'accountId', pps.account_id,
                  'username', acc.username,
                  'displayName', acc.display_name,
                  'amountPence', pps.amount_pence,
                  'shareType', pps.share_type,
                  'shareBps', pps.share_bps,
                  'status', pps.status
                ) ORDER BY pps.amount_pence DESC) AS splits
         FROM publication_payouts pp
         LEFT JOIN publication_payout_splits pps ON pps.publication_payout_id = pp.id
         LEFT JOIN accounts acc ON acc.id = pps.account_id
         WHERE pp.publication_id = $1
         GROUP BY pp.id
         ORDER BY pp.triggered_at DESC
         LIMIT 20`,
        [id]
      )

      // Headline pending/paid/net fold BOTH legs (reads + subscriptions) so
      // they track what the pool actually distributes; subscriptionNetPence is
      // the sub leg broken out for display.
      const subNetPence = parseInt(subSummary.sub_net_pence, 10)
      return reply.send({
        summary: {
          grossPence: parseInt(summary.gross_pence, 10),
          netPence: parseInt(summary.net_pence, 10) + subNetPence,
          pendingPence: parseInt(summary.pending_pence, 10) + parseInt(subSummary.sub_pending_pence, 10),
          paidPence: parseInt(summary.paid_pence, 10) + parseInt(subSummary.sub_paid_pence, 10),
          readCount: parseInt(summary.read_count, 10),
          subscriptionNetPence: subNetPence,
        },
        articles: articles.map((a: any) => ({
          articleId: a.article_id,
          title: a.title,
          slug: a.slug,
          publishedAt: a.published_at,
          readCount: parseInt(a.read_count, 10),
          netPence: parseInt(a.net_pence, 10),
        })),
        payouts: payouts.map((p: any) => ({
          id: p.id,
          totalPoolPence: p.total_pool_pence,
          subNetPence: p.sub_net_pence,
          platformFeePence: p.platform_fee_pence,
          flatFeesPaidPence: p.flat_fees_paid_pence,
          remainingPoolPence: p.remaining_pool_pence,
          status: p.status,
          triggeredAt: p.triggered_at,
          completedAt: p.completed_at,
          splits: p.splits?.[0]?.accountId ? p.splits : [],
        })),
      })
    }
  )
}
