import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// =============================================================================
// The networked half of `shared/src/lib/mastodon-api.ts`: the raw readers, the
// identity check both account mappings share, and the pin that keeps the file
// the ONE home for a public Mastodon client-API read (§0ab quality tail (i) —
// thirteen hand-rolled reads had grown up beside it, each with its own Accept
// header, timeout and JSON.parse).
// =============================================================================

interface Call {
  url: string
  headers: Record<string, string>
  timeout?: number
}
const calls: Call[] = []
let answer: { ok: boolean; status: number; text: string; link?: string } = {
  ok: true,
  status: 200,
  text: '{}',
}

vi.mock('../src/lib/http-client.js', () => ({
  safeFetch: vi.fn(
    async (url: string, opts: { headers?: Record<string, string>; timeout?: number } = {}) => {
      calls.push({ url, headers: opts.headers ?? {}, timeout: opts.timeout })
      const headers = new Headers()
      if (answer.link) headers.set('link', answer.link)
      return { ...answer, headers, url }
    },
  ),
}))

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const api = await import('../src/lib/mastodon-api.js')

beforeEach(() => {
  calls.length = 0
  answer = { ok: true, status: 200, text: '{}' }
})

const O = 'https://m.example'

describe('the raw readers', () => {
  it('address each endpoint, encoded, with JSON accept and the 10s default', async () => {
    await api.readMastodonStatus(O, '123')
    await api.readMastodonStatusContext(O, '123')
    await api.readMastodonAccount(O, { kind: 'acct', acct: 'al ice@x.example' })
    await api.readMastodonAccount(O, { kind: 'id', id: '99' })
    await api.readMastodonFollowing(O, '99')
    await api.readMastodonAccountSearch(O, 'a&b', 5)
    expect(calls.map((c) => c.url)).toEqual([
      `${O}/api/v1/statuses/123`,
      `${O}/api/v1/statuses/123/context`,
      `${O}/api/v1/accounts/lookup?acct=al%20ice%40x.example`,
      `${O}/api/v1/accounts/99`,
      `${O}/api/v1/accounts/99/following?limit=80`,
      `${O}/api/v2/search?q=a%26b&type=accounts&limit=5`,
    ])
    for (const c of calls) {
      expect(c.headers).toEqual({ Accept: 'application/json' })
      expect(c.timeout).toBe(10_000)
    }
  })

  it('builds the statuses query from what was asked, clamping the limit', async () => {
    await api.readMastodonAccountStatuses(O, '7', {
      limit: 30,
      excludeReplies: true,
      excludeReblogs: true,
    })
    await api.readMastodonAccountStatuses(O, '7', { limit: 500, maxId: '41' })
    expect(calls.map((c) => c.url)).toEqual([
      `${O}/api/v1/accounts/7/statuses?limit=30&exclude_replies=true&exclude_reblogs=true`,
      `${O}/api/v1/accounts/7/statuses?limit=40&max_id=41`,
    ])
  })

  it('carries a token and a caller timeout when given them', async () => {
    await api.readMastodonStatus(O, '1', { accessToken: 'tok', timeout: 3000 })
    expect(calls[0].headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer tok',
    })
    expect(calls[0].timeout).toBe(3000)
  })

  it('hands back the WIRE status on a refusal, so the caller keeps its own 429/5xx split', async () => {
    answer = { ok: false, status: 503, text: 'busy' }
    expect(await api.readMastodonStatus(O, '1')).toEqual({
      ok: false,
      status: 503,
      body: null,
      link: null,
    })
  })

  it('is not ok on a 200 that is not JSON', async () => {
    answer = { ok: true, status: 200, text: '<html>' }
    const r = await api.readMastodonStatus(O, '1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(200)
  })

  it('carries the Link header for the following pager', async () => {
    answer = { ok: true, status: 200, text: '[]', link: `<${O}/next>; rel="next"` }
    const r = await api.readMastodonFollowing(O, '1')
    expect(r).toEqual({ ok: true, status: 200, body: [], link: `<${O}/next>; rel="next"` })
  })
})

describe('extractMastodonStatusId', () => {
  it('reads the id off both status spellings', () => {
    expect(api.extractMastodonStatusId(`${O}/users/alice/statuses/123`)).toBe('123')
    expect(api.extractMastodonStatusId(`${O}/@alice/456`)).toBe('456')
  })

  it('is null for anything that does not END in a numeric id', () => {
    expect(api.extractMastodonStatusId(`${O}/@alice`)).toBeNull()
    expect(api.extractMastodonStatusId(`${O}/notes/9abc`)).toBeNull()
    expect(api.extractMastodonStatusId('not a url')).toBeNull()
  })
})

describe('mastodonAccountIdentity — §2.9 on the client-API door', () => {
  const account = (uri: string | null) =>
    api.parseMastodonAccount({ id: '1', acct: 'alice', uri })!

  it('takes the account uri when the host that served it may claim it', () => {
    expect(api.mastodonAccountIdentity(account(`${O}/users/alice`), `${O}/@alice`)).toEqual({
      id: `${O}/users/alice`,
      host: 'm.example',
    })
  })

  it('REFUSES a uri on another host rather than falling back to the one asked for', () => {
    expect(
      api.mastodonAccountIdentity(account('https://victim.example/users/bob'), `${O}/@alice`),
    ).toBeNull()
  })

  it('keeps the uri we asked for when the instance serves none', () => {
    expect(api.mastodonAccountIdentity(account(null), `${O}/@alice`)).toEqual({
      id: `${O}/@alice`,
      host: 'm.example',
    })
  })
})

// -----------------------------------------------------------------------------
// The pin. A public client-API read written outside the home is a second
// answer to "which endpoint, which headers, which timeout" and drifts in
// silence. Authenticated writes on a member's own instance are the named
// exception (the home's header says why).
// -----------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const ENDPOINT = /\/api\/v(?:1\/(?:statuses|accounts)|2\/search)\b/
const EXEMPT = new Set([
  'feed-ingest/src/adapters/activitypub-outbound.ts',
  'gateway/src/routes/linked-accounts.ts',
])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...sourceFiles(rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

/** Lines that NAME a client-API endpoint in code, comments dropped. */
function endpointLines(rel: string): string[] {
  return fs
    .readFileSync(path.join(root, rel), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && ENDPOINT.test(l))
}

describe('the home is the ONE place a public Mastodon read is spelled', () => {
  it('the detector sees the home itself (proved before its silence is trusted)', () => {
    expect(endpointLines('shared/src/lib/mastodon-api.ts').length).toBeGreaterThanOrEqual(6)
  })

  it('no gateway or feed-ingest source spells one', () => {
    const offenders = [...sourceFiles('gateway/src'), ...sourceFiles('feed-ingest/src')]
      .filter((f) => !EXEMPT.has(f))
      .flatMap((f) => endpointLines(f).map((l) => `${f}: ${l.trim()}`))
    expect(offenders).toEqual([])
  })
})
