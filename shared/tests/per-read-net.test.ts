import { describe, it, expect } from 'vitest'
import { perReadNetPence, readNetSql } from '../src/lib/per-read-net.js'

// =============================================================================
// per-read-net — the single definition shared by the money paths (settlement
// apportionment, author carve, inspirer payout) and the display paths. If the
// JS twin and the SQL fragment ever disagree, conservation breaks, so both are
// pinned here.
// =============================================================================

describe('perReadNetPence', () => {
  const feeBps = 800 // 8%

  it('nets amount minus floor(amount * bps / 10000)', () => {
    expect(perReadNetPence(1000, feeBps)).toBe(920) // 1000 - floor(80) = 920
  })

  it('floors the fee per row (writer keeps the dust)', () => {
    // 1p read at 8% → floor(0.08) = 0 fee → writer keeps the whole penny.
    expect(perReadNetPence(1, feeBps)).toBe(1)
    // 12p read → floor(0.96) = 0 fee → writer keeps 12p.
    expect(perReadNetPence(12, feeBps)).toBe(12)
    // 13p read → floor(1.04) = 1 fee → 12p net.
    expect(perReadNetPence(13, feeBps)).toBe(12)
  })

  it('is non-negative and never exceeds the gross', () => {
    for (const amt of [0, 1, 5, 50, 500, 1234]) {
      const net = perReadNetPence(amt, feeBps)
      expect(net).toBeGreaterThanOrEqual(0)
      expect(net).toBeLessThanOrEqual(amt)
    }
  })

  it('zero fee bps returns the gross unchanged', () => {
    expect(perReadNetPence(500, 0)).toBe(500)
  })
})

describe('readNetSql', () => {
  it('builds the matching SQL fragment from a column ref and a bound param', () => {
    expect(readNetSql('r.amount_pence', '$2')).toBe(
      '(r.amount_pence - FLOOR(r.amount_pence * $2 / 10000))',
    )
  })

  it('the SQL form is algebraically the JS form (FLOOR == Math.floor on integers)', () => {
    // Mirror the SQL arithmetic in JS to prove they compute the same integer.
    const sqlEval = (amt: number, bps: number) => amt - Math.floor((amt * bps) / 10000)
    for (const amt of [1, 13, 99, 500, 1234]) {
      expect(sqlEval(amt, 800)).toBe(perReadNetPence(amt, 800))
    }
  })
})
