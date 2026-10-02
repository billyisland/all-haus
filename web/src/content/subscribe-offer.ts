// =============================================================================
// A subscription offer's page — the words, in one home for both registers.
//
// The full site's `/subscribe/:code` (a client page) and modernhaus's
// `/modernhaus/subscribe/<code>` describe the same offer and take the same
// press. The reasoning is in the full site's page.
// =============================================================================

/** A grant offer met while signed out: the lookup answers 401 (§1.10). */
export const OFFER_FOR_YOU_TITLE = 'This one’s addressed to you'
export const OFFER_FOR_YOU_BODY =
  'It’s a gift subscription for a particular account. Log in and we’ll show you what it is.'
export const OFFER_FOR_YOU_ACTION = 'Log in to view'

export const OFFER_UNAVAILABLE_TITLE = 'This offer isn’t available'
export const OFFER_UNAVAILABLE_FALLBACK = 'This offer is not available.'
/** The lookup's 404: the code names nothing we know. */
export const OFFER_NOT_FOUND_BODY =
  'There’s no offer at this address. Check the link you were sent — codes are case-sensitive.'
/** The lookup got no answer at all (network, 5xx): an outage, not a refusal. */
export const OFFER_LOAD_FAILED = 'Couldn’t load this offer just now.'
export const OFFER_RETRY = 'Try again'

/**
 * The sentence for a failed lookup, by what the gateway said (CA-E2). A 404 is
 * ours to word; a 410 carries the route's own sentence in `error` (expired,
 * fully redeemed — `subscription-offers.ts` sends no `message`), and anything
 * else is an outage. Never the raw `ApiError` message, which is
 * `API error 404: {"error":…}`.
 */
export function offerLookupMessage(err: unknown): { body: string; outage: boolean } {
  const status = (err as { status?: unknown } | null)?.status
  const raw = (err as { body?: { error?: unknown; message?: unknown } } | null)?.body
  const sentence =
    typeof raw?.message === 'string' && raw.message
      ? raw.message
      : typeof raw?.error === 'string' && raw.error
        ? raw.error
        : null
  if (status === 404) return { body: OFFER_NOT_FOUND_BODY, outage: false }
  if (status === 410) return { body: sentence ?? OFFER_UNAVAILABLE_FALLBACK, outage: false }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { body: sentence ?? OFFER_UNAVAILABLE_FALLBACK, outage: false }
  }
  return { body: OFFER_LOAD_FAILED, outage: true }
}

interface OfferShape {
  isComp: boolean
  mode: 'code' | 'grant'
  discountPct: number
  durationMonths: number | null
  standardPricePence: number
  discountedPricePence: number
}

export function offerPounds(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`
}

/** The small label over the offer's title. */
export function offerKind(o: OfferShape): string {
  return o.isComp ? 'A complimentary subscription' : o.mode === 'grant' ? 'A gift for you' : 'Subscription offer'
}

/** "From" a writer (a gift) or "Subscribe to" them (a code). */
export function offerWriterLead(o: OfferShape): string {
  return o.mode === 'grant' ? 'From ' : 'Subscribe to '
}

/** The price as it now stands: free, or the discounted monthly figure. */
export function offerPrice(o: OfferShape): string {
  return o.discountedPricePence === 0 ? 'Free' : `${offerPounds(o.discountedPricePence)}/mo`
}

export function offerWasPrice(o: OfferShape): string {
  return `${offerPounds(o.standardPricePence)}/mo`
}

export function offerDiscount(o: OfferShape): string {
  return `${o.discountPct}% off`
}

/** How long the rate lasts, and what happens after. */
export function offerTerms(o: OfferShape): string {
  if (o.isComp) return 'A full year, on the house. No card needed and nothing renews: when the year is up, it simply ends.'
  return o.durationMonths
    ? `Discounted rate for ${o.durationMonths} month${o.durationMonths > 1 ? 's' : ''}, then ${offerPounds(o.standardPricePence)}/mo.`
    : 'This rate doesn’t expire.'
}

export const OFFER_SIGN_IN = 'Log in to subscribe'

/** The press, saying what it does. */
export function offerButton(o: OfferShape): string {
  if (o.isComp) return 'Accept'
  return o.discountedPricePence === 0 ? 'Subscribe for free' : `Subscribe for ${offerPounds(o.discountedPricePence)}/mo`
}

export const OFFER_SUBSCRIBED_TITLE = 'Subscribed.'
export function offerSubscribedBody(writerName: string): string {
  return `You’re subscribed to ${writerName}. Taking you to their profile.`
}
