import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { diffAgainstDefaults } from '../src/db/config-defaults-parse.js'
import { pool, loadConfig } from '../src/db/client.js'

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
  'tab_settlement_threshold_pence',
  'monthly_fallback_minimum_pence',
  'writer_payout_threshold_pence',
  'publication_payout_threshold_pence',
  'platform_fee_bps',
  'monthly_fallback_days',
  'payout_max_slices',
  'allocated_residual_alert_bps',
  'allocation_sync_freshness_hours',
  'payout_halt_escalation_hours',
] as const

describe('loadConfig fallbacks vs config-defaults.sql', () => {
  it('every fallback matches the seeded default', async () => {
    // Empty table → every field takes its in-code fallback.
    seedConfigTable([])
    const c = await loadConfig(true)

    const bad = diffAgainstDefaults({
      free_allowance_pence: c.freeAllowancePence,
      tab_settlement_threshold_pence: c.tabSettlementThresholdPence,
      monthly_fallback_minimum_pence: c.monthlyFallbackMinimumPence,
      writer_payout_threshold_pence: c.writerPayoutThresholdPence,
      publication_payout_threshold_pence: c.publicationPayoutThresholdPence,
      platform_fee_bps: c.platformFeeBps,
      monthly_fallback_days: c.monthlyFallbackDays,
      payout_max_slices: c.payoutMaxSlices,
      allocated_residual_alert_bps: c.allocatedResidualAlertBps,
      allocation_sync_freshness_hours: c.allocationSyncFreshnessHours,
      payout_halt_escalation_hours: c.payoutHaltEscalationHours,
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

  it('a non-numeric row falls back rather than throwing', async () => {
    // Shipped behaviour of int(): a garbage value reverts to the fallback
    // silently. Pinned because it is the same substitution the parity test
    // above is what makes safe — the fallback has to be right for this arm to
    // be a soft landing rather than a second invisible source of truth.
    seedConfigTable([{ key: 'platform_fee_bps', value: 'eight percent' }])
    const c = await loadConfig(true)
    expect(c.platformFeeBps).toBe(800)
  })

  it('covers every dial loadConfig reads', async () => {
    // Completeness: the parity map is hand-written, so a dial added to the
    // loader without a line here would ship unchecked — the exact gap this
    // test was split out of §0o.9 to close.
    const src = fs.readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8')
    const read = [...src.matchAll(/\bint\(map,\s*'([a-z0-9_]+)'/g)].map((m) => m[1])
    expect(read.sort()).toEqual([...FALLBACK_KEYS].sort())
  })
})
