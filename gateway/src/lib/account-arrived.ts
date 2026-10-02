// =============================================================================
// Has this account's owner ARRIVED? (RESHAPE-PLAN-2026-10 §A.2.6, decision 5,
// and §A.5 as ruled by the operator 2026-09-30)
//
// The waitlist Admit action creates an account before its owner has ever
// signed in, names it from the email's local part (the only name a waitlist
// row carries), and appends it to the default seed. Until the owner arrives
// and renames themselves, nobody is shown that account: no source list names
// it, no share link carries it, search does not find it, and its profile URL
// answers 404 like any account that is not there. The day they arrive it
// appears everywhere at once, with no write, because every one of those is a
// filter on the READ.
//
// "Arrived" is the age declaration: `requireAuth` refuses every route but two
// until it is set, so nothing a signed-in member does precedes it. It is NEVER
// asked alone. Most long-standing accounts have no declaration, and
// `age_declared_at IS NULL` by itself would hide nearly every existing member.
// `provisioned_by_admit` is the other half, written once by `provisionAccount`
// on the admit path only and never cleared.
//
// THE ONE HOME. Written so a row with no joined account (every non-account
// feed source, where a LEFT JOIN misses) reads as arrived: `IS NOT TRUE` is
// true for NULL, where a bare `NOT (a AND b)` would be NULL and drop the row.
// Askers: feed source lists and share projections (routes/feeds), people
// search (routes/search.ts), the profile routes (routes/writers.ts) and the
// native-author check (routes/author.ts).
// =============================================================================

export function accountArrivedSql(alias: string): string {
  return `(${alias}.provisioned_by_admit IS NOT TRUE OR ${alias}.age_declared_at IS NOT NULL)`;
}
