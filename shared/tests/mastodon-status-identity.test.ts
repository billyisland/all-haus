import { describe, it, expect, vi } from 'vitest'

// =============================================================================
// A Mastodon STATUS may claim only ids on the origin that served it (CA-A10,
// 2026-09-29; §2.9 on the client-API door).
//
// `mastodonAccountIdentity` applied the rule to accounts; five context
// writers stored a status's `uri` and its author's `uri` on the instance's
// word. This is the one home both services now ask, and the cases are the
// hostile answers it must refuse: a victim's status id on a stranger's host,
// a victim's actor beneath an honest status, a status with no federated id
// (never keyed on the web url instead), an author with none. The honest
// answer is the control.
// =============================================================================

const warn = vi.fn()
vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../src/lib/http-client.js', () => ({ safeFetch: vi.fn() }))

const { mastodonStatusIdentity } = await import('../src/lib/mastodon-api.js')

const ORIGIN = 'https://good.social'
const honest = {
  uri: 'https://good.social/users/alice/statuses/1',
  url: 'https://good.social/@alice/1',
  account: { uri: 'https://good.social/users/alice', url: 'https://good.social/@alice' },
}

describe('mastodonStatusIdentity', () => {
  it('accepts a status and an author on the origin that answered', () => {
    expect(mastodonStatusIdentity(honest, ORIGIN)).toEqual({
      uri: honest.uri,
      authorUri: honest.account.uri,
    })
  })

  it("refuses a status id on another host — the victim's dedup key is not squatted", () => {
    const hostile = { ...honest, uri: 'https://mastodon.social/users/victim/statuses/9' }
    expect(mastodonStatusIdentity(hostile, ORIGIN)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it("refuses an author on another host beneath an honest status — the victim's row is not overwritten", () => {
    const hostile = { ...honest, account: { uri: 'https://mastodon.social/users/victim', url: null } }
    expect(mastodonStatusIdentity(hostile, ORIGIN)).toBeNull()
  })

  it('refuses a status with no federated id rather than keying on its web url', () => {
    const { uri: _drop, ...noUri } = honest
    expect(mastodonStatusIdentity(noUri, ORIGIN)).toBeNull()
  })

  it('refuses an author with no actor id rather than falling back to the web url', () => {
    const noActor = { ...honest, account: { url: 'https://good.social/@alice' } }
    expect(mastodonStatusIdentity(noActor, ORIGIN)).toBeNull()
    expect(mastodonStatusIdentity({ ...honest, account: null }, ORIGIN)).toBeNull()
  })

  it('compares ORIGINS, so a scheme or port difference is a different host', () => {
    expect(mastodonStatusIdentity(honest, 'http://good.social')).toBeNull()
    expect(mastodonStatusIdentity(honest, 'https://good.social:8443')).toBeNull()
  })
})
