import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// =============================================================================
// GET / PATCH /settings/subscription-welcome (§4.2, migration 180).
//
// The writer's welcome message: plain text, sent to a reader on subscribing.
// Four things are worth pinning, and the first two are the ones a fixture-
// returning mock would miss.
//
//   · NULL AND '' ARE DIFFERENT VALUES and both must reach the column as
//     written. Migration 180 keeps them distinct so a later "send nothing at
//     all" opt-out has somewhere to live; a route that COALESCEd them, or a
//     mock that reported whatever it was given, would make that impossible
//     later and say nothing now. The mock therefore keeps a real cell and the
//     assertions read it back.
//   · THE BOUND IS THE COLUMN'S. 2000 characters, matching the CHECK. The
//     route is where a writer's mistake is reported to them, so 2001 must be a
//     400 and 2000 must not.
//   · THE 400 IS THE SHARED ENVELOPE, never a raw `flatten()` as `error` —
//     the invariant that exists because clients string-interpolate `body.error`
//     and render "[object Object]".
//   · IT IS SCOPED TO THE CALLER. The UPDATE must be keyed on the session's
//     account and nobody else's, so the mock records the id it was handed.
// =============================================================================

/** The one cell under test, plus who was asked about / written to. */
let cell: string | null = null
let lastSelectId: string | null = null
let lastUpdateId: string | null = null
let accountExists = true
let sessionSub = 'writer-1'

function query(sql: string, params: unknown[] = []) {
  if (/UPDATE accounts SET subscription_welcome_message/.test(sql)) {
    // Write what the route actually passed — including null, and including ''.
    cell = params[0] as string | null
    lastUpdateId = params[1] as string
    return Promise.resolve({ rows: [], rowCount: 1 })
  }
  if (/SELECT subscription_welcome_message/.test(sql)) {
    lastSelectId = params[0] as string
    return Promise.resolve({
      rows: accountExists ? [{ subscription_welcome_message: cell }] : [],
      rowCount: accountExists ? 1 : 0,
    })
  }
  throw new Error(`unexpected SQL: ${sql}`)
}

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
}))

vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: sessionSub }
    done()
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: sessionSub }
    done()
  },
}))

const { subscriptionSettingsRoutes } = await import('../src/routes/subscriptions/settings.js')

async function build() {
  const app = Fastify({ logger: false })
  await app.register(subscriptionSettingsRoutes)
  return app
}

beforeEach(() => {
  cell = null
  lastSelectId = null
  lastUpdateId = null
  accountExists = true
  sessionSub = 'writer-1'
})

// ---------------------------------------------------------------------------

describe('GET /settings/subscription-welcome', () => {
  it('returns null when the writer has never set one', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/settings/subscription-welcome' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: null })
  })

  it('returns the stored message', async () => {
    cell = 'Hello from me.'
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/settings/subscription-welcome' })
    expect(res.json()).toEqual({ message: 'Hello from me.' })
  })

  it('asks about the caller’s own account', async () => {
    sessionSub = 'writer-99'
    const app = await build()
    await app.inject({ method: 'GET', url: '/settings/subscription-welcome' })
    expect(lastSelectId).toBe('writer-99')
  })

  it('404s when the account row is gone', async () => {
    accountExists = false
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/settings/subscription-welcome' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('account_not_found')
  })
})

describe('PATCH /settings/subscription-welcome', () => {
  it('stores the message and writes it against the caller’s account', async () => {
    sessionSub = 'writer-7'
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: 'Thanks for subscribing.' },
    })
    expect(res.statusCode).toBe(200)
    expect(cell).toBe('Thanks for subscribing.')
    expect(lastUpdateId).toBe('writer-7')
  })

  it('stores null as null — not as the empty string', async () => {
    cell = 'something'
    const app = await build()
    await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: null },
    })
    expect(cell).toBeNull()
  })

  it('stores the empty string as the empty string — not as null', async () => {
    // Migration 180 keeps the two distinct so a later "send nothing at all"
    // opt-out has a value to hang on. A route that normalised '' to null here
    // would take that away, silently, and no page would show it.
    const app = await build()
    await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: '' },
    })
    expect(cell).toBe('')
    expect(cell).not.toBeNull()
  })

  it('accepts a message at exactly the column’s bound', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: 'x'.repeat(2000) },
    })
    expect(res.statusCode).toBe(200)
    expect((cell ?? '').length).toBe(2000)
  })

  it('refuses one character over it, and never reaches the column', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: 'x'.repeat(2001) },
    })
    expect(res.statusCode).toBe(400)
    expect(cell).toBeNull()
  })

  it('returns the shared validation envelope, never a raw flatten()', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: 'x'.repeat(2001) },
    })
    const body = res.json()
    expect(body.error).toBe('validation_failed')
    expect(typeof body.error).toBe('string')
    expect(typeof body.message).toBe('string')
    expect(body.details).toBeDefined()
    // the bug this envelope exists to stop
    expect(String(body.error)).not.toBe('[object Object]')
  })

  it('refuses a missing message field rather than clearing the column', async () => {
    cell = 'keep me'
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(cell).toBe('keep me')
  })

  it('refuses a non-string message', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings/subscription-welcome',
      payload: { message: 42 },
    })
    expect(res.statusCode).toBe(400)
    expect(cell).toBeNull()
  })
})
