import { describe, it, expect, vi, afterEach } from 'vitest'
import { modernhausPage, type PageRequest, type PageResult } from '../../src/modernhaus/page'
import { outcomeFromQuery, GENERIC_FAULT } from '../../src/modernhaus/outcomes'
import { CSP } from '../../src/modernhaus/respond'
import { TOKEN } from './fixtures'

// =============================================================================
// THE PAGE PIPELINE (MODERNHAUS-ADR §D1.2, §D2.2). `/auth/me` is the shell's
// one primary read: a 401 is "signed out", a fault is the fault page — never
// "signed out" (root CLAUDE.md: a normal return never also means "we are
// broken"). Asserted by whether the page's LOADER ran, not by status alone.
// =============================================================================

type MeAnswer = { status: number; body?: unknown; setCookie?: string } | 'throw'

function stubMe(answer: MeAnswer, counts: MeAnswer = { status: 200, body: { notificationCount: 3, dmCount: 1 } }) {
  const fetchMock = vi.fn(async (url: string) => {
    // The nav's counts are their own read (§D2.2); everything else is /auth/me.
    const a = new URL(url).pathname.endsWith('/unread-counts') ? counts : answer
    if (a === 'throw') throw new TypeError('fetch failed')
    const headers = new Headers({ 'content-type': 'application/json' })
    if (a.setCookie) headers.append('set-cookie', a.setCookie)
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function get(path = '/modernhaus/x', cookie: string | null = `mh_csrf=${TOKEN}`) {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return new Request(`http://localhost:3010${path}`, { headers })
}

function pageWithLoader() {
  const loader = vi.fn(async (_r: PageRequest<Record<string, never>>): Promise<PageResult> => ({
    kind: 'page',
    title: 'A page',
    twin: '/x',
    body: <p>body text</p>,
  }))
  return { loader, handler: modernhausPage(loader) }
}

const ME = { id: 'u1', username: 'viv', displayName: 'Viv', ageDeclaredAt: '2026-01-01T00:00:00Z' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the shell reads /auth/me', () => {
  it('a throw is the fault page and the loader never runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubMe('throw')
    const { loader, handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.status).toBe(500)
    expect(loader).not.toHaveBeenCalled()
    const html = await res.text()
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('About') // not dressed as the signed-out shell
  })

  it('a 5xx is the fault page, not "signed out"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubMe({ status: 503 })
    const { loader, handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.status).toBe(500)
    expect(loader).not.toHaveBeenCalled()
  })

  it('401 is signed out, and the loader runs with no viewer', async () => {
    stubMe({ status: 401, body: { error: 'Authentication required' } })
    const { loader, handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.status).toBe(200)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader.mock.calls[0][0]).toMatchObject({ viewer: null })
    expect(await res.text()).toContain('<a href="/modernhaus/about">About</a>')
  })

  it('a member reaches the loader as themselves', async () => {
    stubMe({ status: 200, body: ME })
    const { loader, handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.status).toBe(200)
    expect(loader.mock.calls[0][0]).toMatchObject({ viewer: { id: 'u1', username: 'viv' } })
    expect(await res.text()).toContain('href="/modernhaus/u/viv"')
  })

  it('a member with no age declaration is sent to the age step, and the loader never runs', async () => {
    stubMe({ status: 200, body: { ...ME, ageDeclaredAt: null } })
    const { loader, handler } = pageWithLoader()
    const res = await handler(get('/modernhaus/tag/x?cursor=c'), { params: {} })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/modernhaus/age?return=%2Fmodernhaus%2Ftag%2Fx%3Fcursor%3Dc')
    expect(loader).not.toHaveBeenCalled()
  })

  it('the age page alone opts out, so an undeclared member can reach it', async () => {
    stubMe({ status: 200, body: { ...ME, ageDeclaredAt: null } })
    const loader = vi.fn(async (): Promise<PageResult> => ({ kind: 'page', title: 'Age', twin: null, body: <p>boxes</p> }))
    const res = await modernhausPage(loader, { allowUndeclared: true })(get('/modernhaus/age'), { params: {} })
    expect(res.status).toBe(200)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('a signed-in nav carries sign-out as a POST form with the token; signed out, a Sign in link', async () => {
    stubMe({ status: 200, body: ME })
    const member = await (await pageWithLoader().handler(get(), { params: {} })).text()
    // Attribute order is not asserted: Next's React writes `action` first.
    const signout = member.match(/<form\b[^>]*action="\/modernhaus\/do\/signout"[^>]*>[\s\S]*?<\/form>/)
    expect(signout?.[0]).toMatch(/\smethod="post"/)
    expect(signout?.[0]).toMatch(/<input type="hidden" name="_csrf" value="a{43}"\/><button>Sign out<\/button><\/form>$/)
    expect(member).not.toContain('href="/modernhaus/signin"')
    stubMe({ status: 401 })
    const stranger = await (await pageWithLoader().handler(get(), { params: {} })).text()
    expect(stranger).toContain('<a href="/modernhaus/signin">Sign in</a>')
    expect(stranger).not.toContain('do/signout')
  })

  it('an ABSENT ageDeclaredAt is a fault, never "declared" (undefined !== null fails open)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ageDeclaredAt: _drop, ...stale } = ME
    stubMe({ status: 200, body: stale })
    const { loader, handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.status).toBe(500)
    expect(loader).not.toHaveBeenCalled()
  })
})

describe('the nav counts (§D2.2: a secondary read)', () => {
  const nav = async (counts: MeAnswer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = stubMe({ status: 200, body: ME }, counts)
    const { handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    return { res, html: await res.text(), fetchMock }
  }

  it('shows the count a member has', async () => {
    const { res, html, fetchMock } = await nav({ status: 200, body: { notificationCount: 3, dmCount: 1 } })
    expect(res.status).toBe(200)
    expect(html).toContain('>Notifications (3)</a>')
    expect(fetchMock.mock.calls.map(([u]) => new URL(u as string).pathname)).toContain('/api/v1/unread-counts')
  })

  it('zero is no count, never "(0)"', async () => {
    const { html } = await nav({ status: 200, body: { notificationCount: 0, dmCount: 0 } })
    expect(html).toContain('>Notifications</a>')
    expect(html).not.toContain('(0)')
  })

  for (const [name, counts] of [
    ['a throw', 'throw'],
    ['a 5xx', { status: 503 }],
    ['a body it cannot read', { status: 200, body: { notificationCount: 'lots' } }],
  ] as Array<[string, MeAnswer]>) {
    it(`${name} renders the page with no count, never "(0)" and never the fault page`, async () => {
      const { res, html } = await nav(counts)
      expect(res.status).toBe(200)
      expect(html).toContain('body text')
      expect(html).toContain('>Notifications</a>')
      expect(html).not.toContain('(0)')
    })
  }

  it('a signed-out viewer is never asked for counts', async () => {
    const fetchMock = stubMe({ status: 401 })
    const { handler } = pageWithLoader()
    await handler(get(), { params: {} })
    expect(fetchMock.mock.calls.map(([u]) => new URL(u as string).pathname)).toEqual(['/api/v1/auth/me'])
  })
})

describe('every response', () => {
  it('carries the fixed headers and copies the gateway cookies on', async () => {
    stubMe({ status: 200, body: ME, setCookie: 'pp_session=refreshed; Path=/; HttpOnly' })
    const { handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
    expect(res.headers.get('content-security-policy')).toBe(CSP)
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.getSetCookie()).toEqual(['pp_session=refreshed; Path=/; HttpOnly'])
  })

  it('mints the CSRF cookie when the viewer has none, and only then', async () => {
    stubMe({ status: 401 })
    const { handler } = pageWithLoader()
    const fresh = await handler(get('/modernhaus/x', null), { params: {} })
    const minted = fresh.headers.getSetCookie().find((c) => c.startsWith('mh_csrf='))
    expect(minted).toMatch(/^mh_csrf=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/)
    const again = await handler(get(), { params: {} })
    expect(again.headers.getSetCookie()).toEqual([])
  })

  it('the fault page carries the same headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubMe('throw')
    const { handler } = pageWithLoader()
    const res = await handler(get(), { params: {} })
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
    expect(res.headers.get('content-security-policy')).toBe(CSP)
  })
})

describe('outcomes render from the table and never from the URL', () => {
  it('a known code is its sentence', async () => {
    stubMe({ status: 401 })
    const { handler } = pageWithLoader()
    const html = await (await handler(get('/modernhaus/x?error=rate_limited'), { params: {} })).text()
    expect(html).toContain('<p role="status">That was too many requests')
  })

  it('a crafted code renders the generic sentence and echoes nothing', async () => {
    stubMe({ status: 401 })
    const { handler } = pageWithLoader()
    const html = await (await handler(get('/modernhaus/x?error=%3Cb%3Eyou%20won%3C%2Fb%3E'), { params: {} })).text()
    expect(html).not.toContain('you won')
    expect(html).toContain(GENERIC_FAULT.replace(/'/g, '&#x27;'))
  })

  it('an unknown success code claims nothing', () => {
    expect(outcomeFromQuery(new URLSearchParams('done=anything'))).toBeNull()
  })
})
