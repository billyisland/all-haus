import { describe, it, expect } from 'vitest'
import { validatePaywalledPublish } from '../src/lib/publish-validation'

const base = {
  isPaywalled: true,
  paywallContent: 'the gated body',
  pricePence: 50,
  publicationId: null as string | null,
}

describe('validatePaywalledPublish', () => {
  it('passes a well-formed paywalled publish', () => {
    expect(validatePaywalledPublish(base)).toBeNull()
  })

  it('ignores everything when not paywalled', () => {
    expect(
      validatePaywalledPublish({ ...base, isPaywalled: false, pricePence: 0, paywallContent: '' }),
    ).toBeNull()
  })

  it('rejects a paywall gate inside a publication (no vault pipeline)', () => {
    expect(validatePaywalledPublish({ ...base, publicationId: 'pub-1' })).toMatch(/publication/i)
  })

  it('rejects an empty paywalled section (gate at end of document)', () => {
    expect(validatePaywalledPublish({ ...base, paywallContent: '  \n ' })).toMatch(/no content after/i)
  })

  it('rejects price 0 — the suggestPrice(<700 words) default that broke publish', () => {
    expect(validatePaywalledPublish({ ...base, pricePence: 0 })).toMatch(/at least £0\.01/)
  })

  it('rejects NaN price (cleared price field)', () => {
    expect(validatePaywalledPublish({ ...base, pricePence: NaN })).toMatch(/at least £0\.01/)
  })

  it('rejects fractional pence', () => {
    expect(validatePaywalledPublish({ ...base, pricePence: 50.5 })).toMatch(/at least £0\.01/)
  })

  it('accepts the 1p minimum', () => {
    expect(validatePaywalledPublish({ ...base, pricePence: 1 })).toBeNull()
  })
})
