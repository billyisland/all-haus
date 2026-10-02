import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the module under test
const mockVerifySession = vi.fn()
const mockRefreshIfNeeded = vi.fn()
const mockQuery = vi.fn()
const mockDestroySession = vi.fn()

vi.mock('@platform-pub/shared/auth/session.js', () => ({
  verifySession: (...args: any[]) => mockVerifySession(...args),
  refreshIfNeeded: (...args: any[]) => mockRefreshIfNeeded(...args),
  destroySession: (...args: any[]) => mockDestroySession(...args),
}))

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...args: any[]) => mockQuery(...args) },
}))

vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { requireAuth, optionalAuth, invalidateAuthCache } from '../src/middleware/auth.js'

// The middleware caches account auth-state in a module-level map (keyed by id,
// short TTL). These tests all reuse 'user-1' with different mocked DB responses,
// so the cache must be cleared between cases or a prior case's state leaks in.
const CACHED_TEST_ID = 'user-1'

function createMockReq(): any {
  return { headers: {} }
}

function createMockReply(): any {
  const reply: any = {}
  reply.status = vi.fn().mockReturnValue(reply)
  reply.send = vi.fn().mockReturnValue(reply)
  return reply
}

describe('requireAuth', () => {
  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
    invalidateAuthCache(CACHED_TEST_ID)
  })

  it('returns 401 when no session', async () => {
    mockVerifySession.mockResolvedValue(null)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({ error: 'Authentication required' })
  })

  it('returns 401 when session has no sub', async () => {
    mockVerifySession.mockResolvedValue({ sub: null, pubkey: 'abc' })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(401)
  })

  it('returns 403 when account not found', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(403)
  })

  it('returns 403 when account is suspended', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'suspended' }] })
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(403)
  })

  it('injects headers and session for active account', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-1', pubkey: 'pk1' })
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active', age_declared: true }] })
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(req.headers['x-reader-id']).toBe('user-1')
    expect(req.headers['x-reader-pubkey']).toBe('pk1')
    expect(req.headers['x-writer-id']).toBe('user-1')
    expect(req.session).toEqual({ sub: 'user-1', pubkey: 'pk1' })
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('calls refreshIfNeeded for valid sessions', async () => {
    const session = { sub: 'user-1', pubkey: 'pk1' }
    mockVerifySession.mockResolvedValue(session)
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active', age_declared: true }] })
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(mockRefreshIfNeeded).toHaveBeenCalledWith(req, reply, session)
  })
})

describe('optionalAuth', () => {
  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
    invalidateAuthCache(CACHED_TEST_ID)
  })

  it('attaches session when present', async () => {
    const session = { sub: 'user-1', pubkey: 'pk1' }
    mockVerifySession.mockResolvedValue(session)
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active', age_declared: true }] })
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toEqual(session)
    expect(req.headers['x-reader-id']).toBe('user-1')
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('sets session to null when no valid session', async () => {
    mockVerifySession.mockResolvedValue(null)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toBeNull()
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('allows anonymous requests without error', async () => {
    mockVerifySession.mockResolvedValue(undefined)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toBeNull()
    expect(req.headers['x-reader-id']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Auth-state cache behaviour (2026-07-06 audit: the cache itself had no
// coverage — a regression that silently disabled caching, never expired
// entries, or broke invalidateAuthCache would have passed this suite).
// ---------------------------------------------------------------------------
describe('auth-state cache', () => {
  const activeRow = { rowCount: 1, rows: [{ status: 'active', sessions_invalidated_at: null, age_declared: true }] }
  const suspendedRow = { rowCount: 1, rows: [{ status: 'suspended', sessions_invalidated_at: null }] }

  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
    invalidateAuthCache(CACHED_TEST_ID)
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1' })
  })

  it('serves the second request within TTL from cache (no second DB query)', async () => {
    mockQuery.mockResolvedValue(activeRow)

    await requireAuth(createMockReq(), createMockReply())
    await requireAuth(createMockReq(), createMockReply())

    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('invalidateAuthCache forces a refetch — a suspension takes effect immediately', async () => {
    mockQuery.mockResolvedValue(activeRow)
    await requireAuth(createMockReq(), createMockReply())

    // The DB row flips to suspended; the cache still serves 'active'…
    mockQuery.mockResolvedValue(suspendedRow)
    const stale = createMockReply()
    await requireAuth(createMockReq(), stale)
    expect(stale.status).not.toHaveBeenCalledWith(403)

    // …until the suspend path invalidates (moderation.ts, post-commit).
    invalidateAuthCache(CACHED_TEST_ID)
    const fresh = createMockReply()
    await requireAuth(createMockReq(), fresh)
    expect(fresh.status).toHaveBeenCalledWith(403)
    expect(mockQuery).toHaveBeenCalledTimes(2)
  })

  it('expires entries after the TTL (refetches from the DB)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-06T12:00:00Z'))
      mockQuery.mockResolvedValue(activeRow)
      await requireAuth(createMockReq(), createMockReply())

      vi.setSystemTime(new Date('2026-07-06T12:00:09Z')) // past the 8s TTL
      mockQuery.mockResolvedValue(suspendedRow)
      const reply = createMockReply()
      await requireAuth(createMockReq(), reply)

      expect(mockQuery).toHaveBeenCalledTimes(2)
      expect(reply.status).toHaveBeenCalledWith(403)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// sessions_invalidated_at — the logout-all-devices gate.
//
// It had no coverage at all, on either middleware. That is the shape this
// audit keeps finding: the suite reads as a thorough test of `requireAuth`
// (401 no session, 403 not found, 403 suspended, headers injected, refresh
// called) and every one of those cases leaves `sessions_invalidated_at`
// undefined, so the whole branch was dead code as far as the tests were
// concerned. Deleting it would have kept every existing case green while
// leaving every session a member had asked us to revoke perfectly valid.
//
// Four things are pinned, and three of them are the ways it can be wrong in
// the PERMISSIVE direction — which is the direction that matters here:
//   • a token issued BEFORE the stamp is refused AND the cookie is destroyed;
//   • a token issued AFTER it is allowed (or "revoke" means "log everyone out
//     for ever", and the boundary is what the comparison is FOR);
//   • a NULL stamp — the ordinary state of almost every account — allows;
//   • `optionalAuth` degrades to anonymous rather than merely not erroring,
//     which for a route that reads `req.session` is the whole difference
//     between a stranger and the member whose session was revoked.
// ---------------------------------------------------------------------------
describe('sessions_invalidated_at (logout all devices)', () => {
  // 2026-01-01T00:00:00Z, and iat values either side of it in whole seconds —
  // the units the middleware compares in (`Math.floor(ms / 1000)`).
  const INVALIDATED_AT = new Date('2026-01-01T00:00:00.000Z')
  const BEFORE = Math.floor(INVALIDATED_AT.getTime() / 1000) - 60
  const AFTER = Math.floor(INVALIDATED_AT.getTime() / 1000) + 60

  const rowWithStamp = {
    rowCount: 1,
    rows: [{ status: 'active', sessions_invalidated_at: INVALIDATED_AT, age_declared: true }],
  }
  const rowNoStamp = {
    rowCount: 1,
    rows: [{ status: 'active', sessions_invalidated_at: null, age_declared: true }],
  }

  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
    mockDestroySession.mockReset()
    mockRefreshIfNeeded.mockResolvedValue(undefined)
    invalidateAuthCache(CACHED_TEST_ID)
  })

  it('requireAuth refuses a token issued before the stamp, and clears the cookie', async () => {
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1', iat: BEFORE })
    mockQuery.mockResolvedValue(rowWithStamp)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).toHaveBeenCalledWith(401)
    expect(reply.send).toHaveBeenCalledWith({ error: 'Session expired' })
    // Destroying the cookie is what stops the browser re-presenting a token it
    // will be refused for every time until it expires on its own.
    expect(mockDestroySession).toHaveBeenCalledWith(reply)
    // And nothing downstream may see it as a member.
    expect(req.session).toBeUndefined()
    expect(req.headers['x-reader-id']).toBeUndefined()
  })

  it('requireAuth admits a token issued AFTER the stamp', async () => {
    // The control without which "refuses" is satisfied by refusing everyone:
    // a revoke must end the sessions that existed, not the account.
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1', iat: AFTER })
    mockQuery.mockResolvedValue(rowWithStamp)
    const req = createMockReq()
    const reply = createMockReply()

    await requireAuth(req, reply)

    expect(reply.status).not.toHaveBeenCalled()
    expect(mockDestroySession).not.toHaveBeenCalled()
    expect(req.headers['x-reader-id']).toBe(CACHED_TEST_ID)
  })

  it('requireAuth admits any token when the stamp is NULL', async () => {
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1', iat: BEFORE })
    mockQuery.mockResolvedValue(rowNoStamp)
    const reply = createMockReply()

    await requireAuth(createMockReq(), reply)

    expect(reply.status).not.toHaveBeenCalled()
  })

  it('optionalAuth degrades a revoked session to ANONYMOUS, not merely to no error', async () => {
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1', iat: BEFORE })
    mockQuery.mockResolvedValue(rowWithStamp)
    const req = createMockReq()
    const reply = createMockReply()

    await optionalAuth(req, reply)

    expect(req.session).toBeNull()
    expect(mockDestroySession).toHaveBeenCalledWith(reply)
    // The headers are the part a status-code assertion cannot see: leaving them
    // set would hand a revoked identity to every downstream service.
    expect(req.headers['x-reader-id']).toBeUndefined()
    expect(req.headers['x-writer-id']).toBeUndefined()
    expect(reply.status).not.toHaveBeenCalled()
  })

  it('optionalAuth keeps a session issued after the stamp', async () => {
    mockVerifySession.mockResolvedValue({ sub: CACHED_TEST_ID, pubkey: 'pk1', iat: AFTER })
    mockQuery.mockResolvedValue(rowWithStamp)
    const req = createMockReq()

    await optionalAuth(req, createMockReply())

    expect(req.session).not.toBeNull()
    expect(req.headers['x-reader-id']).toBe(CACHED_TEST_ID)
  })
})

describe('requireAuth — the age declaration is refused SERVER-side (Terms 1.1; §0z item 11)', () => {
  beforeEach(() => {
    mockVerifySession.mockReset()
    mockRefreshIfNeeded.mockReset()
    mockQuery.mockReset()
    invalidateAuthCache('user-age')
  })

  it('answers 403 age_required to an active member with no declaration', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-age', pubkey: 'pk' })
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ status: 'active', sessions_invalidated_at: null, age_declared: false }],
    })
    const req = createMockReq()
    const reply = createMockReply()
    await requireAuth(req, reply)
    // Pre-fix: passed — nothing on the server read the column.
    expect(reply.status).toHaveBeenCalledWith(403)
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'age_required' }))
    // The query actually asked the column — a mock that answered `age_declared`
    // to a SELECT that never named it would pin the fixture.
    expect(mockQuery.mock.calls[0][0]).toMatch(/age_declared_at IS NOT NULL/)
  })

  it('lets a route that names itself through, so the gate can be answered', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-age', pubkey: 'pk' })
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ status: 'active', sessions_invalidated_at: null, age_declared: false }],
    })
    const req = createMockReq()
    req.routeOptions = { config: { allowUndeclaredAge: true } }
    const reply = createMockReply()
    await requireAuth(req, reply)
    expect(reply.status).not.toHaveBeenCalled()
    expect(req.session?.sub).toBe('user-age')
  })

  it('a declared member passes as before', async () => {
    mockVerifySession.mockResolvedValue({ sub: 'user-age', pubkey: 'pk' })
    mockQuery.mockResolvedValue({
      rowCount: 1,
      rows: [{ status: 'active', sessions_invalidated_at: null, age_declared: true }],
    })
    const req = createMockReq()
    const reply = createMockReply()
    await requireAuth(req, reply)
    expect(reply.status).not.toHaveBeenCalled()
  })
})
