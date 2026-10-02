import { describe, it, expect } from 'vitest'
import {
  isSignedFetchRefusal,
  mastodonRefFromActorUri,
  parseMastodonAccount,
  parseMastodonStatus,
  qualifyAcct,
} from '../src/lib/mastodon-api.js'

// =============================================================================
// The pure half of the Mastodon client-API reader: how an actor URI is
// ADDRESSED, and what the two entities parse to. The networked half is driven
// against a mocked safeFetch in the gateway and feed-ingest suites, where the
// callers that matter live.
// =============================================================================

describe('mastodonRefFromActorUri', () => {
  it('reads both Mastodon actor spellings', () => {
    expect(mastodonRefFromActorUri('https://m.example/users/alice')).toEqual({
      kind: 'acct',
      acct: 'alice@m.example',
    })
    expect(mastodonRefFromActorUri('https://m.example/@alice')).toEqual({
      kind: 'acct',
      acct: 'alice@m.example',
    })
  })

  it('reads the threadiverse spellings', () => {
    // Lemmy/PieFed communities and users, Mbin magazines.
    for (const path of ['/c/news', '/u/news', '/m/news'])
      expect(mastodonRefFromActorUri(`https://l.example${path}`)).toEqual({
        kind: 'acct',
        acct: 'news@l.example',
      })
  })

  it('addresses an id-shaped actor URI by ID, not by a username it has not got', () => {
    // `/ap/users/<id>` is Mastodon's newer actor URI and carries no username.
    // Two such rows are already in `external_sources`; the old handle-only
    // extractor returned null for them, so those authors never hydrated.
    expect(
      mastodonRefFromActorUri('https://mastodon.social/ap/users/116713870499595477')
    ).toEqual({ kind: 'id', id: '116713870499595477' })
  })

  it('does not let the id shape fall through to the /users/ pattern', () => {
    // The order matters: `/ap/users/123` also contains `/users/123`, and
    // looking the digits up as a USERNAME is a lookup that quietly 404s.
    const ref = mastodonRefFromActorUri('https://m.example/ap/users/99')
    expect(ref?.kind).toBe('id')
  })

  it('returns null for a path that names no actor', () => {
    expect(mastodonRefFromActorUri('https://m.example/about')).toBeNull()
    expect(mastodonRefFromActorUri('https://m.example/@alice/1234')).toBeNull()
    expect(mastodonRefFromActorUri('not a url')).toBeNull()
  })
})

describe('qualifyAcct', () => {
  it('qualifies a bare local acct and leaves a remote one alone', () => {
    // A bare `alice` on two instances is two people; the byline and the
    // follow-graph entry both need the domain.
    expect(qualifyAcct('alice', 'm.example')).toBe('alice@m.example')
    expect(qualifyAcct('bob@other.example', 'm.example')).toBe('bob@other.example')
  })
})

describe('isSignedFetchRefusal', () => {
  it('is 401 and 403 only', () => {
    expect(isSignedFetchRefusal(401)).toBe(true)
    expect(isSignedFetchRefusal(403)).toBe(true)
    // A 404 is a fact about the account and a 5xx about the moment — neither
    // is answered by asking a different endpoint on the same host.
    for (const s of [200, 404, 410, 429, 500, 503])
      expect(isSignedFetchRefusal(s)).toBe(false)
  })
})

describe('parseMastodonAccount', () => {
  it('leaves a non-https uri NULL rather than storing it as an identity', () => {
    expect(parseMastodonAccount({ id: '1', acct: 'a', uri: 'ftp://x/y' })?.uri).toBeNull()
    expect(parseMastodonAccount({ id: '1', acct: 'a', uri: '/users/a' })?.uri).toBeNull()
  })

  it('refuses an entity with no id or acct', () => {
    expect(parseMastodonAccount({ acct: 'a' })).toBeNull()
    expect(parseMastodonAccount({ id: '1' })).toBeNull()
    expect(parseMastodonAccount(null)).toBeNull()
  })
})

describe('parseMastodonStatus', () => {
  const base = {
    id: '1',
    uri: 'https://m.example/users/a/statuses/1',
    created_at: '2026-09-01T10:00:00.000Z',
    content: '<p>hi</p>',
  }

  it('refuses a status with no uri — there is no id-space to file it under', () => {
    // `url` is the permalink, never the identity: filing a status under it
    // would mint a second post_id for something already ingested.
    const { uri, ...noUri } = base
    expect(parseMastodonStatus({ ...noUri, url: 'https://m.example/@a/1' })).toBeNull()
  })

  it('refuses an unparseable created_at rather than dating it now', () => {
    expect(parseMastodonStatus({ ...base, created_at: 'soon' })).toBeNull()
  })

  it('carries the reply parent as a LOCAL id, which is not a uri', () => {
    const s = parseMastodonStatus({ ...base, in_reply_to_id: '900' })
    expect(s?.inReplyToId).toBe('900')
  })

  it('reads a 4.4-shaped quote down to the quoted status uri', () => {
    const s = parseMastodonStatus({
      ...base,
      quote: { state: 'accepted', quoted_status: { uri: 'https://o.example/s/7' } },
    })
    expect(s?.quoteUri).toBe('https://o.example/s/7')
  })

  it('treats a pending quote with no status as no quote', () => {
    expect(parseMastodonStatus({ ...base, quote: { state: 'pending' } })?.quoteUri).toBeNull()
  })

  it('parses a boost down to the boosted status', () => {
    const s = parseMastodonStatus({
      ...base,
      reblog: { ...base, id: '2', uri: 'https://o.example/s/2' },
    })
    expect(s?.reblog?.uri).toBe('https://o.example/s/2')
  })

  it('drops an attachment with no url rather than emitting a broken one', () => {
    const s = parseMastodonStatus({
      ...base,
      media_attachments: [{ type: 'image' }, { type: 'image', url: 'https://m/1.png' }],
    })
    expect(s?.media.map((m) => m.url)).toEqual(['https://m/1.png'])
  })
})
