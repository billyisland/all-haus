import { describe, it, expect } from 'vitest'
import { diffAgainstDefaults } from '@platform-pub/shared/db/config-defaults-parse.js'

// =============================================================================
// Owner dashboard — regulatory dial parity + UK financial year arithmetic.
//
// The parity half is the §0h.7 pattern (see config-fallback-parity.test.ts):
// REGULATORY_DIAL_DEFAULTS is a second copy of numbers whose canonical home is
// shared/src/db/config-defaults.sql, and nothing else holds the two in step.
// =============================================================================

// The route module reads these at import time.
process.env.PAYMENT_SERVICE_URL ??= 'http://payment-service.test'
process.env.INTERNAL_SERVICE_TOKEN ??= 'test-token'

const { REGULATORY_DIAL_DEFAULTS, ukFinancialYear } = await import(
  '../src/routes/admin-dashboard.js'
)

describe('regulatory dial fallbacks vs config-defaults.sql', () => {
  it('every fallback matches the seeded default', () => {
    expect(diffAgainstDefaults({ ...REGULATORY_DIAL_DEFAULTS })).toEqual([])
  })
})

describe('ukFinancialYear', () => {
  it('a date after 6 April sits in the year starting that April', () => {
    const fy = ukFinancialYear(new Date('2026-07-22T12:00:00Z'))
    expect(fy.start).toBe('2026-04-06')
    expect(fy.end).toBe('2027-04-05')
  })

  it('a date before 6 April sits in the prior year', () => {
    const fy = ukFinancialYear(new Date('2026-02-01T12:00:00Z'))
    expect(fy.start).toBe('2025-04-06')
    expect(fy.end).toBe('2026-04-05')
  })

  it('6 April itself starts the new year', () => {
    const fy = ukFinancialYear(new Date('2026-04-06T00:00:00Z'))
    expect(fy.start).toBe('2026-04-06')
    expect(fy.end).toBe('2027-04-05')
  })

  it('daysRemaining is non-negative and bounded by a year', () => {
    const fy = ukFinancialYear(new Date('2026-04-06T00:00:00Z'))
    expect(fy.daysRemaining).toBeGreaterThan(360)
    expect(fy.daysRemaining).toBeLessThanOrEqual(366)
    const fyEnd = ukFinancialYear(new Date('2026-04-04T12:00:00Z'))
    expect(fyEnd.daysRemaining).toBeLessThanOrEqual(1)
  })
})
