import { describe, it, expect, beforeAll } from 'vitest'

// =============================================================================
// gateway boot smoke test
//
// Catches the class of bugs that don't show up in tsc but crash the gateway
// on `npm start`:
//   1. Module-load throws — e.g. a malformed Zod schema. The original
//      slice-3 addSourceSchema used z.discriminatedUnion with two variants
//      that shared the discriminator value; Zod 3.25+ throws on that at
//      schema construction (at module import) and the gateway died
//      before its first request.
//   2. Route registration collisions — Fastify rejects a duplicate
//      method+path combo at `app.register` time. external-feeds.ts and
//      slice-3 feeds.ts both registered GET /feeds at /api/v1, which
//      tsc happily accepted.
//
// The test mirrors the route registration block in `src/index.ts`. When
// adding a new route module to index.ts, mirror it here too — drift
// between the two is the test's main maintenance hazard, and the
// deliberate duplication is the price of running this without booting
// the full gateway (env validation, plugin chain, listen, graceful
// shutdown handlers).
//
// Plugins (sensible / cookie / cors / multipart / rate-limit) are not
// registered here. Route-level `config.rateLimit` becomes inert without
// the plugin (Fastify ignores unknown route config keys), but route
// registration itself still validates path uniqueness and serialises
// schemas — which is exactly what we want to test.
// =============================================================================

beforeAll(() => {
  // Stub the env vars route modules read at module scope. The constants
  // are only used inside route handlers (none of which run in this test),
  // so dummy values are fine — `requireEnv` just needs them present.
  process.env.STRIPE_SECRET_KEY ??= 'sk_test_dummy'
  process.env.READER_HASH_KEY ??= 'a'.repeat(64)
  process.env.APP_URL ??= 'http://localhost:3010'
  process.env.KEY_SERVICE_URL ??= 'http://localhost:3002'
  process.env.PAYMENT_SERVICE_URL ??= 'http://localhost:3001'
  process.env.INTERNAL_SERVICE_TOKEN ??= 'dummy'
  process.env.PLATFORM_SERVICE_PRIVKEY ??=
    '0000000000000000000000000000000000000000000000000000000000000001'
  process.env.SESSION_SECRET ??= 'a'.repeat(64)
  process.env.KEY_CUSTODY_URL ??= 'http://localhost:3004'
  process.env.INTERNAL_SECRET ??= 'dummy'
})

describe('gateway boot', () => {
  // Explicit timeout: this test imports the gateway's entire route module
  // graph, which takes several seconds cold — under a full parallel suite it
  // flakes against vitest's 5s default (first hit 2026-07-12).
  it('every route module registers without throwing or colliding', { timeout: 30_000 }, async () => {
    // Dynamic imports so the env stubs in beforeAll land before
    // module-scope requireEnv() / new Stripe() / Zod schema construction.
    const Fastify = (await import('fastify')).default

    const { authRoutes } = await import('../src/routes/auth.js')
    const { googleAuthRoutes } = await import('../src/routes/google-auth.js')
    const { signingRoutes } = await import('../src/routes/signing.js')
    const { writerRoutes } = await import('../src/routes/writers.js')
    const { articleRoutes } = await import('../src/routes/articles/index.js')
    const { noteRoutes } = await import('../src/routes/notes.js')
    const { draftRoutes } = await import('../src/routes/drafts.js')
    const { replyRoutes } = await import('../src/routes/replies.js')
    const { mediaRoutes } = await import('../src/routes/media.js')
    const { followRoutes } = await import('../src/routes/follows.js')
    const { moderationRoutes } = await import('../src/routes/moderation.js')
    const { searchRoutes } = await import('../src/routes/search.js')
    const { rssRoutes } = await import('../src/routes/rss.js')
    const { subscriptionRoutes } = await import('../src/routes/subscriptions/index.js')
    const { unsubscribeRoutes } = await import('../src/routes/unsubscribe.js')
    const { myAccountRoutes } = await import('../src/routes/my-account.js')
    const { receiptRoutes } = await import('../src/routes/receipts.js')
    const { exportRoutes } = await import('../src/routes/export.js')
    const { notificationRoutes } = await import('../src/routes/notifications.js')
    const { voteRoutes } = await import('../src/routes/votes.js')
    const { historyRoutes } = await import('../src/routes/history.js')
    const { giftLinkRoutes } = await import('../src/routes/gift-links.js')
    const { subscriptionOfferRoutes } = await import('../src/routes/subscription-offers.js')
    const { messageRoutes } = await import('../src/routes/messages.js')
    const { socialRoutes } = await import('../src/routes/social.js')
    const { publicationRoutes } = await import('../src/routes/publications/index.js')
    const { driveRoutes } = await import('../src/routes/drives.js')
    const { traffologyRoutes } = await import('../src/routes/traffology.js')
    const { bookmarkRoutes } = await import('../src/routes/bookmarks.js')
    const { tagRoutes } = await import('../src/routes/tags.js')
    const { resolveRoutes } = await import('../src/routes/resolve.js')
    const { externalFeedsRoutes } = await import('../src/routes/external-feeds.js')
    const { linkedAccountsRoutes } = await import('../src/routes/linked-accounts.js')
    const { trustRoutes } = await import('../src/routes/trust.js')
    const { readingPositionRoutes } = await import('../src/routes/reading-positions.js')
    const followImportRoutes = (await import('../src/routes/follow-imports.js')).default
    const { feedsRoutes } = await import('../src/routes/feeds/index.js')

    const app = Fastify({ logger: false })

    // Prefixes mirror src/index.ts. Keep these in sync.
    await app.register(authRoutes, { prefix: '/api/v1' })
    await app.register(googleAuthRoutes, { prefix: '/api/v1' })
    await app.register(signingRoutes, { prefix: '/api/v1' })
    await app.register(writerRoutes, { prefix: '/api/v1' })
    await app.register(articleRoutes, { prefix: '/api/v1' })
    await app.register(noteRoutes, { prefix: '/api/v1' })
    await app.register(draftRoutes, { prefix: '/api/v1' })
    await app.register(replyRoutes, { prefix: '/api/v1' })
    await app.register(mediaRoutes, { prefix: '/api/v1' })
    await app.register(followRoutes, { prefix: '/api/v1' })
    await app.register(moderationRoutes, { prefix: '/api/v1' })
    await app.register(searchRoutes, { prefix: '/api/v1' })
    await app.register(rssRoutes)
    await app.register(subscriptionRoutes, { prefix: '/api/v1' })
    await app.register(unsubscribeRoutes, { prefix: '/api/v1' })
    await app.register(myAccountRoutes, { prefix: '/api/v1' })
    await app.register(receiptRoutes, { prefix: '/api/v1' })
    await app.register(exportRoutes, { prefix: '/api/v1' })
    await app.register(notificationRoutes, { prefix: '/api/v1' })
    await app.register(voteRoutes, { prefix: '/api/v1' })
    await app.register(historyRoutes, { prefix: '/api/v1' })
    await app.register(giftLinkRoutes, { prefix: '/api/v1' })
    await app.register(subscriptionOfferRoutes, { prefix: '/api/v1' })
    await app.register(messageRoutes, { prefix: '/api/v1' })
    await app.register(socialRoutes, { prefix: '/api/v1' })
    await app.register(publicationRoutes, { prefix: '/api/v1' })
    await app.register(driveRoutes, { prefix: '/api/v1' })
    await app.register(traffologyRoutes, { prefix: '/api/v1' })
    await app.register(bookmarkRoutes, { prefix: '/api/v1' })
    await app.register(tagRoutes, { prefix: '/api/v1' })
    await app.register(resolveRoutes, { prefix: '/api/v1' })
    await app.register(externalFeedsRoutes, { prefix: '/api/v1' })
    await app.register(linkedAccountsRoutes, { prefix: '/api/v1' })
    await app.register(trustRoutes, { prefix: '/api/v1' })
    await app.register(readingPositionRoutes, { prefix: '/api/v1' })
    await app.register(followImportRoutes, { prefix: '/api/v1' })
    await app.register(feedsRoutes, { prefix: '/api/v1/workspace' })

    // ready() flushes pending plugin registration and surfaces any deferred
    // errors. If a future plugin registers async work, this is where it
    // would throw.
    await expect(app.ready()).resolves.not.toThrow()
    await app.close()
  })
})
