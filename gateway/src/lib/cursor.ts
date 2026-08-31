// =============================================================================
// Keyset-cursor primitives — the ONE home for the M13 rule.
//
// Every time-based keyset cursor in the gateway compares its epoch via
// `to_timestamp()` against a full-precision `published_at`/`created_at` that the
// ORDER BY also sorts at full precision. So the epoch must survive the
// encode→wire→decode round trip WITHOUT losing its fraction. Truncated to the
// whole second, the cursor lands EARLIER than the row it was minted from, and
// the tuple filter then excludes every remaining row inside that second — the
// client never reaches them.
//
// This module exists because that rule had been written out THREE times
// (`parseCursorEpoch` in feed-sql.ts, plus two inline copies in
// routes/feeds/items.ts) and the encoder had been hand-rolled in FIVE places.
// M13 is the bug class that already recurred once: the original fix corrected
// the SQL and the encoders but left the decoders on `parseInt`, so the fix was
// inert and shipped green. A rule duplicated N times is a rule that gets fixed
// N-1 times.
//
// Scope note — this unifies the CODEC, deliberately not the WIRE FORMATS. There
// are two live shapes: the untagged `ts:id` / `score:ts:id` family decoded by
// `parseCursor` (feed-sql.ts) and the tagged `scored:…` / `explore:…` family
// decoded by `decodeFeedCursor` (routes/feeds/items.ts). Collapsing them would
// invalidate every cursor a client currently holds mid-pagination, for no
// correctness gain. What matters is that both families parse their epoch
// through the same function, and that nobody hand-rolls the encoder again.
// =============================================================================

/**
 * Parse a cursor's epoch component — `Number`, never `parseInt`.
 *
 * The epoch on the wire is FRACTIONAL (`EXTRACT(EPOCH FROM …)` with no
 * `::bigint` cast, e.g. `1784282400.500123`). `parseInt` stops at the `.` and
 * silently truncates to the whole second, reinstating the exact page-boundary
 * bug the fractional cursor exists to prevent.
 *
 * Stricter than `parseInt` by design: a malformed component yields NaN (→ the
 * caller restarts from page 1, the documented degradation) rather than being
 * salvaged into a wrong position. Empty string is rejected explicitly, because
 * `Number("")` is 0 — which would silently mean "the epoch", i.e. 1970.
 *
 * Range-clamped (§0k.4b): "finite" alone still admits a crafted value like
 * `1e300`, which reaches `to_timestamp()` and 500s the request (Postgres
 * timestamps top out around year 294276 ≈ 9.2e12 epoch seconds). Real cursors
 * carry published_at/created_at/asOf epochs, so anything outside [0, 1e11]
 * (~year 5138) is garbage, not a position — reject to NaN like any other
 * malformed component.
 */
const MAX_CURSOR_EPOCH = 1e11;

export function parseCursorEpoch(raw: string): number {
  if (raw.trim() === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= MAX_CURSOR_EPOCH ? n : NaN;
}

/**
 * Encode the `<fractional-epoch>:<uuid>` cursor shared by every surface that
 * pages a feed_items projection by (published_at, id): the tag, source, author
 * (posts + replies) and saved-items surfaces.
 *
 * `ts` MUST come from an un-cast `EXTRACT(EPOCH FROM …)` projection. A
 * `::bigint` cast truncates at the SQL layer, which no amount of care in this
 * function can recover — that half of M13 lives in the query, and the shared
 * `FEED_CURSOR_EPOCH()` helper below is how a caller states it correctly.
 */
export function encodeTsIdCursor(ts: number | string, id: string): string {
  return `${Number(ts)}:${id}`;
}

/**
 * The SQL projection that mints a cursor-safe epoch. Use this in any SELECT
 * whose last row feeds `encodeTsIdCursor`, so the no-`::bigint` rule is stated
 * in one place instead of being re-remembered per query.
 *
 * Deliberately NOT applied to the `*_epoch` columns in the display payload
 * (`FEED_SELECT`'s `published_at_epoch` and friends): those are read by clients
 * as a whole-second timestamp and are cast `::bigint` on purpose. Only the
 * cursor needs the fraction.
 */
export function feedCursorEpoch(column: string, alias: string): string {
  return `EXTRACT(EPOCH FROM ${column}) AS ${alias}`;
}
