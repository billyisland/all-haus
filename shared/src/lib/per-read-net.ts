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
 * SQL fragment for the per-read net of `chargeableExpr`, given a bound parameter
 * placeholder (e.g. '$2') carrying the fee bps. Use inside aggregates so the
 * money and display queries share one definition:
 *   `SUM(${readNetSql('r.chargeable_pence', '$2')})`
 *
 * `chargeableExpr` must be `read_events.chargeable_pence` (however aliased) and
 * NEVER `amount_pence` — the gift rule in the header, enforced by
 * scripts/check-read-chargeable.sh. Both arguments must be trusted (a column
 * ref / a bound placeholder) — never interpolate user input.
 */
export function readNetSql(chargeableExpr: string, feeBpsParam: string): string {
  return `(${chargeableExpr} - FLOOR(${chargeableExpr} * ${feeBpsParam} / 10000))`
}
