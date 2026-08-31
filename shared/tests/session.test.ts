import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { SignJWT, jwtVerify } from 'jose'

// jwtVerify delegates to the real implementation unless a test installs an
// override — the only way to make it throw something that ISN'T a JOSEError,
// which is the case verifySession must now re-throw rather than swallow.
const hoisted = vi.hoisted(() => ({ verifyThrows: null as unknown }))
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return {
    ...actual,
    jwtVerify: (...args: unknown[]) => {
      if (hoisted.verifyThrows) throw hoisted.verifyThrows
      return (actual.jwtVerify as any)(...args)
    },
  }
})

const reqWithCookie = (token?: string): any => ({
  cookies: token === undefined ? {} : { pp_session: token },
})

// =============================================================================
// Session Tests
//
// Tests the JWT session logic in isolation — no Fastify, no DB.
// We test the token creation and verification directly since the session
// module's core is just JWT operations.
// =============================================================================

const TEST_SECRET = 'test-session-secret-at-least-32-chars-long'
const SECRET_KEY = new TextEncoder().encode(TEST_SECRET)

beforeAll(() => {
  process.env.SESSION_SECRET = TEST_SECRET
})

afterEach(() => {
  hoisted.verifyThrows = null
})

describe('JWT session tokens', () => {
  // Exercise the REAL createSession (migration 145 removed the isWriter claim;
  // the prior tests here hand-built tokens with jose and kept asserting the
  // removed claim — passing while testing nothing the module does).
  it('createSession mints a token with sub + pubkey and sets the cookie', async () => {
    const { createSession } = await import('../src/auth/session.js')
    const setCookie = vi.fn()
    const reply: any = { setCookie }

    const token = await createSession(reply, {
      id: 'account-uuid-1234',
      nostrPubkey: 'abc123hexkey',
    })

    const { payload } = await jwtVerify(token, SECRET_KEY, { algorithms: ['HS256'] })
    expect(payload.sub).toBe('account-uuid-1234')
    expect(payload.pubkey).toBe('abc123hexkey')
    expect(payload.isWriter).toBeUndefined() // claim removed with migration 145
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(setCookie).toHaveBeenCalledOnce()
    expect(setCookie.mock.calls[0][1]).toBe(token)
  })

})

// ---------------------------------------------------------------------------
// verifySession — a bad TOKEN is a value (null); a bad DEPLOYMENT is an error.
// The prior tests here called jwtVerify directly, so they pinned jose's
// behaviour and left verifySession's own catch untested.
// ---------------------------------------------------------------------------

describe('verifySession', () => {
  it('returns the payload for a valid token', async () => {
    const { verifySession } = await import('../src/auth/session.js')

    const token = await new SignJWT({ pubkey: 'abc123hexkey' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('account-uuid-1234')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(SECRET_KEY)

    const session = await verifySession(reqWithCookie(token))
    expect(session?.sub).toBe('account-uuid-1234')
    expect(session?.pubkey).toBe('abc123hexkey')
  })

  it('returns null when there is no cookie', async () => {
    const { verifySession } = await import('../src/auth/session.js')
    expect(await verifySession(reqWithCookie())).toBeNull()
  })

  it('returns null for a token signed with a different secret', async () => {
    const { verifySession } = await import('../src/auth/session.js')
    const wrongKey = new TextEncoder().encode('wrong-secret-that-is-also-32-chars!')

    const token = await new SignJWT({ pubkey: 'key' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('uuid')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(wrongKey)

    expect(await verifySession(reqWithCookie(token))).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const { verifySession } = await import('../src/auth/session.js')

    const token = await new SignJWT({ pubkey: 'key' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('uuid')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 86400 * 8) // 8 days ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 86400) // expired yesterday
      .sign(SECRET_KEY)

    expect(await verifySession(reqWithCookie(token))).toBeNull()
  })

  it('returns null for a malformed cookie value', async () => {
    const { verifySession } = await import('../src/auth/session.js')
    expect(await verifySession(reqWithCookie('not-a-jwt'))).toBeNull()
  })

  it('re-throws a non-JOSE failure instead of reporting it as no session', async () => {
    const { verifySession } = await import('../src/auth/session.js')

    const token = await new SignJWT({ pubkey: 'key' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('uuid')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(SECRET_KEY)

    hoisted.verifyThrows = new TypeError('something of ours is broken')

    await expect(verifySession(reqWithCookie(token))).rejects.toThrow(
      'something of ours is broken'
    )
  })

  it('throws when SESSION_SECRET is missing, rather than logging everyone out', async () => {
    const saved = process.env.SESSION_SECRET
    delete process.env.SESSION_SECRET
    vi.resetModules() // drop the cached signingKey

    try {
      const { verifySession } = await import('../src/auth/session.js')
      await expect(verifySession(reqWithCookie('any.token.value'))).rejects.toThrow(
        /SESSION_SECRET/
      )
    } finally {
      process.env.SESSION_SECRET = saved
      vi.resetModules()
    }
  })
})

describe('session refresh logic', () => {
  it('identifies tokens past half-life (3.5 days)', () => {
    const halfLifeSeconds = 3.5 * 24 * 60 * 60
    const now = Math.floor(Date.now() / 1000)

    // Token issued 4 days ago — past half-life
    const oldIat = now - (4 * 24 * 60 * 60)
    const age = now - oldIat
    expect(age).toBeGreaterThan(halfLifeSeconds)

    // Token issued 2 days ago — not past half-life
    const recentIat = now - (2 * 24 * 60 * 60)
    const recentAge = now - recentIat
    expect(recentAge).toBeLessThan(halfLifeSeconds)
  })
})
