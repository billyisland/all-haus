// =============================================================================
// Whether a `platform_config` key holds a WHOLE number (CA-F2).
//
// Some dials are genuinely fractional (`feed_gravity`, the D6 alphas, the
// resonance bands), so integer-ness is a fact about the KEY, spelled once: a
// unit suffix that only counts whole things, plus the one integer dial whose
// name carries none. The config editor asks it before accepting an edit, and
// every `int()` key in `loadConfig` must satisfy it
// (`shared/tests/config-fallback-parity.test.ts`). Pure, and in its own module,
// so the many test files that mock `db/client.js` wholesale need not restate it.
// =============================================================================

export function isIntegerDialKey(key: string): boolean {
  return /_(pence|bps|days|hours|seconds|pct)$/.test(key) || key === "payout_max_slices";
}
