import type { FastifyInstance } from 'fastify'
import { subscriptionWriterRoutes } from './writer.js'
import { subscriptionSubscribersRoutes } from './subscribers.js'
import { subscriptionPublicationRoutes } from './publication.js'
import { subscriptionEventsRoutes } from './events.js'
import { subscriptionSettingsRoutes } from './settings.js'

// =============================================================================
// Subscription Routes — reader↔writer lifecycle, writer's subscriber management,
// publication subscriptions, event history, and pricing settings.
//
// Split across sibling files by concern; composed here. All routes share the
// `/api/v1` prefix applied by the gateway registrar.
// =============================================================================

export async function subscriptionRoutes(app: FastifyInstance) {
  await subscriptionWriterRoutes(app)
  await subscriptionSubscribersRoutes(app)
  await subscriptionPublicationRoutes(app)
  await subscriptionEventsRoutes(app)
  await subscriptionSettingsRoutes(app)
}

// Re-exported for workers/subscription-expiry.ts, which imports this helper
// to log charges/earnings during hourly renewal.
export { logSubscriptionCharge } from './shared.js'
