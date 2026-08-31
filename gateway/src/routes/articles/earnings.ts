import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../middleware/auth.js'
import { PAYMENT_SERVICE_URL, proxyToService } from './shared.js'

// =============================================================================
// Writer earnings (proxied to payment service)
//
// GET /earnings/:writerId            — Overall earnings summary
// GET /earnings/:writerId/articles   — Per-article earnings breakdown
// =============================================================================

export async function articleEarningsRoutes(app: FastifyInstance) {
  app.get<{ Params: { writerId: string } }>(
    '/earnings/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      // Ensure writers can only see their own earnings
      if (req.params.writerId !== req.session!.sub) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      return proxyToService(
        `${PAYMENT_SERVICE_URL}/api/v1/earnings/${req.params.writerId}`,
        'GET',
        req,
        reply
      )
    }
  )

  app.get<{ Params: { writerId: string } }>(
    '/earnings/:writerId/articles',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (req.params.writerId !== req.session!.sub) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      return proxyToService(
        `${PAYMENT_SERVICE_URL}/api/v1/earnings/${req.params.writerId}/articles`,
        'GET',
        req,
        reply
      )
    }
  )
}
