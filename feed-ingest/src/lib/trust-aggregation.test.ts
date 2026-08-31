import { describe, it, expect } from 'vitest'
import {
  freshnessMultiplier,
  decayRateMultiplier,
  effectiveFreshness,
  computeDimensionScore,
  applyDecay,
  type VouchForScoring,
} from './trust-aggregation.js'

describe('freshnessMultiplier', () => {
  it('returns 1.0 for current epoch (0)', () => {
    expect(freshnessMultiplier(0)).toBe(1.0)
  })

  it('returns 0.85 after 1 epoch', () => {
    expect(freshnessMultiplier(1)).toBe(0.85)
  })

  it('returns 0.70 after 2 epochs', () => {
    expect(freshnessMultiplier(2)).toBe(0.70)
  })

  it('returns 0.50 after 3 epochs', () => {
    expect(freshnessMultiplier(3)).toBe(0.50)
  })

  it('returns 0.30 after 4 epochs', () => {
    expect(freshnessMultiplier(4)).toBe(0.30)
  })

  it('returns 0.15 after 5 epochs', () => {
    expect(freshnessMultiplier(5)).toBe(0.15)
  })

  it('returns 0.0 after 6 epochs (expired)', () => {
    expect(freshnessMultiplier(6)).toBe(0.0)
  })

  it('returns 0.0 for any value >= 6', () => {
    expect(freshnessMultiplier(10)).toBe(0.0)
    expect(freshnessMultiplier(100)).toBe(0.0)
  })

  it('returns 1.0 for negative values (defensive)', () => {
    expect(freshnessMultiplier(-1)).toBe(1.0)
  })
})

describe('decayRateMultiplier', () => {
  it('returns 0.0 for 1–3 attestations (fully paused)', () => {
    expect(decayRateMultiplier(1)).toBe(0.0)
    expect(decayRateMultiplier(2)).toBe(0.0)
    expect(decayRateMultiplier(3)).toBe(0.0)
  })

  it('returns 0.25 for 4–6 attestations (quarter speed)', () => {
    expect(decayRateMultiplier(4)).toBe(0.25)
    expect(decayRateMultiplier(5)).toBe(0.25)
    expect(decayRateMultiplier(6)).toBe(0.25)
  })

  it('returns 0.5 for 7–9 attestations (half speed)', () => {
    expect(decayRateMultiplier(7)).toBe(0.5)
    expect(decayRateMultiplier(8)).toBe(0.5)
    expect(decayRateMultiplier(9)).toBe(0.5)
  })

  it('returns 1.0 for 10+ attestations (full decay)', () => {
    expect(decayRateMultiplier(10)).toBe(1.0)
    expect(decayRateMultiplier(50)).toBe(1.0)
  })

  it('returns 0.0 for 0 attestations', () => {
    expect(decayRateMultiplier(0)).toBe(0.0)
  })
})

describe('effectiveFreshness', () => {
  it('returns 1.0 for current epoch regardless of count', () => {
    expect(effectiveFreshness(0, 1)).toBe(1.0)
    expect(effectiveFreshness(0, 50)).toBe(1.0)
  })

  it('pauses decay for 1–3 attestations', () => {
    // 3 epochs, 2 attestations: raw = 0.50, rate = 0.0
    // effective = 1.0 - (1.0 - 0.50) × 0.0 = 1.0
    expect(effectiveFreshness(3, 2)).toBe(1.0)
  })

  it('applies quarter-speed decay for 5 attestations', () => {
    // 1 epoch, 5 attestations: raw = 0.85, rate = 0.25
    // effective = 1.0 - (1.0 - 0.85) × 0.25 = 1.0 - 0.0375 = 0.9625
    expect(effectiveFreshness(1, 5)).toBeCloseTo(0.9625)
  })

  it('applies half-speed decay for 8 attestations', () => {
    // 1 epoch, 8 attestations: raw = 0.85, rate = 0.5
    // effective = 1.0 - (1.0 - 0.85) × 0.5 = 1.0 - 0.075 = 0.925
    expect(effectiveFreshness(1, 8)).toBeCloseTo(0.925)
  })

  it('applies full decay for 10+ attestations', () => {
    // 1 epoch, 15 attestations: raw = 0.85, rate = 1.0
    // effective = 1.0 - (1.0 - 0.85) × 1.0 = 0.85
    expect(effectiveFreshness(1, 15)).toBe(0.85)
  })

  it('returns 0 for expired vouch at full decay', () => {
    // 6 epochs, 10+ attestations
    expect(effectiveFreshness(6, 15)).toBe(0.0)
  })
})

describe('applyDecay', () => {
  it('increments epoch counter by 1', () => {
    expect(applyDecay(0)).toBe(1)
    expect(applyDecay(3)).toBe(4)
    expect(applyDecay(5)).toBe(6)
  })
})

describe('computeDimensionScore', () => {
  it('returns 0 for empty vouches', () => {
    expect(computeDimensionScore([], 0)).toBe(0)
  })

  it('returns 1.0 for a single full-weight affirm', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
    ]
    // raw = 1.0 / 1.0 = 1.0 → (1.0 + 1) / 2 = 1.0
    expect(computeDimensionScore(vouches, 1)).toBe(1.0)
  })

  it('returns 0 for a single full-weight contest', () => {
    const vouches: VouchForScoring[] = [
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
    ]
    // raw = -1.0 / 1.0 = -1.0 → (-1.0 + 1) / 2 = 0.0
    expect(computeDimensionScore(vouches, 1)).toBe(0)
  })

  it('returns 0.5 when affirms and contests balance', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
    ]
    expect(computeDimensionScore(vouches, 2)).toBe(0.5)
  })

  it('weights heavier attestors more', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'contest', attestorWeight: 0.1, epochsSinceReaffirm: 0 },
    ]
    // weighted_sum = 1.0 - 0.1 = 0.9, weight_total = 1.1
    // raw = 0.9 / 1.1 ≈ 0.818, score = (0.818 + 1) / 2 ≈ 0.909
    const score = computeDimensionScore(vouches, 2)
    expect(score).toBeGreaterThan(0.8)
    expect(score).toBeLessThan(1.0)
  })

  it('ignores zero-weight attestors', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'contest', attestorWeight: 0.0, epochsSinceReaffirm: 0 },
    ]
    expect(computeDimensionScore(vouches, 2)).toBe(1.0)
  })

  it('applies freshness decay to older vouches', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },  // fresh
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 4 }, // stale (0.30)
    ]
    // At 15 attestations total (full decay rate):
    // affirm: w = 1.0 × 1.0 = 1.0, contest: w = 1.0 × 0.30 = 0.30
    // weighted_sum = 1.0 - 0.30 = 0.70, weight_total = 1.30
    // raw = 0.70 / 1.30 ≈ 0.538, score = (0.538 + 1) / 2 ≈ 0.769
    const score = computeDimensionScore(vouches, 15)
    expect(score).toBeCloseTo(0.769, 2)
  })

  it('returns 0 when all vouches have expired', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 6 },
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 7 },
    ]
    // At 15 attestations (full decay): all freshness = 0 → weight = 0
    expect(computeDimensionScore(vouches, 15)).toBe(0)
  })

  it('score is always in [0, 1]', () => {
    // All contests
    const allContests: VouchForScoring[] = [
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'contest', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
    ]
    const s1 = computeDimensionScore(allContests, 15)
    expect(s1).toBeGreaterThanOrEqual(0)
    expect(s1).toBeLessThanOrEqual(1)
    expect(s1).toBe(0)

    // All affirms
    const allAffirms: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
    ]
    const s2 = computeDimensionScore(allAffirms, 15)
    expect(s2).toBeGreaterThanOrEqual(0)
    expect(s2).toBeLessThanOrEqual(1)
    expect(s2).toBe(1)
  })

  it('handles three affirms with varying weights', () => {
    const vouches: VouchForScoring[] = [
      { value: 'affirm', attestorWeight: 1.0, epochsSinceReaffirm: 0 },
      { value: 'affirm', attestorWeight: 0.5, epochsSinceReaffirm: 0 },
      { value: 'affirm', attestorWeight: 0.2, epochsSinceReaffirm: 0 },
    ]
    // All affirms → raw = 1.0, score = 1.0
    expect(computeDimensionScore(vouches, 3)).toBe(1.0)
  })
})
