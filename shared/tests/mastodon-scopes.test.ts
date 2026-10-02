import { describe, it, expect } from 'vitest'
import {
  MASTODON_SCOPES,
  coversMastodonScopes,
  hasMastodonScope,
} from '../src/lib/mastodon-scopes.js'

describe('hasMastodonScope', () => {
  it('matches an exact scope', () => {
    expect(hasMastodonScope('read:accounts write:statuses', 'write:statuses')).toBe(true)
    expect(hasMastodonScope('read:accounts write:statuses', 'read:search')).toBe(false)
  })

  it('a bare parent covers its children, not the other family', () => {
    expect(hasMastodonScope('read', 'read:search')).toBe(true)
    expect(hasMastodonScope('read', 'write:statuses')).toBe(false)
    expect(hasMastodonScope('write', 'write:favourites')).toBe(true)
  })

  it('a child never covers a parent or a sibling', () => {
    expect(hasMastodonScope('read:search', 'read')).toBe(false)
    expect(hasMastodonScope('read:statuses', 'read:search')).toBe(false)
  })

  it('an absent grant covers nothing', () => {
    expect(hasMastodonScope(undefined, 'read:search')).toBe(false)
    expect(hasMastodonScope('', 'read:search')).toBe(false)
    expect(hasMastodonScope(null, 'read:search')).toBe(false)
  })
})

describe('coversMastodonScopes', () => {
  it('the pre-A3 grant does not cover what we ask for now', () => {
    expect(coversMastodonScopes('read:accounts write:statuses')).toBe(false)
  })

  it('what we ask for covers itself, in any order and spacing', () => {
    expect(coversMastodonScopes(MASTODON_SCOPES)).toBe(true)
    expect(coversMastodonScopes(MASTODON_SCOPES.split(' ').reverse().join('  '))).toBe(true)
    expect(coversMastodonScopes('read write')).toBe(true)
  })
})
