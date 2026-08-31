import { describe, it, expect } from 'vitest'
import { attestorWeight, type AttestorSignals } from './trust-weighting.js'

describe('attestorWeight', () => {
  const mature: AttestorSignals = {
    accountAgeDays: 400,
    paymentVerified: true,
    payingReaderCount: 60,
    articleCount: 15,
  }

  it('returns 1.0 for a fully mature account', () => {
    expect(attestorWeight(mature)).toBe(1.0)
  })

  it('returns 1.0 at exactly the cap values', () => {
    expect(attestorWeight({
      accountAgeDays: 365,
      paymentVerified: true,
      payingReaderCount: 50,
      articleCount: 10,
    })).toBe(1.0)
  })

  it('returns 0 when account age is 0', () => {
    expect(attestorWeight({ ...mature, accountAgeDays: 0 })).toBe(0)
  })

  it('returns 0 when paying reader count is 0', () => {
    expect(attestorWeight({ ...mature, payingReaderCount: 0 })).toBe(0)
  })

  it('returns 0 when article count is 0', () => {
    expect(attestorWeight({ ...mature, articleCount: 0 })).toBe(0)
  })

  it('uses 0.3 for unverified payment (not 0)', () => {
    const w = attestorWeight({ ...mature, paymentVerified: false })
    expect(w).toBeCloseTo(0.3)
  })

  it('scales age linearly below cap', () => {
    // 182.5 days = 0.5 year → age sub-score = 0.5
    const w = attestorWeight({ ...mature, accountAgeDays: 182.5 })
    expect(w).toBeCloseTo(0.5)
  })

  it('scales readership linearly below cap', () => {
    // 25 readers → 0.5
    const w = attestorWeight({ ...mature, payingReaderCount: 25 })
    expect(w).toBeCloseTo(0.5)
  })

  it('scales activity linearly below cap', () => {
    // 5 articles → 0.5
    const w = attestorWeight({ ...mature, articleCount: 5 })
    expect(w).toBeCloseTo(0.5)
  })

  it('compounds multiple sub-cap values correctly', () => {
    // Half age × unverified × half readers × half articles
    // 0.5 × 0.3 × 0.5 × 0.5 = 0.0375
    const w = attestorWeight({
      accountAgeDays: 182.5,
      paymentVerified: false,
      payingReaderCount: 25,
      articleCount: 5,
    })
    expect(w).toBeCloseTo(0.0375)
  })

  it('returns ~0.008 for a 3-day-old empty account', () => {
    const w = attestorWeight({
      accountAgeDays: 3,
      paymentVerified: false,
      payingReaderCount: 0,
      articleCount: 0,
    })
    expect(w).toBe(0)
  })
})
