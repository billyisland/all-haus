import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { resolve, getAsyncResult, type ResolveContext } from '../lib/resolver.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Universal Resolver endpoints
//
// POST /resolve          — Resolve any identifier to candidate identities
// GET  /resolve/:id      — Poll for async remote resolution results
// =============================================================================

export async function resolveRoutes(app: FastifyInstance) {

  // POST /resolve — resolve an arbitrary input string
  app.post<{
    Body: { query: string; context?: ResolveContext; discover?: boolean }
  }>('/resolve', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { query, context, discover } = req.body ?? {}

    if (!query || typeof query !== 'string') {
      return reply.status(400).send({ error: 'query is required' })
    }

    if (query.length > 500) {
      return reply.status(400).send({ error: 'query too long (max 500 characters)' })
    }

    try {
      // discover=true (explicit submit only) opts into the §V.5.8 discovery
      // fallback — external candidate search for names the exact chains miss.
      const result = await resolve(query.trim(), context ?? 'general', req.session!.sub, discover === true)
      return reply.send(result)
    } catch (err) {
      logger.error({ err, query }, 'Resolver error')
      return reply.status(500).send({ error: 'Resolution failed' })
    }
  })

  // GET /resolve/:requestId — poll for async resolution results
  app.get<{
    Params: { requestId: string }
  }>('/resolve/:requestId', {
    preHandler: requireAuth,
  }, async (req, reply) => {
    const { requestId } = req.params

    const result = await getAsyncResult(requestId, req.session!.sub)
    if (!result) {
      // Don't distinguish "not yours" from "expired/missing" — both leak timing
      // signal that the requestId is real.
      return reply.status(404).send({ error: 'Resolution request not found or expired' })
    }

    return reply.send(result)
  })
}
