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
// It registers through `registerRoutes` (`src/register-routes.ts`), the
// same function `index.ts` calls, so it runs the real route table without
// booting the full gateway (env validation, plugin chain, listen, graceful
// shutdown handlers). Until D1 it carried a hand-kept mirror of that table,
// which had drifted to about two thirds of it.
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

    const { registerRoutes } = await import('../src/register-routes.js')

    const app = Fastify({ logger: false })

    // The gateway's own registration function, not a mirror of it: since D1
    // (READER-WRITER-SPLIT-ADR §4.6) the route table is one exported function,
    // so this test can no longer drift from what `index.ts` registers.
    await registerRoutes(app)

    // ready() flushes pending plugin registration and surfaces any deferred
    // errors. If a future plugin registers async work, this is where it
    // would throw.
    await expect(app.ready()).resolves.not.toThrow()
    await app.close()
  })
})
