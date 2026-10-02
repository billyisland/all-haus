import { describe, it, expect } from 'vitest'
import { magicLinkUrl } from '../src/lib/email.js'

// The emailed sign-in link (MODERNHAUS-ADR §D1.8.1). `surface` picks the verify
// page from a closed set, and the arrival rides as an identifier — neither is
// ever a path the caller handed over.

describe('magicLinkUrl', () => {
  it('opens the full site by default', () => {
    expect(magicLinkUrl('https://all.haus', 't/k+n', null, null)).toBe(
      'https://all.haus/auth/verify?token=t%2Fk%2Bn',
    )
  })

  it("opens modernhaus's verify page for that surface", () => {
    expect(magicLinkUrl('https://all.haus', 'tok', null, 'modernhaus')).toBe(
      'https://all.haus/modernhaus/auth/verify?token=tok',
    )
  })

  it('carries the arrival on either surface, encoded', () => {
    expect(magicLinkUrl('https://all.haus', 'tok', 'a b&c', 'modernhaus')).toBe(
      'https://all.haus/modernhaus/auth/verify?token=tok&arrival=a%20b%26c',
    )
    expect(magicLinkUrl('https://all.haus', 'tok', 'd', null)).toBe('https://all.haus/auth/verify?token=tok&arrival=d')
  })
})
