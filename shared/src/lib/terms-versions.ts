// =============================================================================
// The version of each legal text, and the one rule for comparing two of them.
//
// A version string is `major.text`:
//
//   major  bumps when a clause a member agreed to has CHANGED — a new price
//          term, a new obligation, a different party. Bumping it means every
//          member is asked again.
//   text   bumps for an edit that changes no obligation: a typo, a clearer
//          sentence, a reordered list. The comparison IGNORES it, so a
//          member who accepted 1.0 is not re-prompted by 1.1.
//
// That split is the whole reason the version is two-part. Without it every
// wording fix would either re-prompt the entire membership or go out silently
// under a version number that now names different text — and the second is how
// a stored acceptance stops meaning anything.
//
// WHAT IS STORED IS THE WHOLE STRING. `accounts.reader_terms_version` keeps
// `1.1`, not `1`, so the record says exactly which text was on screen. Only
// the COMPARISON drops the text part.
//
// BUMPED BY HAND, BESIDE THE TEXT. These constants are not derived from the
// documents — a derivation would move the version on a whitespace change and
// could not tell a clause edit from a typo. Changing a text and forgetting the
// constant is the failure mode, which is why the pages that render the text
// assert the version they display against the constant here.
// =============================================================================

/**
 * The two texts a member can accept. Declared as a runtime array with the type
 * derived from it, not the other way round: a bare union type can be compared
 * against nothing at run time, and this is a value that crosses the
 * web <-> gateway boundary (CLAUDE.md > a type is not a contract).
 */
export const TERMS_KINDS = ['reader', 'writer'] as const
export type TermsKind = (typeof TERMS_KINDS)[number]

/**
 * Reader Terms — accepted when a Reader registers a payment method.
 *
 * 1.1 (L8.8, 2026-09-17): clause 3.1 rewritten to the commercial-agent model —
 * the price shown is the whole price, and VAT is the Writer's to charge or not,
 * most of them not being registered for it. A TEXT bump and deliberately so:
 * it changes no obligation either way, it corrects an implication rather than a
 * term, and re-prompting every card-holder over a clarification is exactly what
 * the two-part version exists to avoid.
 */
/**
 * 2.0 (2026-09-18, CONSOLIDATED-TODO §0z item 18): clause 12.2 said a
 * suspended or closed reader keeps access to content they paid for "for as
 * long as we are able to provide it". A suspended account holds no session
 * and a closed one is gone, so it was a promise nothing kept; the operator
 * chose to rewrite it to what happens rather than build a suspended-session
 * carve-out. It narrows what a reader was told, which is a term change and a
 * MAJOR bump — every card-holder is asked again at their next paid read.
 * (The Writer-side promise, 3.4/13.3, was BUILT the same day: a withdrawn
 * piece stays readable to whoever already bought it.)
 */
export const READER_TERMS_VERSION = '2.0'

/**
 * Writer Agreement — accepted when a Writer first publishes paid access.
 *
 * 2.0 (L8.6, 2026-09-17): clause 6.6, the payout pause while an account is
 * suspended or closed, and where the law requires it. A MAJOR bump because it
 * is a new term about the Writer's money — every Writer who accepted 1.0 is
 * asked again, which is the whole point of the split.
 *
 * Also 2.0, same day (L8.8): clause 5.1 now PUBLISHES the price bounds it had
 * only promised (1p and £9,999.99, which is what `publish.ts` has always
 * enforced), and clause 15.5 stops naming two documents that have no address —
 * the content rules are Terms clause 4 and the fee is clause 6.1 of this
 * agreement, and neither is a separate publication. 5.1 is a real term change
 * and would need a major of its own; it rides this one, which is the cheap
 * moment to make it. Two major bumps in a day would ask every Writer twice for
 * no additional consent.
 *
 * 2.1 (2026-09-18, CONSOLIDATED-TODO §0z item 1): clause 3.2 said paid content
 * "is not published to relays". It is — as ciphertext in the kind-30023
 * event's `payload` tag (`gateway/src/services/article-publisher.ts`), with
 * only the KEY served from all.haus. A TEXT bump: it corrects a description
 * in the reader's favour and changes no obligation on the Writer.
 */
export const WRITER_TERMS_VERSION = '2.1'

const CURRENT: Record<TermsKind, string> = {
  reader: READER_TERMS_VERSION,
  writer: WRITER_TERMS_VERSION,
}

/** The version a new acceptance of `kind` is stamped with. */
export function currentTermsVersion(kind: TermsKind): string {
  return CURRENT[kind]
}

/**
 * The major part of a version string — everything before the first dot.
 *
 * A string with no dot is its own major part, so `'1'` and `'1.0'` compare
 * equal. A malformed value (empty, or leading-dot) yields the empty string,
 * which matches no real version and therefore fails closed: an unreadable
 * stored version means "not accepted", never "accepted".
 */
export function termsMajor(version: string): string {
  const dot = version.indexOf('.')
  return dot === -1 ? version : version.slice(0, dot)
}

/**
 * Has a member who accepted `accepted` accepted the current `kind` text?
 *
 * NULL / undefined — never accepted — is false, and so is a stored version
 * whose major part differs. The text part is ignored by design.
 */
export function termsAcceptanceIsCurrent(
  kind: TermsKind,
  accepted: string | null | undefined,
): boolean {
  if (!accepted) return false
  const major = termsMajor(accepted)
  return major !== '' && major === termsMajor(currentTermsVersion(kind))
}
