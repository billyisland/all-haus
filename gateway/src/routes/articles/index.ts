import type { FastifyInstance } from 'fastify'
import { articlePublishRoutes } from './publish.js'
import { articleGatePassRoutes } from './gate-pass.js'
import { articleArrivalRoutes } from './arrival.js'
import { articleEarningsRoutes } from './earnings.js'
import { articleManageRoutes } from './manage.js'
import { articleSubscriptionConvertRoutes } from './subscription-convert.js'

// =============================================================================
// Article Routes — publishing/indexing, gate-pass orchestration, the paywall
// arrival landing, earnings, writer dashboard management, and spend-to-
// subscription conversion.
//
// Split across sibling files by concern; composed here. All routes share the
// `/api/v1` prefix applied by the gateway registrar.
// =============================================================================

export async function articleRoutes(app: FastifyInstance) {
  await articlePublishRoutes(app)
  await articleGatePassRoutes(app)
  await articleArrivalRoutes(app)
  await articleEarningsRoutes(app)
  await articleManageRoutes(app)
  await articleSubscriptionConvertRoutes(app)
}
