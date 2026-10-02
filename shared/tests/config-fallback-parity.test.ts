import { describe, it, expect, afterEach, vi } from 'vitest'

const warn = vi.fn()
vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: (...a: any[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}))
import fs from 'node:fs'
import { diffAgainstDefaults } from '../src/db/config-defaults-parse.js'
import { pool, loadConfig } from '../src/db/client.js'
import { isIntegerDialKey } from '../src/db/dial-kinds.js'

// =============================================================================
// §0o.9c — loadConfig's MONEY-dial fallbacks must match config-defaults.sql.
//
// Third of the parity trio (gateway feed-rank, feed-ingest resonance, this),
// and the one whose file the docblock is a monument to: from f8c73e6 until
// 2026-07-20 these dials existed ONLY as the fallbacks below, because a
// --schema-only regeneration silently dropped the INSERT that seeded them. An
// UPDATE on a missing row changes nothing and raises nothing, so the platform
// fee, the free allowance and both settlement thresholds were untunable and
// nothing said so.
//
// That is why the fallback's own correctness matters here more than in the
// twins. A drifted fallback is invisible exactly when the row is absent —
// which is the one case the fallback exists for — and these are the money
// dials: the platform's cut, what a reader is gifted, when a card is charged,
// when a writer is paid. Drift here does not error; it moves money by a
// number no operator can see.
//
// Drives the REAL loader against an empty table, so it asserts the shipping
// fallback path rather than a copy of it. Ordinary suite, no DB needed: the
// pool is stubbed at the one call loadConfig makes.
// =============================================================================

type Row = { key: string; value: string }
type Stub = { query: (...args: unknown[]) => Promise<{ rows: Row[] }> }

const stub = pool as unknown as Stub
const realQuery = stub.query

/** Answer loadConfig's one SELECT with the given platform_config rows. */
function seedConfigTable(rows: Row[]): void {
  stub.query = async () => ({ rows })
}

afterEach(() => {
  stub.query = realQuery
})

// The dials loadConfig reads, keyed as they are in the table. The completeness
// pin below fails if the loader grows a tenth and this map does not.
const FALLBACK_KEYS = [
  'free_allowance_pence',
  'arrival_gift_cap_pence',
  'tab_settlement_threshold_pence',
  'tab_ceiling_pence',
  'monthly_fallback_minimum_pence',
  'writer_payout_threshold_pence',
  'publication_payout_threshold_pence',
  'platform_fee_bps',
  'monthly_fallback_days',
  'payout_max_slices',
  'allocated_residual_alert_bps',
  'allocation_sync_freshness_hours',
  'payout_halt_escalation_hours',
  'unpayable_withdrawal_days',
  'unpayable_notice_days',
] as const

describe('loadConfig fallbacks vs config-defaults.sql', () => {
  it('every fallback matches the seeded default', async () => {
    // Empty table → every field takes its in-code fallback.
    seedConfigTable([])
    const c = await loadConfig(true)

    const bad = diffAgainstDefaults({
      free_allowance_pence: c.freeAllowancePence,
      arrival_gift_cap_pence: c.arrivalGiftCapPence,
      tab_settlement_threshold_pence: c.tabSettlementThresholdPence,
      tab_ceiling_pence: c.tabCeilingPence,
      monthly_fallback_minimum_pence: c.monthlyFallbackMinimumPence,
      writer_payout_threshold_pence: c.writerPayoutThresholdPence,
      publication_payout_threshold_pence: c.publicationPayoutThresholdPence,
      platform_fee_bps: c.platformFeeBps,
      monthly_fallback_days: c.monthlyFallbackDays,
      payout_max_slices: c.payoutMaxSlices,
      allocated_residual_alert_bps: c.allocatedResidualAlertBps,
      allocation_sync_freshness_hours: c.allocationSyncFreshnessHours,
      payout_halt_escalation_hours: c.payoutHaltEscalationHours,
      unpayable_withdrawal_days: c.unpayableWithdrawalDays,
      unpayable_notice_days: c.unpayableNoticeDays,
    })
    expect(bad).toEqual([])
  })

  it('a seeded value wins over the fallback', async () => {
    // The other direction: a fallback that shadowed a present row would pass
    // the parity test above while leaving operators no control at all — which
    // is the failure the dial exists to prevent, not a variant of it.
    seedConfigTable([{ key: 'platform_fee_bps', value: '650' }])
    const c = await loadConfig(true)
    expect(c.platformFeeBps).toBe(650)
  })

  it('a non-numeric row falls back rather than throwing — AND SAYS SO', async () => {
    // A garbage value reverts to the fallback, because a money path must not
    // die on a bad string. What it must not be is SILENT: absent and malformed
    // are different facts, and only the first is what the fallback is for. A
    // missing row self-heals on the next migrate; a row that is there and does
    // not parse is an operator typo — `1,000`, `50%`, a pasted newline — and
    // substituting the default without a word means their edit reports success,
    // changes nothing, and is indistinguishable from a dial with no reader,
    // which this repo has actually shipped (`free_allowance_pence`).
    //
    // This case previously pinned the silence, which is why it is worth saying
    // that a test can hold a defect in place as firmly as it holds a fix.
    seedConfigTable([{ key: 'platform_fee_bps', value: 'eight percent' }])
    const c = await loadConfig(true)
    expect(c.platformFeeBps).toBe(800)

    const warned = warn.mock.calls.find((call) => call[0]?.key === 'platform_fee_bps')
    expect(warned, 'a malformed dial must be reported, not silently replaced').toBeTruthy()
    expect(warned![0]).toMatchObject({ value: 'eight percent', fallback: 800 })
  })

  it('warns once per key, not once per load', async () => {
    // loadConfig runs on a cache miss and every money path calls it, so a line
    // per read would bury the log rather than inform it.
    warn.mockClear()
    seedConfigTable([{ key: 'payout_max_slices', value: 'lots' }])
    await loadConfig(true)
    await loadConfig(true)
    expect(warn.mock.calls.filter((c) => c[0]?.key === 'payout_max_slices')).toHaveLength(1)
  })

  it('says nothing for an ABSENT row — the case the fallback is actually for', async () => {
    warn.mockClear()
    seedConfigTable([])
    await loadConfig(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('covers every dial loadConfig reads', async () => {
    // Completeness: the parity map is hand-written, so a dial added to the
    // loader without a line here would ship unchecked — the exact gap this
    // test was split out of §0o.9 to close.
    const src = fs.readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8')
    const read = [...src.matchAll(/\bint\(map,\s*'([a-z0-9_]+)'/g)].map((m) => m[1])
    expect(read.sort()).toEqual([...FALLBACK_KEYS].sort())
  })

  it('a value parseInt would READ A PREFIX of falls back and warns — never applied as a different number (CA-F2)', async () => {
    // parseInt("20.00") is 20 and parseInt("1,000") is 1: the old NaN test let
    // both through as a DIFFERENT number, so a threshold typed in pounds became
    // 20p and the comment above that named `1,000` as caught was false.
    for (const value of ['20.00', '1,000', '8.50', '800 ']) {
      warn.mockClear()
      seedConfigTable([{ key: 'writer_payout_threshold_pence', value }])
      const c = await loadConfig(true)
      if (value === '800 ') {
        // Surrounding whitespace is not a different number — trimmed, applied.
        expect(c.writerPayoutThresholdPence).toBe(800)
        continue
      }
      expect(c.writerPayoutThresholdPence, `"${value}" must fall back`).toBe(2000)
    }
  })

  it('every dial loadConfig reads as an integer is an integer dial to the editor', () => {
    const src = fs.readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8')
    const read = [...src.matchAll(/\bint\(map,\s*'([a-z0-9_]+)'/g)].map((m) => m[1])
    expect(read.length).toBeGreaterThanOrEqual(15)
    expect(read.filter((k) => !isIntegerDialKey(k))).toEqual([])
    // And the fractional dials stay fractional.
    for (const k of ['feed_gravity', 'feed_alpha_following', 'resonance_band2_min', 'dedup_min_confidence']) {
      expect(isIntegerDialKey(k), k).toBe(false)
    }
  })
})
