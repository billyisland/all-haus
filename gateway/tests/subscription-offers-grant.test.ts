import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// =============================================================================
// Gift-subscription GRANT mode — reachable and redeemable (§1.10).
//
// Grant offers were modelled end to end and dead on arrival: created with
// `code = NULL`, while the redeem lookup filtered `mode = 'code'` and the page
// is addressed `/subscribe/:code`. So a grant had no URL, and the recipient
// check already sitting in the subscribe path could never be reached.
//
// Three things are pinned here, each with the pre-fix behaviour as its control:
//   1. a grant is created WITH a code (the pre-fix INSERT bound null),
//   2. the lookup resolves it for its named recipient (the pre-fix WHERE clause
//      excluded every grant, for everyone),
//   3. and refuses it for anyone else — 401 with no session (so the recipient
//      arriving logged-out gets a way in), 404 for a different account (so a
//      forwarded link tells its new holder nothing).
//
// The mock answers from the SQL it is handed, per CLAUDE.md: the offer row is
// returned only to a SELECT that actually reads subscription_offers by code,
// and the INSERT's bound parameters are read back off the call rather than
// assumed.
// =============================================================================

const mockPoolQuery = vi.fn()
vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}))

vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// requireAuth stamps the writer; optionalAuth stamps whoever `viewer` names.
let viewer: string | null = null
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (req: any) => {
    req.session = { sub: 'writer-1', pubkey: 'wpk' }
  },
  optionalAuth: async (req: any) => {
    req.session = viewer ? { sub: viewer, pubkey: 'vpk' } : undefined
  },
}))

import { subscriptionOfferRoutes } from '../src/routes/subscription-offers.js'

const GRANT_ROW = {
  id: 'offer-1',
  label: 'A year on me',
  mode: 'grant',
  discount_pct: 100,
  duration_months: 12,
  max_redemptions: 1,
  redemption_count: 0,
  expires_at: null,
  recipient_id: 'reader-1',
  writer_id: 'writer-1',
  writer_username: 'ada',
  writer_display_name: 'Ada',
  subscription_price_pence: 500,
}

async function build() {
  const app = Fastify()
  await app.register(subscriptionOfferRoutes)
  return app
}

beforeEach(() => {
  mockPoolQuery.mockReset()
  viewer = null
})

describe('POST /subscription-offers — a grant gets a code', () => {
  it('binds a real code, so the offer has a /subscribe URL', async () => {
    mockPoolQuery.mockImplementation((sql: string, params: unknown[] = []) => {
      if (/FROM accounts WHERE username/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'reader-1' }], rowCount: 1 })
      }
      if (/INSERT INTO subscription_offers/.test(sql)) {
        // RETURNING id, code — so echo the code the route actually BOUND
        // ($6, index 5), the way Postgres would. A fixture value here would
        // make the url assertion below pin the fixture, not the route.
        return Promise.resolve({ rows: [{ id: 'offer-1', code: params[5] }] })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/subscription-offers',
      payload: {
        label: 'A year on me',
        mode: 'grant',
        discountPct: 100,
        recipientUsername: 'reader',
      },
    })
    expect(res.statusCode).toBe(201)

    const insert = mockPoolQuery.mock.calls.find((c) =>
      /INSERT INTO subscription_offers/.test(c[0] as string),
    )
    expect(insert).toBeDefined()
    const boundCode = (insert![1] as unknown[])[5]
    // The pre-fix route bound null here — that is the whole defect.
    expect(boundCode).not.toBeNull()
    expect(typeof boundCode).toBe('string')
    expect(boundCode as string).toMatch(/^[A-Za-z0-9_-]+$/)
    // …and the recipient is still bound alongside it.
    expect((insert![1] as unknown[])[6]).toBe('reader-1')

    expect(res.json().code).toBe(boundCode)
    expect(res.json().url).toBe(`/subscribe/${boundCode as string}`)

    // The recipient is told the gift exists — without it the URL only travels
    // if the writer copies it out by hand, which is what left grants unused.
    const notify = mockPoolQuery.mock.calls.find(
      (c) =>
        /INSERT INTO notifications/.test(c[0] as string) &&
        (c[1] as unknown[])[0] === 'reader-1',
    )
    expect(notify).toBeDefined()

    // …and it carries WHICH offer (migration 172). Mutant: drop offer_id from
    // the INSERT — fails here. Without it the notification cannot be rendered
    // as a link (`notifications` has a dedicated reference column per linkable
    // entity and no free-text field), so the recipient saw an unlabelled "sent
    // you a notification" pointing nowhere — while the redeem lookup's 401 arm
    // exists precisely FOR "the recipient arriving from their notification".
    // It is also what makes a SECOND gift to the same reader a second
    // notification rather than an ON CONFLICT DO NOTHING no-op.
    expect(notify![0] as string).toMatch(/INSERT INTO notifications[\s\S]*offer_id/)
    expect(notify![1] as unknown[]).toContain('offer-1')
  })
})

describe('GET /subscription-offers/redeem/:code — who a grant resolves for', () => {
  beforeEach(() => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (/FROM subscription_offers so/.test(sql) && /so\.code = \$1/.test(sql)) {
        // The pre-fix statement carried `AND so.mode = 'code'`, which is what
        // made a grant unlookupable. Its absence is load-bearing.
        expect(sql).not.toMatch(/mode\s*=\s*'code'/)
        return Promise.resolve({ rows: [GRANT_ROW] })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
  })

  it('resolves for the named recipient', async () => {
    viewer = 'reader-1'
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/subscription-offers/redeem/abc' })

    expect(res.statusCode).toBe(200)
    expect(res.json().mode).toBe('grant')
    expect(res.json().discountedPricePence).toBe(0) // 100% off
    expect(res.json().writerUsername).toBe('ada')
  })

  it('401s a logged-out visitor, so the recipient gets a way in', async () => {
    viewer = null
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/subscription-offers/redeem/abc' })

    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('login_required')
  })

  it('404s a different account — a forwarded link reveals nothing', async () => {
    viewer = 'reader-2'
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/subscription-offers/redeem/abc' })

    expect(res.statusCode).toBe(404)
    // Byte-identical to the no-such-code response: nothing distinguishes them.
    expect(res.json()).toEqual({ error: 'Offer not found or no longer available' })
  })

  it('a bearer code offer still resolves for anyone, logged out included', async () => {
    mockPoolQuery.mockImplementation((sql: string) => {
      if (/FROM subscription_offers so/.test(sql) && /so\.code = \$1/.test(sql)) {
        return Promise.resolve({
          rows: [{ ...GRANT_ROW, mode: 'code', recipient_id: null, discount_pct: 50 }],
        })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })
    viewer = null
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/subscription-offers/redeem/abc' })

    expect(res.statusCode).toBe(200)
    expect(res.json().mode).toBe('code')
    expect(res.json().discountedPricePence).toBe(250)
  })
})
