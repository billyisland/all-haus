import { describe, it, expect, vi, afterEach } from 'vitest'
import { handleDoor, shapeInput, type Registry } from '../../src/modernhaus/door'
import { REGISTRY } from '../../src/modernhaus/actions'
import { safeReturn } from '../../src/modernhaus/outcomes'
import { TOKEN } from './fixtures'

// =============================================================================
// THE DOOR (MODERNHAUS-ADR §D1.3, §D1.6, §D1.9). Every refusal is asserted by
// what the OTHER side did — whether the gateway was called — never by the
// status alone: a door that ran the write and then answered 403 would pass a
// status check (testing.md).
// =============================================================================

const ORIGIN = 'http://localhost:3010'

const TEST_REGISTRY: Registry = {
  poke: {
    kind: 'simple',
    method: 'POST',
    fields: { note: 'string', loud: 'boolean' },
    path: () => '/poke',
    body: (input) => ({ note: input.note, loud: input.loud }),
    done: 'poked',
    defaultReturn: () => '/modernhaus/home-of-poke',
  },
}

function req(opts: {
  action?: string
  cookie?: string | null
  form?: Record<string, string>
  headers?: Record<string, string>
}): { request: Request; action: string } {
  const form = new URLSearchParams(opts.form ?? { _csrf: TOKEN, note: 'hi' })
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-forwarded-for': '203.0.113.9',
    ...(opts.headers ?? {}),
  }
  const cookie = opts.cookie === undefined ? `mh_csrf=${TOKEN}; pp_session=sess` : opts.cookie
  if (cookie !== null) headers.cookie = cookie
  const action = opts.action ?? 'poke'
  return {
    request: new Request(`${ORIGIN}/modernhaus/do/${action}`, { method: 'POST', headers, body: form.toString() }),
    action,
  }
}

function gatewayAnswers(status: number, body: unknown = {}, setCookie?: string) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (setCookie) headers.append('set-cookie', setCookie)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function run(r: { request: Request; action: string }, registry: Registry = TEST_REGISTRY) {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return handleDoor(r.request, r.action, registry)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CSRF: a refusal runs nothing', () => {
  const cases: Array<[string, Parameters<typeof req>[0]]> = [
    ['no cookie', { cookie: 'pp_session=sess' }],
    ['no field', { form: { note: 'hi' } }],
    ['a field that does not match', { form: { _csrf: 'b'.repeat(43), note: 'hi' } }],
    ['a cross-site fetch', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['a same-site (not same-origin) fetch', { headers: { 'sec-fetch-site': 'same-site' } }],
    ['a foreign Origin', { headers: { origin: 'https://evil.example' } }],
    ['an https Origin on an http request', { headers: { origin: 'https://localhost:3010' } }],
  ]
  for (const [name, opts] of cases) {
    it(name, async () => {
      const fetchMock = gatewayAnswers(200)
      const res = await run(req(opts))
      expect(res.status).toBe(403)
      expect(res.headers.get('location')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }

  it('accepts the token alone (a text browser sends neither header)', async () => {
    const fetchMock = gatewayAnswers(200)
    const res = await run(req({}))
    expect(res.status).toBe(303)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts matching headers where they are present', async () => {
    const fetchMock = gatewayAnswers(200)
    const res = await run(req({ headers: { 'sec-fetch-site': 'same-origin', origin: ORIGIN } }))
    expect(res.status).toBe(303)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('names the cookie __Host- behind https, and refuses the plain name there', async () => {
    const fetchMock = gatewayAnswers(200)
    const res = await run(req({ headers: { 'x-forwarded-proto': 'https', host: 'all.haus' } }))
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    const ok = await run(req({ cookie: `__Host-mh_csrf=${TOKEN}`, headers: { 'x-forwarded-proto': 'https', host: 'all.haus', origin: 'https://all.haus' } }))
    expect(ok.status).toBe(303)
  })
})

describe('dispatch and outcome', () => {
  it('an unknown action is a 404 and runs nothing', async () => {
    const fetchMock = gatewayAnswers(200)
    const res = await run(req({ action: 'nope' }))
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an inherited property is not an action', async () => {
    const fetchMock = gatewayAnswers(200)
    const res = await run(req({ action: 'constructor' }))
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('registers exactly the actions built so far (E2: signing in; E3: reading; E4: writing; E5: money; E6: the rest)', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(
      [
        'declare_age', 'signin', 'signout', 'signup', 'verify', 'waitlist',
        'vote', 'reply', 'external_like', 'external_repost', 'external_reply', 'external_poll_vote',
        'note_delete', 'reply_delete', 'report', 'notification_read', 'notifications_read_all',
        'feed_create', 'feed_hide', 'feed_show', 'feed_move', 'feed_mark_seen', 'follow', 'unfollow_everywhere',
        'note', 'draft_save', 'publish_now', 'schedule', 'unschedule', 'draft_delete', 'upload',
        'unlock', 'subscribe', 'subscription_cancel', 'subscription_notify', 'subscription_visibility',
        'tab_settle', 'card_remove', 'payout_prefs_save', 'writer_upgrade', 'writer_apply',
        'message_send', 'messages_read_all', 'message_like', 'conversation_start',
        'block', 'unblock', 'mute', 'unmute',
        'profile_save', 'username_change', 'email_change', 'export_request', 'deactivate', 'account_delete',
        'network_link', 'network_update', 'network_unlink', 'follow_import', 'follow_import_opml',
        'privacy_save', 'notification_prefs_save', 'reading_log_toggle', 'reading_log_clear',
        'article_replies', 'article_unpublish', 'article_delete', 'article_tags', 'gift_link_create', 'gift_link_revoke',
        'price_save', 'welcome_save', 'offer_create', 'offer_revoke',
        'feed_rename', 'source_update', 'source_remove', 'source_move', 'source_add', 'feed_merge', 'feed_delete',
        'formula_freeze', 'formula_revoke', 'formula_redeem',
        'appeal', 'export_download',
      ].sort(),
    )
  })

  it('forwards cookie and X-Forwarded-For, never caches, and sends the shaped JSON', async () => {
    const fetchMock = gatewayAnswers(200)
    await run(req({ form: { _csrf: TOKEN, note: 'hello', loud: 'on' } }))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/poke$/)
    expect(init.method).toBe('POST')
    expect(init.cache).toBe('no-store')
    const h = init.headers as Record<string, string>
    expect(h.cookie).toContain('pp_session=sess')
    expect(h['x-forwarded-for']).toBe('203.0.113.9')
    expect(JSON.parse(init.body as string)).toEqual({ note: 'hello', loud: true })
  })

  it('success is a 303 to the validated return with ?done=, carrying the gateway cookies', async () => {
    gatewayAnswers(200, {}, 'pp_session=new; Path=/; HttpOnly')
    const res = await run(req({ form: { _csrf: TOKEN, note: 'x', return: '/modernhaus/u/bea?view=notes' } }))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/modernhaus/u/bea?view=notes&done=poked')
    expect(res.headers.getSetCookie()).toEqual(['pp_session=new; Path=/; HttpOnly'])
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform')
  })

  for (const bad of ['https://evil.example/', '//evil.example/x', '/modernhaus/../admin', '/elsewhere', '/modernhaus\\x', 'javascript:alert(1)']) {
    it(`a bad return (${bad}) falls back to the action's default`, async () => {
      gatewayAnswers(200)
      const res = await run(req({ form: { _csrf: TOKEN, note: 'x', return: bad } }))
      expect(res.headers.get('location')).toBe('/modernhaus/home-of-poke?done=poked')
    })
  }

  it("a route's refusal travels as a code from the closed vocabulary", async () => {
    gatewayAnswers(404, { error: 'Something in English that must never reach a URL' })
    const res = await run(req({}))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/modernhaus/home-of-poke?error=not_found')
  })

  it('401 goes to sign-in with the return, never to a fault', async () => {
    gatewayAnswers(401, { error: 'Authentication required' })
    const res = await run(req({ form: { _csrf: TOKEN, return: '/modernhaus/tag/x' } }))
    expect(res.headers.get('location')).toBe('/modernhaus/signin?return=%2Fmodernhaus%2Ftag%2Fx')
  })

  it('age_required goes to the age step', async () => {
    gatewayAnswers(403, { error: 'age_required' })
    const res = await run(req({}))
    expect(res.headers.get('location')).toBe('/modernhaus/age')
  })

  it('a network throw is the fault page — never a success, never "signed out"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const res = await run(req({}))
    expect(res.status).toBe(500)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).toContain('Something went wrong')
  })

  it('a 5xx is the fault page', async () => {
    gatewayAnswers(502, { error: 'bad gateway' })
    const res = await run(req({}))
    expect(res.status).toBe(500)
    expect(res.headers.get('location')).toBeNull()
  })

  it('a 2xx that is not JSON is the fault page, not a success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy</html>', { status: 200 })))
    const res = await run(req({}))
    expect(res.status).toBe(500)
  })
})

describe('shapeInput', () => {
  it('an absent checkbox is false, a list keeps repeats, a number parses or is null', () => {
    const f = new FormData()
    f.append('tags', 'a')
    f.append('tags', 'b')
    f.append('n', '12')
    f.append('bad', 'x')
    expect(shapeInput(f, { on: 'boolean', tags: 'list', n: 'number', bad: 'number', missing: 'string' })).toEqual({
      on: false,
      tags: ['a', 'b'],
      n: 12,
      bad: null,
      missing: null,
    })
  })

  it('a textarea’s CRLF line breaks arrive as LF, as the full site’s script sends them (E6)', () => {
    const f = new FormData()
    f.append('content', 'one\r\n\r\ntwo\rthree')
    f.append('tags', 'a\r\nb')
    expect(shapeInput(f, { content: 'string', tags: 'list' })).toEqual({ content: 'one\n\ntwo\nthree', tags: ['a\nb'] })
  })
})

describe('safeReturn', () => {
  it('keeps a path under /modernhaus and its query', () => {
    expect(safeReturn('/modernhaus')).toBe('/modernhaus')
    expect(safeReturn('/modernhaus/feed/1?cursor=a')).toBe('/modernhaus/feed/1?cursor=a')
  })
  it('refuses everything else', () => {
    for (const v of ['', '/', '/modernhausx', '/modernhaus/%2e%2e/admin', 'https://all.haus/modernhaus', '//all.haus/modernhaus', '/modernhaus/\nx']) {
      expect(safeReturn(v), v).toBeNull()
    }
  })
})
