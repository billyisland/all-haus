// =============================================================================
// Timestamp keyset cursors — the ONE home for the second cursor wire shape.
//
// The precision invariant: a value that records HOW FAR WE HAVE GOT through a
// time-ordered table must round-trip at Postgres's own precision. `timestamptz`
// keeps MICROseconds; a JS `Date` keeps milliseconds, so every cursor that
// becomes a `Date` (or is minted by `.toISOString()`) silently drops three
// digits. Truncation always errs BACKWARDS, and which way that hurts depends on
// the comparison:
//
//   ascending  `> cursor`  → the truncated position re-includes rows already
//                            sent: a duplicate, which is at least visible.
//   descending `< cursor`  → the truncated position EXCLUDES the rows between
//                            the truncated and the true microsecond: they land
//                            in neither page and nothing ever revisits them.
//
// Every cursor in this family is descending, so the symptom is a notification,
// a message or an observation that nobody ever sees. It never errors.
//
// The fix is to STOP CONVERTING, never to add a tolerance window: project the
// position as `<column>::text` and feed it back as `$n::timestamptz`, so the
// value is a string at every point between the two queries and no JS date type
// ever touches it. `gateway/src/workers/waitlist-digest.ts` is the worked
// example this generalises.
//
// Scope note. This is deliberately a SECOND home beside `gateway/src/lib/
// cursor.ts`, which owns the `<fractional-epoch>:<uuid>` family the feed
// surfaces use. Two wire shapes, two codecs, one rule; collapsing them would
// invalidate every cursor a client is holding mid-pagination for no correctness
// gain. What matters is that neither shape is ever hand-rolled again.
// =============================================================================

/**
 * The shape `timestamptz::text` produces under any `DateStyle`/`TimeZone` this
 * platform runs (ISO, UTC): `2026-09-10 12:34:56.123456+00`. An ISO-8601 `T`
 * separator and a `Z` suffix are accepted too, because a client holding a
 * cursor minted BEFORE this rule landed sends exactly that, and refusing it
 * would 400 every open pagination on deploy. Such a cursor is millisecond-
 * precision by construction — it is honoured as the position it names, which is
 * no worse than what it did yesterday, and the next page mints a full-precision
 * replacement.
 */
//
// The fields are BOUNDED, not merely digit-shaped: `2026-99-99 99:99:99` has the
// shape and Postgres refuses it (22008), which the error handler answers as a
// 500. A day past its month's end (`2026-02-30`) is the one refusal a regex
// cannot state, so `parseTimestampCursor` asks the calendar for that one.
const TIMESTAMP_CURSOR_RE =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-](0\d|1[0-5])(:?[0-5]\d)?)?$/;

/** Days in a proleptic-Gregorian month — Postgres's calendar for timestamptz. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Validate a client-supplied timestamp cursor.
 *
 * Returns the string unchanged when it is well-formed, `null` when it is not.
 * A caller MUST answer 400 on `null` rather than passing the value on: the
 * cursor goes straight into a `$n::timestamptz` comparison, so Postgres raises
 * `invalid input syntax for type timestamp with time zone` and the route 500s
 * with a database message in the body.
 *
 * Deliberately a regex and not `new Date(...)`: `Date` accepts `"2026"` and
 * `"Sep 10 2026"`, both of which Postgres also accepts, and parsing through it
 * would be the very conversion this module exists to prevent.
 */
export function parseTimestampCursor(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s.length > 64) return null;
  const m = TIMESTAMP_CURSOR_RE.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  // Year 0000 does not exist in Postgres's AD calendar.
  if (year === 0 || Number(m[3]) > daysInMonth(year, Number(m[2]))) return null;
  return s;
}
