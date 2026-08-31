import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'

// =============================================================================
// PATCH /settings/subscription-price — writer's pricing settings
// =============================================================================

const PriceSchema = z.object({
  pricePence: z.number().int().min(100).max(10000), // £1 to £100
  annualDiscountPct: z.number().int().min(0).max(30).optional(),
  defaultArticlePricePence: z.number().int().min(0).max(10000).nullable().optional(), // NULL = auto-suggest
})

export async function subscriptionSettingsRoutes(app: FastifyInstance) {
  app.patch(
    '/settings/subscription-price',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = PriceSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const accountId = req.session!.sub
      const { pricePence, annualDiscountPct, defaultArticlePricePence } = parsed.data

      const sets = ['subscription_price_pence = $1', 'updated_at = now()']
      const params: any[] = [pricePence, accountId]
      let paramIdx = 3

      if (annualDiscountPct !== undefined) {
        sets.push(`annual_discount_pct = $${paramIdx}`)
        params.push(annualDiscountPct)
        paramIdx++
      }
      if (defaultArticlePricePence !== undefined) {
        sets.push(`default_article_price_pence = $${paramIdx}`)
        params.push(defaultArticlePricePence)
        paramIdx++
      }

      await pool.query(
        `UPDATE accounts SET ${sets.join(', ')} WHERE id = $2`,
        params
      )

      logger.info({ accountId, pricePence, annualDiscountPct, defaultArticlePricePence }, 'Pricing updated')

      return reply.status(200).send({ ok: true, pricePence, annualDiscountPct, defaultArticlePricePence })
    }
  )

  // ===========================================================================
  // GET / PATCH /settings/subscription-welcome — the writer's welcome message
  //
  // Plain text, sent to a reader on subscribing. The 2000-character bound
  // mirrors the CHECK migration 180 puts on the column: this is where a
  // writer's mistake is reported to them, and the constraint is the ceiling no
  // path can get past.
  //
  // `null` and `''` both mean "send the default", and both are accepted so the
  // box can be cleared. They are stored distinctly (see migration 180) rather
  // than normalised to one, so a later "send nothing at all" opt-out has a
  // value to hang on without reinterpreting rows that predate it.
  // ===========================================================================

  const WelcomeSchema = z.object({
    message: z
      .string()
      .max(2000, 'Welcome message must be 2000 characters or fewer')
      .nullable(),
  })

  app.get(
    '/settings/subscription-welcome',
    { preHandler: requireAuth },
    async (req, reply) => {
      const accountId = req.session!.sub
      const { rows } = await pool.query<{ subscription_welcome_message: string | null }>(
        `SELECT subscription_welcome_message FROM accounts WHERE id = $1`,
        [accountId]
      )
      if (rows.length === 0) return reply.status(404).send({ error: 'account_not_found' })
      return reply.status(200).send({ message: rows[0].subscription_welcome_message })
    }
  )

  app.patch(
    '/settings/subscription-welcome',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = WelcomeSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const accountId = req.session!.sub
      const { message } = parsed.data

      await pool.query(
        `UPDATE accounts SET subscription_welcome_message = $1, updated_at = now() WHERE id = $2`,
        [message, accountId]
      )

      logger.info({ accountId, length: message?.length ?? 0 }, 'Subscription welcome message updated')

      return reply.status(200).send({ ok: true, message })
    }
  )
}
