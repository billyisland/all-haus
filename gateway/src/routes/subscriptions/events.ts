import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'

// =============================================================================
// GET /subscription-events — paginated subscription event history
//
// Returns subscription_charge and subscription_earning events for the
// authenticated user (as reader or writer), most recent first.
// =============================================================================

export async function subscriptionEventsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/subscription-events',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 100)
      const offset = parseInt(req.query.offset ?? '0', 10) || 0

      const { rows } = await pool.query<{
        id: string
        subscription_id: string
        event_type: string
        reader_id: string
        writer_id: string
        amount_pence: number
        period_start: Date | null
        period_end: Date | null
        description: string | null
        created_at: Date
        counterparty_name: string | null
        counterparty_username: string
      }>(
        `SELECT se.id, se.subscription_id, se.event_type,
                se.reader_id, se.writer_id, se.amount_pence,
                se.period_start, se.period_end, se.description, se.created_at,
                CASE
                  WHEN se.reader_id = $1 THEN w.display_name
                  ELSE r.display_name
                END AS counterparty_name,
                CASE
                  WHEN se.reader_id = $1 THEN w.username
                  ELSE r.username
                END AS counterparty_username
         FROM subscription_events se
         JOIN accounts r ON r.id = se.reader_id
         JOIN accounts w ON w.id = se.writer_id
         WHERE (se.reader_id = $1 OR se.writer_id = $1)
           AND se.event_type IN ('subscription_charge', 'subscription_earning')
           AND se.description != 'Expiry warning sent'
         ORDER BY se.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      )

      return reply.status(200).send({
        events: rows.map(e => ({
          id: e.id,
          subscriptionId: e.subscription_id,
          eventType: e.event_type,
          amountPence: e.amount_pence,
          periodStart: e.period_start?.toISOString() ?? null,
          periodEnd: e.period_end?.toISOString() ?? null,
          description: e.description,
          counterpartyName: e.counterparty_name ?? e.counterparty_username,
          counterpartyUsername: e.counterparty_username,
          createdAt: e.created_at.toISOString(),
        })),
      })
    }
  )
}
