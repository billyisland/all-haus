import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateDTag, slugify as webSlugify } from '../src/lib/publish'
import {
  generateDTag as sharedGenerateDTag,
  slugify as sharedSlugify,
} from '../../shared/src/lib/slug'

describe('generateDTag', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('produces a lowercase hyphenated slug with timestamp suffix', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'))

    const result = generateDTag('My Test Article')
    const ts = Math.floor(new Date('2025-06-15T12:00:00Z').getTime() / 1000).toString(36)
    expect(result).toBe(`my-test-article-${ts}`)
  })

  it('strips special characters', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const result = generateDTag("What's New? (Part 2)")
    expect(result).toMatch(/^whats-new-part-2-[a-z0-9]+$/)
  })

  it('collapses multiple spaces and hyphens', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const result = generateDTag('too   many   spaces')
    expect(result).toMatch(/^too-many-spaces-[a-z0-9]+$/)
  })

  it('truncates long titles before appending timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    const longTitle = 'a'.repeat(100)
    const result = generateDTag(longTitle)
    const parts = result.split('-')
    const slugPart = parts.slice(0, -1).join('-')
    expect(slugPart.length).toBeLessThanOrEqual(80)
  })

})

// =============================================================================
// The web mirror and `shared/src/lib/slug.ts` must agree, byte for byte.
//
// There are two implementations of one algorithm because Next cannot cleanly
// import from `shared/` under the current workspace setup, and `slug.ts`'s own
// header names THIS FILE as how the drift is caught. It was not.
//
// The case that claimed to do it — "produces identical output to gateway
// generateDTag" — imported nothing from shared. It compared the web function
// against the LITERAL `'test-article-title'`, which any plausible slugifier
// produces from "Test Article Title", so it agreed with the fixture rather than
// with the other implementation and would have passed against any drift the
// input could not distinguish. And the d-tag is not cosmetic: it is the article
// identity the whole system keys on — the NIP-23 `d` tag, the naddr coordinate,
// `/article/:dTag`, the `(writer_id, nostr_d_tag)` draft upsert — so a client
// and a server that slugify differently mint two identities for one piece.
//
// The corpus is chosen for the places two hand-copied regex chains DO diverge:
// the order of collapse and truncation, whether a class strips or keeps, and
// what happens at the edges. A title with no discriminating character in it
// proves nothing.
// =============================================================================
describe('web/shared slugify parity', () => {
  const TITLES = [
    'Test Article Title',
    'My Test Article',
    "What's New? (Part 2)",
    'too   many   spaces',
    '  leading and trailing  ',
    '---already---hyphenated---',
    'Ünïcodë áccents and 日本語',
    'emoji 🔑 in the middle',
    'MIXED Case WITH CAPS',
    'punctuation!@#$%^&*()_+=[]{}|;:",.<>/?',
    'digits 12345 and 0',
    'tabs\tand\nnewlines',
    'a-b_c.d/e',
    // Truncation: 80 characters of slug and then some, with the boundary
    // landing on a hyphen — the case where "slice then collapse" and "collapse
    // then slice" part company.
    'w '.repeat(60),
    'x'.repeat(79) + ' ' + 'y'.repeat(20),
    'z'.repeat(200),
    '',
    '   ',
    '???',
    '-',
  ]

  it.each(TITLES)('agrees on %j', (title) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-03-01T00:00:00Z'))
    expect(generateDTag(title)).toBe(sharedGenerateDTag(title))
  })

  it('agrees on the slug alone, at the default and at a shorter cap', () => {
    // `generateDTag` appends a timestamp, which is the same on both sides by
    // construction — so a d-tag comparison could pass on two slugifiers that
    // differ only past the 80-character cap. Compare the slugs directly too.
    for (const title of TITLES) {
      expect(webSlugify(title, 80)).toBe(sharedSlugify(title, 80))
      expect(webSlugify(title, 12)).toBe(sharedSlugify(title, 12))
    }
  })
})
