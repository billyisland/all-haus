// =============================================================================
// Trust Phase A — attestor weighting formula (ALLHAUS-OMNIBUS §II.8)
//
// Pure function: Layer 1 signals in, weight out. No DB dependency.
//
// weight = age × payment × readership × activity
//
// Each sub-score is [0, 1]. A zero in any dimension zeroes the total weight.
// Cap values: 365 days, 50 paying readers, 10 articles.
// =============================================================================

export interface AttestorSignals {
  accountAgeDays: number
  paymentVerified: boolean
  payingReaderCount: number
  articleCount: number
}

export function attestorWeight(l1: AttestorSignals): number {
  const age = Math.min(l1.accountAgeDays / 365, 1.0)
  const payment = l1.paymentVerified ? 1.0 : 0.3
  const readership = Math.min(l1.payingReaderCount / 50, 1.0)
  const activity = Math.min(l1.articleCount / 10, 1.0)

  return age * payment * readership * activity
}
