import type { FastifyInstance } from 'fastify'
import { publicationsEnabled } from '@platform-pub/shared/lib/env.js'
import { publicationCoreRoutes } from './core.js'
import { publicationMembersRoutes } from './members.js'
import { publicationCmsRoutes } from './cms.js'
import { publicationPublicRoutes } from './public.js'
import { publicationRevenueRoutes } from './revenue.js'

// =============================================================================
// Publication Routes — CRUD, member management, CMS, reader-facing, revenue.
//
// Split across sibling files by concern; composed here. All routes share the
// `/api/v1` prefix applied by the gateway registrar.
// =============================================================================

export async function publicationRoutes(app: FastifyInstance) {
  // SUSPENDED by operator directive 2026-08-31 — launch is solo author accounts
  // only. Every route 404s while the feature is dark, so the surface is
  // invisible rather than forbidden (same shape as routes/tributes.ts).
  //
  // This ONE hook covers all 27 routes: the five sibling registrars below are
  // called directly rather than via app.register(), so they share this plugin's
  // encapsulation context and inherit the hook. Adding a route file here needs
  // no second gate — but registering one with app.register() WOULD escape this,
  // so don't. Operational detail + restore conditions: shared/src/lib/env.ts;
  // reinstatement: docs/adr/PUBLICATIONS-SUSPENSION-PLAN.md §8.
  app.addHook('preHandler', async (_req, reply) => {
    if (!publicationsEnabled()) {
      return reply.status(404).send({ error: 'Not found' })
    }
  })

  await publicationCoreRoutes(app)
  await publicationMembersRoutes(app)
  await publicationCmsRoutes(app)
  await publicationPublicRoutes(app)
  await publicationRevenueRoutes(app)
}
