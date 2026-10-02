// =============================================================================
// The consent to a legal text — the words, in one home for both registers.
//
// The full site's `components/legal/TermsConsent.tsx` (a client component) and
// modernhaus's consent box say exactly this, because a consent record names a
// text and the sentence beside the box is what the member actually read before
// ticking it. Two copies would drift in what they say, which is the one thing
// a consent cannot afford. They live here because modernhaus cannot import a
// `'use client'` file; the reasoning behind the construction is in
// `TermsConsent.tsx`'s header.
// =============================================================================

export const TERMS_DOC = {
  reader: { href: '/reader-terms', title: 'Reader Terms' },
  writer: { href: '/writer-agreement', title: 'Writer Agreement' },
} as const

export type TermsKind = keyof typeof TERMS_DOC

/**
 * What the member is agreeing IN ORDER to do — completes "…which apply when".
 * One per act, so the paywall, the card form, both subscribe surfaces and the
 * first paid publish cannot each describe the same act differently.
 */
export const TERMS_PURPOSE = {
  read: 'you read paid writing on all.haus',
  subscribe: 'you subscribe to a writer on all.haus',
  sell: 'all.haus sells paid access to your writing',
} as const

/** Asked again, for a member who accepted an older text. */
export function termsRenewalSentence(kind: TermsKind): string {
  return `The ${TERMS_DOC[kind].title} have changed since you last accepted them.`
}

/** The box's sentence is these three parts, the middle one the link. */
export const TERMS_ACCEPT_BEFORE = 'I accept the '
export function termsLinkText(kind: TermsKind): string {
  return `all.haus ${TERMS_DOC[kind].title}`
}
export function termsAcceptAfter(purpose: string): string {
  return `, which apply when ${purpose}.`
}

/** The acceptance was refused because the text moved between render and press. */
export function termsVersionMismatch(kind: TermsKind): string {
  return kind === 'reader'
    ? 'The Reader Terms have just been updated. Please read them again and accept.'
    : 'The Writer Agreement has just been updated. Please read it again and accept.'
}

/** The acceptance failed for any other reason. */
export const TERMS_ACCEPT_FAILED = 'Could not record your acceptance. Please try again.'

/** Above the Writer Agreement's box, where a paid publish meets it. */
export const WRITER_TERMS_LEAD =
  'You’re about to sell paid access to this piece. all.haus sells it on your behalf, under the Writer Agreement.'
export const TERMS_ACCEPT_AND_CONTINUE = 'Accept and continue'
