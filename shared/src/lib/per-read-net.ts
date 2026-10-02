// =============================================================================
// per-read-net — the single definition of a read's writer-side net.
//
// The platform fee is applied PER ROW then floored: a read worth `amount_pence`
// nets `amount_pence − FLOOR(amount_pence * feeBps / 10000)` to the writer. This
// formula was hand-duplicated across ~12 SQL sites in three files (payout.ts,
// publications/revenue.ts, my-account.ts) with no shared definition; Upstream
// Edges Phase 3 introduced two MORE consumers that must agree with those to the
// penny (settlement apportionment freezes each accrual against this net; the
// author carve and the dashboard display subtract accruals from it). If the
// formula drifted between the money paths and the display paths, conservation
// and the author's dashboard would diverge — so it lives here, once.
//
// Per-row-then-floor (not sum-then-floor) is deliberate and matches the existing
// settlement/payout rounding rule: the platform absorbs the dust, so the writer
// keeps a sub-penny per row rather than losing N pennies collapsed into one fee
// (payout.ts runPayoutCycle comment; tests/payout-math.test.ts).
//
// WHICH AMOUNT (the gift rule — product ruling 2026-07-29, migration 164). The
// fee applies to what the reader was CHARGED, not to the article's list price.
// A read part-covered by the £5 free allowance carries both:
//
//   read_events.amount_pence      the list price at read time
//   read_events.chargeable_pence  list price − allowance_consumed_pence
//
// The free allowance is a gift from authors, and attaching a card does not
// revoke it — so a gifted penny is charged to nobody and earns nobody. Every
// caller of the two functions below must therefore pass the CHARGEABLE amount.
// Passing `amount_pence` bills the gift back to the reader and pays writers for
// pence never collected; that was live and silent from the day
// convertProvisionalReads was written until migration 164. Enforced by
// scripts/check-read-chargeable.sh.
// =============================================================================

/**
 * Writer-side net of a single read, in pence. JS twin of {@link readNetSql}.
 *
 * Takes the CHARGEABLE amount (`read_events.chargeable_pence`), never the list
 * price — see the gift rule in the header.
 */
export function perReadNetPence(chargeablePence: number, platformFeeBps: number): number {
  return chargeablePence - Math.floor((chargeablePence * platformFeeBps) / 10000)
}

/**
 * SQL fragment for the per-read net of `chargeableExpr`, given an expression
 * carrying the fee bps — normally {@link readFeeBpsSql}, which prefers the
 * rate STAMPED on the row. Use inside aggregates so the money and display
 * queries share one definition:
 *   `SUM(${readNetSql('r.chargeable_pence', readFeeBpsSql('r.', '$2'))})`
 *
 * `chargeableExpr` must be `read_events.chargeable_pence` (however aliased) and
 * NEVER `amount_pence` — the gift rule in the header, enforced by
 * scripts/check-read-chargeable.sh. Both arguments must be trusted (a column
 * ref / a bound placeholder) — never interpolate user input.
 */
export function readNetSql(chargeableExpr: string, feeBpsExpr: string): string {
  return `(${chargeableExpr} - FLOOR(${chargeableExpr} * ${feeBpsExpr} / 10000))`
}

// =============================================================================
// WHICH FEE (migration 208, L5.1). The rate a read earns at is a fact about
// THAT READ, stamped on it at accrual — `read_events.fee_bps`. Every stage
// after the accrual reads the row, so retuning `platform_fee_bps` cannot move
// money that is already earned, and a chargeback reversal computed later backs
// out exactly the accrual that was posted (a mismatch there is a ledger
// divergence, which halts every payout on the platform).
//
// The parameter is the FALLBACK, and it is the live dial. `fee_bps` is NULL on
// exactly two populations: rows written before migration 208 backfilled the
// column (none, after it runs) and rows written by a pre-deploy build during
// the window between `migrate` and the service rebuild. For those the live dial
// IS the rate they are being paid at today, so falling back to it changes
// nothing about them — it is not a second copy of the dial, it is the old
// behaviour, scoped to the rows that still have the old behaviour.
// =============================================================================

/**
 * SQL expression for the fee bps to apply to a read: the rate stamped on the
 * row, falling back to the live dial for a row written before the stamp.
 *
 * `prefix` is the read_events alias including its dot (`'r.'`, `'re.'`, or
 * `''` for an unaliased/derived query — a derived table must carry `fee_bps`
 * through its own select list). `feeBpsParam` is the bound placeholder holding
 * `config.platformFeeBps`. Both must be trusted — never user input.
 */
export function readFeeBpsSql(prefix: string, feeBpsParam: string): string {
  return `COALESCE(${prefix}fee_bps, ${feeBpsParam})`
}

/**
 * JS twin of {@link readFeeBpsSql} — the rate stamped on a read row, falling
 * back to the live dial when the row predates the stamp.
 */
export function readFeeBps(stampedFeeBps: number | null | undefined, liveFeeBps: number): number {
  return stampedFeeBps ?? liveFeeBps
}
