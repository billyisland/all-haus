import { formatPrice } from '../lib/format'

// =============================================================================
// The paywall gate — the words, in one home for both registers.
//
// The full site's `components/article/PaywallGate.tsx` (a client component) and
// modernhaus's unlock form tell a reader the same thing about the same press:
// what the piece costs, who they are buying it from, and whether their free
// allowance covers it. Which sentence applies is a pure function of five facts
// about the viewer, so it lives here as one, and both registers call it. The
// reasoning behind each branch is in `PaywallGate.tsx`'s comments.
// =============================================================================

export interface PaywallGateFacts {
  isLoggedIn: boolean
  /** What a new account comes with, or null for "none can be made". */
  signupOffer: { freeAllowancePence: number; arrivalGiftCapPence: number } | null
  hasPaymentMethod: boolean
  freeAllowanceRemaining: number
  pricePence: number | null
  /** Only for the legacy caller that knows the price as pounds alone. */
  pricePounds?: string | null
  writerName?: string
}

export interface PaywallGateCopy {
  heading: string
  subtext: string
  buttonLabel: string
  /** The price is stated on its own, large, under the sentence. */
  showPrice: boolean
  /** A card is the fix before the reader has even pressed. */
  suggestCard: boolean
}

export function paywallGateCopy(f: PaywallGateFacts): PaywallGateCopy {
  const { isLoggedIn, signupOffer, hasPaymentMethod, freeAllowanceRemaining, pricePence, writerName } = f
  let heading = 'Keep reading'
  let subtext: string
  const buttonLabel = 'Continue reading'
  let showPrice = false
  let suggestCard = false

  // The copy must match what the server will actually do (accrual.ts):
  // card on file → the allowance covers what it can and the rest accrues to
  // the tab (walkthrough A1, 2026-09-24);
  // no card → the read draws on the free allowance, and is REFUSED once the
  // price exceeds what's left (the F3 floor). Never claim an article is
  // "part of your free allowance" when the allowance can't cover it.
  const remainingPounds = (freeAllowanceRemaining / 100).toFixed(2)
  const coveredByAllowance =
    pricePence == null || pricePence <= freeAllowanceRemaining

  const welcomeGiftPounds = signupOffer
    ? (signupOffer.freeAllowancePence / 100).toFixed(2)
    : null
  // At or below the ARRIVAL CAP, the piece is free on arrival (D1). The cap is a
  // dial and never a literal — but it is its OWN dial, and testing against
  // `freeAllowancePence` (which this did until 2026-09-06) is now wrong in the
  // direction that matters: the two are £2 and £5, so a £4 piece would be
  // promised "on the haus" here and then refused by `resolveArrivalGift`, which
  // is the only thing that actually decides. Above the cap this falls to the
  // still-gated copy, which is what the reader will meet.
  const withinArrivalCap =
    signupOffer != null &&
    pricePence != null &&
    pricePence <= signupOffer.arrivalGiftCapPence

  // `formatPrice`, not `formatPence`: this is a price inside a sentence, and
  // "£0.50 to keep reading" reads as a form field. Falls back to the
  // already-formatted pounds string, then to no price at all — a gate with an
  // unknown price still has to say something, and "Keep reading." is it.
  const priceLabel =
    pricePence != null ? formatPrice(pricePence) : f.pricePounds ? `£${f.pricePounds}` : null
  const keepReading = priceLabel ? `${priceLabel} to keep reading.` : 'Keep reading.'

  if (!isLoggedIn && !signupOffer) {
    // Closed beta (CLOSED-BETA-ADR §IV): no public signup. A logged-out reader
    // on a shared paywalled article joins the waiting list rather than being
    // offered an account that can't be created — but LOGGING IN was never
    // closed, and this branch is the one that is live on production today, so
    // it is the one where the missing way in cost the most.
    //
    // ALSO THE ANSWER WHEN THE PROBE DIDN'T RESOLVE. `signupOffer` is null both
    // for "the beta is closed" and for "we could not find out", on purpose: the
    // one thing worse than not making the offer is making it and then 403ing
    // the reader who accepted it.
    heading = `${keepReading} Log in to all.haus.`
    subtext = 'New accounts are invitation-only while we’re in closed beta.'
  } else if (!isLoggedIn && withinArrivalCap) {
    // THE SENTENCE THAT DOES THE CONVERTING (§8.4, ruled 2026-09-03: name the
    // gift at the gate). An offer stated where the reader is standing is what
    // converts; a surprise is worth less than a reason. The modal on the other
    // side then confirms it rather than revealing it.
    heading = `${keepReading} Log in or sign up to all.haus.`
    subtext = `Make an account and this one’s on the haus — plus a free £${welcomeGiftPounds} reading allowance to get you started.`
  } else if (!isLoggedIn) {
    // Above the cap (D3). The gift survives whole, by refusal rather than by
    // arithmetic: a card-less read the allowance can't cover is declined at the
    // F3 floor, so the piece stays gated and the £5 was never reachable. Do NOT
    // "improve" this to applying the gift and charging the remainder — that
    // spends the entire welcome on the single most expensive article the reader
    // will meet, which is the opposite of what the gift is for.
    //
    // THE COPY LEADS WITH THE GIFT AND THEN DECLINES TO SPEND IT, which is the
    // honest order: the allowance is real and this piece is simply outside it. It
    // no longer says "add a card", and it does not need to — a signup cannot
    // carry one (`SignupSchema` is two strings; the card lives behind an
    // authenticated route), so the card is never this screen's next step. What
    // happens is that they sign up, land on the piece still gated, and meet the
    // LOGGED-IN card-less branch below, which owns that instruction and states
    // it with their real remaining figure ("costs more than your remaining free
    // allowance … Add a payment card"). Two screens, each saying the true thing at
    // the moment it is actionable — rather than one screen promising a step the
    // reader cannot yet take.
    heading = `${keepReading} Log in or sign up to all.haus.`
    subtext = `Make an account and get a free £${welcomeGiftPounds} reading allowance. That said, this particular article is priced above it, so this one you’d be buying from the writer outright. Wonder what makes it so special.`
  } else if (hasPaymentMethod && freeAllowanceRemaining > 0 && pricePence != null && pricePence <= freeAllowanceRemaining) {
    // A card holder spends what is left of the allowance first (walkthrough
    // A1), so a piece it covers costs them nothing and puts nothing on the tab.
    subtext = `This article is covered by your free reading allowance. You have £${remainingPounds} remaining.`
  } else if (hasPaymentMethod) {
    // THE PURCHASE POINT NAMES THE SELLER (Reader Terms 1.1). This is the one
    // screen where the reader decides to buy, and it said only that a figure
    // would appear on a tab — the platform the only party in the sentence. The
    // contract is with the Writer; we conclude it on their behalf.
    const seller = writerName ? `You’re buying this from ${writerName}.` : 'You’re buying this from its writer.'
    // What is left of the allowance goes first, and the sentence says how much
    // of the price actually reaches the tab — the big figure below stays the
    // list price, which is what the piece costs.
    subtext = freeAllowanceRemaining > 0 && pricePence != null
      ? `${seller} Your remaining free allowance (£${remainingPounds}) covers part of it; we collect the other ${formatPrice(pricePence - freeAllowanceRemaining)} on their behalf, on your reading tab.`
      : `${seller} We collect it on their behalf, on your reading tab.`
    showPrice = true
  } else if (freeAllowanceRemaining > 0 && coveredByAllowance) {
    subtext = `This article is covered by your free reading allowance. You have £${remainingPounds} remaining.`
  } else if (freeAllowanceRemaining > 0) {
    subtext = `This article costs more than your remaining free allowance (£${remainingPounds}). Add a payment card to keep reading — you only pay for what you read.`
    showPrice = true
    suggestCard = true
  } else {
    subtext = 'You’ve used your free reading allowance. Add a payment card to keep reading — you only pay for what you read.'
    showPrice = true
    suggestCard = true
  }

  return { heading, subtext, buttonLabel, showPrice, suggestCard }
}

/** The one button once the Reader Terms refusal has replaced the unlock. */
export const PAYWALL_ACCEPT_AND_CONTINUE = 'Accept and continue'

/** Where a card is the fix; "add" is wrong for somebody replacing a dead card. */
export function paywallCardLink(hasPaymentMethod: boolean): string {
  return hasPaymentMethod ? 'Update your card' : 'Add a payment card'
}

/** The subscribe offer under the gate, as its three parts (the price is bold). */
export function paywallSubscribeOffer(writer: string, pricePence: number): { before: string; price: string; after: string } {
  return {
    before: `Or subscribe to ${writer} for `,
    price: `£${(pricePence / 100).toFixed(2)}/mo`,
    after: ' to read everything',
  }
}

export const PAYWALL_SUBSCRIBE = 'Subscribe'

/** The gate pass answered, but no ciphertext came with it. The read is recorded. */
export const PAYWALL_NO_CIPHERTEXT = 'Could not find the encrypted content. Try again — you won’t be charged twice.'

/** The key unwrap or the decrypt failed after the gate pass recorded the read. */
export const PAYWALL_AFTER_PAYMENT = 'Unlocking failed after payment was recorded. Try again — you won’t be charged twice.'

/** After the unlock that spent the last of the allowance (`allowanceJustExhausted`). */
export const ALLOWANCE_SPENT_LEAD =
  'That was the last of your free reading allowance — the writers’ welcome to the house, and it was a gift, so there is nothing to settle.'
export const ALLOWANCE_SPENT_NEXT =
  'From here, add a card and you buy what you read from the writer, a piece at a time. We collect it on their behalf in one go rather than charging you per article, and nearly all of it goes to the person who wrote the thing.'

/** The signed-out gate's ways in. */
export const PAYWALL_LOG_IN = 'Log in'
export const PAYWALL_SIGN_UP = 'Sign up'
export const PAYWALL_WAITLIST = 'Join the waiting list'
