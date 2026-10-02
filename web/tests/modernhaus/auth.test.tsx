import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleDoor } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { assembleDateOfBirth } from '../../src/modernhaus/actions/auth'
import { signinGET, signupGET, verifyGET, ageGET } from '../../src/modernhaus/routes'
import {
  SIGNUP_EMAIL_TAKEN,
  SIGNUP_ACCOUNT_RACE,
  VERIFY_EXPIRED,
  LINK_JOIN_WAITLIST,
  LINK_MAKE_ACCOUNT,
} from '../../src/content/auth'
import { TOKEN } from './fixtures'

// =============================================================================
// E2 — SIGNING IN (MODERNHAUS-ADR §D2.3, §D2.4), through the real door and the
// real registry. Each case asserts what the GATEWAY was sent and where the
// member was sent — never the status alone (testing.md).
// =============================================================================

const ORIGIN = 'http://localhost:3010'
const ME = { id: 'u1', username: 'viv', displayName: 'Viv', ageDeclaredAt: null }

type Answer = { status: number; body?: unknown; setCookie?: string } | 'throw'

/** A gateway that answers by `METHOD /path`; anything unlisted is a test failure. */
function gateway(answers: Record<string, Answer>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}`
    const a = answers[key]
    if (a === undefined) throw new Error(`unexpected gateway call ${key}`)
    if (a === 'throw') throw new TypeError('fetch failed')
    const headers = new Headers({ 'content-type': 'application/json' })
    if (a.setCookie) headers.append('set-cookie', a.setCookie)
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function sent(fetchMock: ReturnType<typeof gateway>, key: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => `${init?.method ?? 'GET'} ${new URL(url).pathname.replace(/^\/api\/v1/, '')}` === key,
  )
  return call ? JSON.parse(call[1]!.body as string) : undefined
}

function post(action: string, form: Record<string, string>) {
  const body = new URLSearchParams({ _csrf: TOKEN, ...form })
  const request = new Request(`${ORIGIN}/modernhaus/do/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `mh_csrf=${TOKEN}` },
    body: body.toString(),
  })
  return handleDoor(request, action, REGISTRY)
}

function get(path: string) {
  return new Request(`${ORIGIN}${path}`, { headers: { cookie: `mh_csrf=${TOKEN}` } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('signin', () => {
  it('asks for a modernhaus link, carrying the arrival, and says a link was sent', async () => {
    const gw = gateway({ 'POST /auth/login': { status: 200 } })
    const res = await post('signin', { email: ' m@example.com ', arrival: 'my-piece' })
    expect(sent(gw, 'POST /auth/login')).toEqual({ email: 'm@example.com', surface: 'modernhaus', arrivalDTag: 'my-piece' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/modernhaus/signin?done=link_sent')
  })

  it('carries no arrival when there is none, or one the route would refuse', async () => {
    const gw = gateway({ 'POST /auth/login': { status: 200 } })
    await post('signin', { email: 'm@example.com', arrival: 'x'.repeat(201) })
    expect(sent(gw, 'POST /auth/login')).toEqual({ email: 'm@example.com', surface: 'modernhaus' })
  })
})

describe('verify — the emailed link', () => {
  it('the GET renders a button and never spends the token', async () => {
    const gw = gateway({ 'GET /auth/me': { status: 401 } })
    const res = await verifyGET(get('/modernhaus/auth/verify?token=t0k&arrival=my-piece'), { params: {} })
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(gw.mock.calls.map(([u]) => new URL(u).pathname)).toEqual(['/api/v1/auth/me'])
    expect(html).toContain('action="/modernhaus/do/verify"')
    expect(html).toContain('name="token" value="t0k"')
  })

  it('the press spends it, forwards the session and lands on the piece, rebuilt from its identifier', async () => {
    const gw = gateway({ 'POST /auth/verify': { status: 200, setCookie: 'pp_session=s; Path=/; HttpOnly' } })
    const res = await post('verify', { token: 't0k', arrival: 'a/../../admin' })
    expect(sent(gw, 'POST /auth/verify')).toEqual({ token: 't0k' })
    expect(res.headers.get('location')).toBe('/modernhaus/article/a%2F..%2F..%2Fadmin')
    expect(res.headers.getSetCookie()).toEqual(['pp_session=s; Path=/; HttpOnly'])
  })

  it('with no arrival it goes home, and announces nothing', async () => {
    gateway({ 'POST /auth/verify': { status: 200 } })
    const res = await post('verify', { token: 't0k' })
    expect(res.headers.get('location')).toBe('/modernhaus')
  })

  it("a spent link is the link's failure, never the door's sign-in redirect", async () => {
    gateway({ 'POST /auth/verify': { status: 401, body: { error: "That login link isn't valid. It may have expired or already been used, so please request another one." } } })
    const res = await post('verify', { token: 'spent' })
    expect(res.headers.get('location')).toBe('/modernhaus/auth/verify?error=link_expired')
  })

  it('the failed page says so, and offers a new link', async () => {
    gateway({ 'GET /auth/me': { status: 401 } })
    const html = await (await verifyGET(get('/modernhaus/auth/verify?error=link_expired'), { params: {} })).text()
    expect(html).toContain(VERIFY_EXPIRED.replace(/’/g, '’'))
    expect(html).toContain('href="/modernhaus/signin"')
    expect(html).not.toContain('do/verify')
  })

  it('no token, no call', async () => {
    const gw = gateway({})
    const res = await post('verify', {})
    expect(gw).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('/modernhaus/auth/verify')
  })
})

describe('signup', () => {
  const FORM = { email: 'new@example.com', displayName: 'Nan', dob_day: '5', dob_month: '3', dob_year: '1990' }

  it('sends the three boxes as one padded date, forwards the session and goes to a VALIDATED next', async () => {
    const gw = gateway({ 'POST /auth/signup': { status: 201, setCookie: 'pp_session=n; Path=/' } })
    const res = await post('signup', { ...FORM, next: '/modernhaus/tag/x' })
    expect(sent(gw, 'POST /auth/signup')).toEqual({ email: 'new@example.com', displayName: 'Nan', dateOfBirth: '1990-03-05' })
    expect(res.headers.get('location')).toBe('/modernhaus/tag/x')
    expect(res.headers.getSetCookie()).toEqual(['pp_session=n; Path=/'])
    gateway({ 'POST /auth/signup': { status: 201 } })
    const bad = await post('signup', { ...FORM, next: 'https://evil.example/' })
    expect(bad.headers.get('location')).toBe('/modernhaus')
  })

  it('the closed beta sends them to the waiting list', async () => {
    gateway({ 'POST /auth/signup': { status: 403, body: { error: 'closed_beta' } } })
    const res = await post('signup', FORM)
    expect(res.headers.get('location')).toBe('/modernhaus/waitlist?from=beta')
  })

  it("a 400 re-renders the form with the server's own sentence, escaped, and what was typed", async () => {
    gateway({
      'POST /auth/signup': {
        status: 400,
        body: { error: 'age_declaration_refused', message: 'You have to be 18 or over <b>here</b>.' },
      },
    })
    const res = await post('signup', { ...FORM, displayName: 'Nan "the <i>" reader' })
    const html = await res.text()
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBeNull()
    expect(html).toContain('<p role="status">You have to be 18 or over &lt;b&gt;here&lt;/b&gt;.</p>')
    expect(html).toContain('value="Nan &quot;the &lt;i&gt;&quot; reader"')
    expect(html).toMatch(/name="dob_year"[^>]*value="1990"/)
  })

  it('the two 409s say two different things', async () => {
    gateway({ 'POST /auth/signup': { status: 409, body: { error: 'email_taken' } } })
    expect(await (await post('signup', FORM)).text()).toContain(SIGNUP_EMAIL_TAKEN)
    gateway({ 'POST /auth/signup': { status: 409, body: { error: 'account_taken' } } })
    const race = await (await post('signup', FORM)).text()
    expect(race).toContain(SIGNUP_ACCOUNT_RACE)
    expect(race).not.toContain(SIGNUP_EMAIL_TAKEN)
  })

  it('the page is offered only while accounts can be made', async () => {
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 404 } })
    const closed = await signupGET(get('/modernhaus/signup'), { params: {} })
    expect(closed.headers.get('location')).toBe('/modernhaus/waitlist?from=beta')

    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 200, body: { open: true } } })
    const open = await (await signupGET(get('/modernhaus/signup'), { params: {} })).text()
    expect(open).toContain('action="/modernhaus/do/signup"')
  })

  it('an unreadable /auth/open is a fault on the signup page, never "closed"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 503 } })
    const res = await signupGET(get('/modernhaus/signup'), { params: {} })
    expect(res.status).toBe(500)
    expect(res.headers.get('location')).toBeNull()
  })
})

describe('signin page', () => {
  it('offers the waiting list when it cannot find out whether accounts are open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': 'throw' })
    const html = await (await signinGET(get('/modernhaus/signin'), { params: {} })).text()
    expect(html).toContain(`<a href="/modernhaus/waitlist">${LINK_JOIN_WAITLIST}</a>`)
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 200 } })
    const open = await (await signinGET(get('/modernhaus/signin'), { params: {} })).text()
    expect(open).toContain(`<a href="/modernhaus/signup">${LINK_MAKE_ACCOUNT}</a>`)
  })

  it('an article return becomes the arrival the emailed link carries', async () => {
    gateway({ 'GET /auth/me': { status: 401 }, 'GET /auth/open': { status: 404 } })
    const html = await (
      await signinGET(get('/modernhaus/signin?return=%2Fmodernhaus%2Farticle%2Fmy-piece'), { params: {} })
    ).text()
    expect(html).toContain('name="arrival" value="my-piece"')
  })
})

describe('the age step', () => {
  it('sends the assembled date and returns the member where they were going', async () => {
    const gw = gateway({ 'POST /auth/declare-age': { status: 200, body: { ok: true, recorded: true } } })
    const res = await post('declare_age', { dob_day: '29', dob_month: '2', dob_year: '2000', next: '/modernhaus/tag/x' })
    expect(sent(gw, 'POST /auth/declare-age')).toEqual({ dateOfBirth: '2000-02-29' })
    expect(res.headers.get('location')).toBe('/modernhaus/tag/x')
  })

  it("a refusal re-renders the boxes with the server's sentence", async () => {
    gateway({
      'POST /auth/declare-age': { status: 400, body: { error: 'age_declaration_refused', message: 'Under 18.' } },
      'GET /auth/me': { status: 200, body: ME },
    })
    const res = await post('declare_age', { dob_day: '1', dob_month: '1', dob_year: '2020' })
    const html = await res.text()
    expect(res.status).toBe(400)
    expect(html).toContain('<p role="status">Under 18.</p>')
    expect(html).toMatch(/name="dob_year"[^>]*value="2020"/)
  })

  it('the page redirects a declared member onward, and a stranger to sign in', async () => {
    gateway({ 'GET /auth/me': { status: 200, body: { ...ME, ageDeclaredAt: '2026-01-01T00:00:00Z' } } })
    const declared = await ageGET(get('/modernhaus/age?return=%2Fmodernhaus%2Fsearch'), { params: {} })
    expect(declared.headers.get('location')).toBe('/modernhaus/search')
    gateway({ 'GET /auth/me': { status: 401 } })
    const stranger = await ageGET(get('/modernhaus/age'), { params: {} })
    expect(stranger.headers.get('location')).toBe('/modernhaus/signin?return=%2Fmodernhaus%2Fage')
  })
})

describe('waitlist and signout', () => {
  it('waitlist sends the email alone', async () => {
    const gw = gateway({ 'POST /waitlist': { status: 200 } })
    const res = await post('waitlist', { email: 'w@example.com' })
    expect(sent(gw, 'POST /waitlist')).toEqual({ email: 'w@example.com' })
    expect(res.headers.get('location')).toBe('/modernhaus/waitlist?done=waitlisted')
  })

  it("signout forwards the gateway's clearing cookie and goes home", async () => {
    const gw = gateway({ 'POST /auth/logout': { status: 200, setCookie: 'pp_session=; Max-Age=0; Path=/' } })
    const res = await post('signout', {})
    expect(gw).toHaveBeenCalledTimes(1)
    expect(res.headers.get('location')).toBe('/modernhaus?done=signed_out')
    expect(res.headers.getSetCookie()).toEqual(['pp_session=; Max-Age=0; Path=/'])
  })
})

describe('assembleDateOfBirth', () => {
  it("pads, in the wire order, and is '' until all three boxes hold something", () => {
    expect(assembleDateOfBirth({ day: '5', month: '3', year: '1978' })).toBe('1978-03-05')
    expect(assembleDateOfBirth({ day: '5', month: '', year: '1978' })).toBe('')
    expect(assembleDateOfBirth({ day: '5', month: '3', year: '78' })).toBe('0078-03-05')
  })
})
