import { describe, it, expect, beforeEach, vi } from 'vitest'

// =============================================================================
// Drives the REAL Mastodon adapter against a routed `safeFetch`, because the
// defect (CROSS-NETWORK-ROUNDTRIP-ADR F5) was invisible from the task side: a
// refused or empty search resolved to `undefined`, and the reply went out as a
// top-level status with no `in_reply_to_id`. The assertion that matters is the
// CALL LIST — a failed lookup must be followed by NO `POST /api/v1/statuses` —
// since an adapter that posted and then threw would still reject.
// =============================================================================

type Resp = { ok: boolean; status: number; text: string; url: string }
const calls: { url: string; method: string; body?: string }[] = []
let route: (url: string, method: string) => Resp

vi.mock('@platform-pub/shared/lib/http-client.js', () => ({
  safeFetch: vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body })
    return route(url, method)
  }),
}))

const { postMastodonStatus, favouriteMastodonStatus } = await import('./activitypub-outbound.js')
const { isTerminalDeliveryError } = await import('../lib/outbound-errors.js')

const HOME = 'https://home.example'
const REMOTE_URI = 'https://elsewhere.example/users/bob/statuses/111'
const FULL = 'read:accounts read:statuses read:search read:notifications write:statuses write:favourites'
const NARROW = 'read:accounts write:statuses' // what every pre-A3 token holds

const ok = (body: unknown): Resp => ({ ok: true, status: 200, text: JSON.stringify(body), url: '' })
const refused = (status: number): Resp => ({ ok: false, status, text: 'nope', url: '' })
const posted = ok({ id: '999', uri: `${HOME}/users/me/statuses/999` })

function reply(scope = FULL, replyToStatusUri = REMOTE_URI) {
  return postMastodonStatus(
    { instanceUrl: HOME, text: 'hello', maxChars: 500, replyToStatusUri, idempotencyKey: 'row-1' },
    { accessToken: 't', scope },
  )
}

const statusPosts = () => calls.filter((c) => c.method === 'POST' && c.url === `${HOME}/api/v1/statuses`)

beforeEach(() => {
  calls.length = 0
})

describe('postMastodonStatus — a reply is never posted without its parent', () => {
  it('threads a resolved remote parent under in_reply_to_id', async () => {
    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [{ id: '42' }] }) : posted)

    await reply()

    expect(statusPosts()).toHaveLength(1)
    expect(JSON.parse(statusPosts()[0].body!).in_reply_to_id).toBe('42')
  })

  it('threads a same-instance parent without searching', async () => {
    route = () => posted

    await reply(NARROW, `${HOME}/users/bob/statuses/77`)

    expect(calls.some((c) => c.url.includes('/api/v2/search'))).toBe(false)
    expect(JSON.parse(statusPosts()[0].body!).in_reply_to_id).toBe('77')
  })

  it('an EMPTY search is terminal and posts nothing', async () => {
    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [] }) : posted)

    const err = await reply().catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(statusPosts()).toHaveLength(0)
  })

  it.each([401, 403, 404, 422])('a %i search is terminal and posts nothing', async (status) => {
    route = (url) => (url.includes('/api/v2/search') ? refused(status) : posted)

    const err = await reply().catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(statusPosts()).toHaveLength(0)
  })

  it('a 401/403 search names the remedy', async () => {
    route = (url) => (url.includes('/api/v2/search') ? refused(403) : posted)

    const err = await reply().catch((e) => e)

    expect(String(err.message)).toMatch(/Reconnect/)
  })

  it.each([429, 500, 503])('a %i search is AMBIGUOUS (retried) and posts nothing', async (status) => {
    route = (url) => (url.includes('/api/v2/search') ? refused(status) : posted)

    const err = await reply().catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(isTerminalDeliveryError(err)).toBe(false)
    expect(statusPosts()).toHaveLength(0)
  })

  it('a token without read:search is refused BEFORE any request', async () => {
    route = () => posted

    const err = await reply(NARROW).catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(String(err.message)).toMatch(/Reconnect/)
    expect(calls).toHaveLength(0)
  })

  it('a token with no recorded scope is refused, never assumed', async () => {
    route = () => posted

    const err = await postMastodonStatus(
      { instanceUrl: HOME, text: 'hi', maxChars: 500, idempotencyKey: 'row-1' },
      { accessToken: 't' },
    ).catch((e) => e)

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it("a bare 'read write' grant covers the scoped checks", async () => {
    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [{ id: '42' }] }) : posted)

    await reply('read write')

    expect(statusPosts()).toHaveLength(1)
  })

  it('a 4xx on the status POST itself is terminal; a 5xx is ambiguous', async () => {
    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [{ id: '42' }] }) : refused(422))
    expect(isTerminalDeliveryError(await reply().catch((e) => e))).toBe(true)

    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [{ id: '42' }] }) : refused(502))
    expect(isTerminalDeliveryError(await reply().catch((e) => e))).toBe(false)
  })
})

describe('favouriteMastodonStatus', () => {
  it('a token without write:favourites is refused before any request', async () => {
    route = () => posted

    const err = await favouriteMastodonStatus(HOME, REMOTE_URI, { accessToken: 't', scope: NARROW }).catch(
      (e) => e,
    )

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('an empty search is terminal and favourites nothing', async () => {
    route = (url) => (url.includes('/api/v2/search') ? ok({ statuses: [] }) : posted)

    const err = await favouriteMastodonStatus(HOME, REMOTE_URI, { accessToken: 't', scope: FULL }).catch(
      (e) => e,
    )

    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(calls.some((c) => c.url.endsWith('/favourite'))).toBe(false)
  })
})

// =============================================================================
// A5: a reply names the author it answers. Mastodon notifies on MENTION, so a
// threaded reply without one tells nobody — and may never be delivered to the
// author's instance at all. The acct comes off the SEARCH (as the member's own
// instance names the author), or off the /users/<name>/ shape on a same-host
// parent.
// =============================================================================
const { withReplyMention } = await import('./activitypub-outbound.js')

const statusText = () => JSON.parse(statusPosts()[0].body!).status as string

describe('postMastodonStatus — the reply mentions its parent author (A5)', () => {
  function replyAs(self?: { accountId: string | null; handle: string | null }, text = 'hello', uri = REMOTE_URI) {
    return postMastodonStatus(
      { instanceUrl: HOME, text, maxChars: 500, replyToStatusUri: uri, idempotencyKey: 'row-1', self },
      { accessToken: 't', scope: FULL },
    )
  }

  it('prefixes the acct the search answered with', async () => {
    route = (url) =>
      url.includes('/api/v2/search')
        ? ok({ statuses: [{ id: '42', account: { id: '7', acct: 'bob@elsewhere.example' } }] })
        : posted

    await replyAs()

    expect(statusText()).toBe('@bob@elsewhere.example hello')
  })

  it('prefixes a same-host parent author from the status URI, bare', async () => {
    route = () => posted

    await replyAs(undefined, 'hello', `${HOME}/users/bob/statuses/77`)

    expect(statusText()).toBe('@bob hello')
  })

  it('does not mention the member themselves (search id)', async () => {
    route = (url) =>
      url.includes('/api/v2/search')
        ? ok({ statuses: [{ id: '42', account: { id: '7', acct: 'me@elsewhere.example' } }] })
        : posted

    await replyAs({ accountId: '7', handle: 'me@home.example' })

    expect(statusText()).toBe('hello')
  })

  it('does not mention the member themselves (same-host shortcut, by handle)', async () => {
    route = () => posted

    await replyAs({ accountId: '7', handle: 'Me@home.example' }, 'hello', `${HOME}/users/me/statuses/77`)

    expect(statusText()).toBe('hello')
  })

  it('does not repeat a mention the body already makes', async () => {
    route = (url) =>
      url.includes('/api/v2/search')
        ? ok({ statuses: [{ id: '42', account: { id: '7', acct: 'bob@elsewhere.example' } }] })
        : posted

    await replyAs(undefined, 'thanks @Bob@elsewhere.example!')

    expect(statusText()).toBe('thanks @Bob@elsewhere.example!')
  })

  it('keeps the mention when the body is truncated', async () => {
    route = (url) =>
      url.includes('/api/v2/search')
        ? ok({ statuses: [{ id: '42', account: { id: '7', acct: 'bob@elsewhere.example' } }] })
        : posted

    await postMastodonStatus(
      { instanceUrl: HOME, text: 'x'.repeat(600), maxChars: 100, replyToStatusUri: REMOTE_URI, idempotencyKey: 'r' },
      { accessToken: 't', scope: FULL },
    )

    expect(statusText().startsWith('@bob@elsewhere.example ')).toBe(true)
  })
})

describe('withReplyMention — whole handle only', () => {
  const bob = { id: '7', acct: 'bob' }
  it('a longer handle sharing the prefix is not the mention', () => {
    expect(withReplyMention('cc @bobby', bob, undefined, 'home.example')).toBe('@bob cc @bobby')
  })
  it('a remote handle on the same local name is not the mention', () => {
    expect(withReplyMention('cc @bob@other.example', bob, undefined, 'home.example')).toBe(
      '@bob cc @bob@other.example',
    )
  })
  it('the bare local mention at sentence end is', () => {
    expect(withReplyMention('right, @bob.', bob, undefined, 'home.example')).toBe('right, @bob.')
  })
  it('no author, no prefix', () => {
    expect(withReplyMention('hi', null, undefined, 'home.example')).toBe('hi')
  })
})

// =============================================================================
// C4: only a 401 is the TOKEN refused. It carries `credentialRefused`, which the
// worker and the notification poller turn into an invalidated presence; a 403
// is a token that is fine and may not do this (a disabled account, a scope),
// which reconnecting does not reliably fix, so it invalidates nothing.
// =============================================================================
const { isCredentialRefusal } = await import('@platform-pub/shared/lib/presence-health.js')
const { listMastodonNotifications } = await import('./activitypub-outbound.js')

describe('a refused credential is told apart from a refused request', () => {
  it.each([
    [401, true],
    [403, false],
    [422, false],
  ])('a %i on the status POST: credentialRefused = %s', async (status, refusal) => {
    route = () => refused(status)
    const err = await postMastodonStatus(
      { instanceUrl: HOME, text: 'hi', maxChars: 500, idempotencyKey: 'row-1' },
      { accessToken: 't', scope: FULL },
    ).catch((e) => e)
    expect(isTerminalDeliveryError(err)).toBe(true)
    expect(isCredentialRefusal(err)).toBe(refusal)
  })

  it('the notification read asks for mentions and quotes, and a 401 there is a refusal too', async () => {
    route = (url) => (url.includes('/api/v1/notifications') ? ok([]) : refused(500))
    await listMastodonNotifications(HOME, { accessToken: 't', scope: FULL }, '77')
    const u = new URL(calls[calls.length - 1].url)
    expect(u.pathname).toBe('/api/v1/notifications')
    expect(u.searchParams.getAll('types[]')).toEqual(['mention', 'quote'])
    expect(u.searchParams.get('min_id')).toBe('77')

    route = () => refused(401)
    const err = await listMastodonNotifications(HOME, { accessToken: 't', scope: FULL }, null).catch((e) => e)
    expect(isCredentialRefusal(err)).toBe(true)
  })
})
