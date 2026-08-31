// =============================================================================
// Trust Phase 4 — aggregation, freshness, and decay (ALLHAUS-OMNIBUS §II.8)
//
// Pure functions: vouch data in, scores out. No DB dependency.
//
// Freshness decay table (per epoch since last reaffirmation):
//   0 → 1.0, 1 → 0.85, 2 → 0.70, 3 → 0.50, 4 → 0.30, 5 → 0.15, 6+ → 0.0
//
// Small-scale decay protection (by active attestation count):
//   1–3: paused (0.0), 4–6: quarter (0.25), 7–9: half (0.5), 10+: full (1.0)
// =============================================================================

const FRESHNESS_TABLE: Record<number, number> = {
  0: 1.0,
  1: 0.85,
  2: 0.70,
  3: 0.50,
  4: 0.30,
  5: 0.15,
}

/** Freshness multiplier for a vouch based on epochs since reaffirmation. */
export function freshnessMultiplier(epochsSinceReaffirm: number): number {
  if (epochsSinceReaffirm < 0) return 1.0
  if (epochsSinceReaffirm >= 6) return 0.0
  return FRESHNESS_TABLE[epochsSinceReaffirm] ?? 0.0
}

/** Decay rate multiplier based on active attestation count for the subject. */
export function decayRateMultiplier(activeAttestationCount: number): number {
  if (activeAttestationCount <= 3) return 0.0
  if (activeAttestationCount <= 6) return 0.25
  if (activeAttestationCount <= 9) return 0.5
  return 1.0
}

/**
 * Apply one epoch of decay to a vouch's epochs_since_reaffirm value.
 * Returns the new value after applying the graduated decay multiplier.
 *
 * The multiplier scales the per-epoch freshness drop, not the counter itself.
 * At small scale, the counter still increments by 1 each full epoch, but the
 * freshness lookup uses the effective (slowed) value.
 *
 * We model this by returning the incremented counter — the decay protection
 * is applied at scoring time via the effective freshness calculation.
 */
export function applyDecay(currentEpochs: number): number {
  return currentEpochs + 1
}

/**
 * Compute the effective freshness for a vouch, accounting for small-scale
 * decay protection. The protection slows the decay rate, not the counter.
 *
 * Formula: effective_freshness = 1.0 - (1.0 - raw_freshness) × decay_rate
 */
export function effectiveFreshness(
  epochsSinceReaffirm: number,
  activeAttestationCount: number,
): number {
  const raw = freshnessMultiplier(epochsSinceReaffirm)
  const rate = decayRateMultiplier(activeAttestationCount)

  // At rate 0 (1–3 attestations), decay is fully paused → freshness = 1.0
  // At rate 1 (10+ attestations), full decay → freshness = raw value
  return 1.0 - (1.0 - raw) * rate
}

export interface VouchForScoring {
  value: 'affirm' | 'contest'
  attestorWeight: number
  epochsSinceReaffirm: number
}

/**
 * Compute a normalised [0, 1] dimension score from a set of weighted vouches.
 *
 * Score = clamp(weighted_sum / weight_total, 0, 1)
 * where affirm = +1, contest = -1, weighted by attestor_weight × freshness.
 *
 * activeAttestationCount is the total active vouches for this subject (across
 * all dimensions) — used for small-scale decay protection.
 */
export function computeDimensionScore(
  vouches: VouchForScoring[],
  activeAttestationCount: number,
): number {
  if (vouches.length === 0) return 0

  let weightedSum = 0
  let weightTotal = 0

  for (const v of vouches) {
    const freshness = effectiveFreshness(v.epochsSinceReaffirm, activeAttestationCount)
    const w = v.attestorWeight * freshness
    if (w <= 0) continue

    const direction = v.value === 'affirm' ? 1 : -1
    weightedSum += w * direction
    weightTotal += w
  }

  if (weightTotal === 0) return 0

  // Normalise to [0, 1]: raw ratio is in [-1, 1], shift and scale
  const raw = weightedSum / weightTotal  // [-1, 1]
  return Math.max(0, Math.min(1, (raw + 1) / 2))
}
