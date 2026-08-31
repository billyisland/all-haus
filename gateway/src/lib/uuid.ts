// =============================================================================
// UUID — the single canonical UUID matcher for route-param guards.
//
// This regex was hand-copied ~13 times across the gateway routes (some with the
// `i` flag, some without); this is its one definition. Case-insensitive is the
// deliberate, safe superset: it never rejects a value a stricter copy accepted,
// it only additionally accepts an upper-case UUID — which Postgres normalises on
// a `::uuid` cast, so at worst it resolves to a clean not-found, never a bug.
// =============================================================================

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
