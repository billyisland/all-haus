import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the module under test
const mockVerifySession = vi.fn()
const mockRefreshIfNeeded = vi.fn()
const mockQuery = vi.fn()

vi.mock('@platform-pub/shared/auth/session.js', () => ({
  verifySession: (...args: any[]) => mockVerifySession(...args),
  refreshIfNeeded: (...args: any[]) => mockRefreshIfNeeded(...args),
  destroySession: vi.fn(),
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
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active' }] })
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
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active' }] })
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
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ status: 'active' }] })
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
  const activeRow = { rowCount: 1, rows: [{ status: 'active', sessions_invalidated_at: null }] }
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
