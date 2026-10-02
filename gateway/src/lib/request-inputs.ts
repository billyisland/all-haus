// =============================================================================
// Path ids and limits — the two shapes that 500 the gateway.
//
// Roughly thirty routes take a value straight off the URL and interpolate it
// into SQL. Two of them recur:
//
//   `/:id`     A uuid path segment goes into `WHERE id = $1`. Postgres answers
//              a malformed one with `invalid input syntax for type uuid`, so
//              the route 500s — and until the error funnel landed, with that
//              text in the body. It is a 404, not a 400 and not a 500: a
//              well-formed id naming nothing and a malformed id are the same
//              answer to the caller, and splitting them makes the route an
//              oracle for which ids exist (the S16 rule about `GET /sources/:id`,
//              one layer down).
//
//   `?limit=`  `Math.min(parseInt(raw, 10), cap)` is NaN for `?limit=x` and
//              negative for `?limit=-1`. Both reach `LIMIT $n` and raise. A
//              limit is a client HINT, not an instruction, so a malformed one
//              falls back to the default rather than refusing — a paginating
//              client that sends junk should get a page, and the route that
//              refuses it has turned a display bug into an outage.
//
// Both are deliberately plain functions rather than Fastify schemas: the
// routes here validate bodies with Zod and params with neither, and a third
// mechanism would just be a third place to forget.
// =============================================================================

import { UUID_RE } from "./uuid.js";

/**
 * True when `raw` is a uuid Postgres will accept.
 *
 * Delegates to `lib/uuid.ts`, which is that regex's one home — it had been
 * hand-copied thirteen times before it got one, and this would have been the
 * fourteenth. What is added here is the `typeof` guard and the narrowing: a
 * param Fastify's generic types `string` is `undefined` at run time whenever
 * the route is reached by a path that does not carry it, and
 * `UUID_RE.test(undefined)` is a stringify, not a refusal.
 *
 * Stricter than Postgres, which also takes the brace and no-hyphen forms —
 * deliberate and inherited: every id this platform mints is the canonical
 * hyphenated form, so the looser spellings can only come from something
 * hand-building a URL, and accepting them would make one row addressable by
 * three different strings.
 */
export function isUuid(raw: unknown): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw);
}

/**
 * A `limit` querystring as a usable integer.
 *
 * `fallback` when absent or malformed, clamped to `[1, cap]` otherwise. Never
 * throws and never returns NaN — that is the whole point.
 */
export function parseLimit(
  raw: string | undefined | null,
  fallback: number,
  cap: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, cap);
}

/**
 * An `offset`/`page` querystring as a usable non-negative integer.
 *
 * Same contract as `parseLimit` and capped for the same reason a cursor's
 * epoch is: an offset of 1e12 is not a position, it is a sequential scan
 * somebody typed.
 */
export function parseOffset(raw: string | undefined | null, cap = 100_000): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, cap);
}
