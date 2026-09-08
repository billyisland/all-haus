'use client'

import { useState, useEffect, useRef } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { formatPrice } from '../../lib/format'

// The hover aside on every "join the waiting list" affordance. One constant so
// the gate's and the nav bar's cannot drift into two different jokes.
export const WAITLIST_HOVER = 'Cool-guys club (waiting list)'

interface PaywallGateProps {
  pricePounds: string | null
  pricePence?: number | null
  /** The piece's own d-tag, so the logged-out CTA can carry the arrival intent
   *  into the signup form. An IDENTIFIER, never a path (PAYWALL-ARRIVAL §5). */
  dTag?: string
  /** What a new account comes with, or null for "none can be made" — which is
   *  also what an unresolved probe answers, deliberately (`signupOffer`). */
  signupOffer?: { freeAllowancePence: number; arrivalGiftCapPence: number } | null
  freeAllowanceRemaining: number
  hasPaymentMethod: boolean
  isLoggedIn: boolean
  onUnlock: () => void
  unlocking: boolean
  error: string | null
  errorNeedsCard?: boolean
  writerUsername?: string
  writerName?: string
  subscriptionPricePence?: number
  isSubscribed?: boolean
  onSubscribe?: () => void
  subscribing?: boolean
  writerSpendThisMonthPence?: number
  nudgeShownThisMonth?: boolean
  writerId?: string
}

export function PaywallGate({
  pricePounds, pricePence, dTag, signupOffer,
  freeAllowanceRemaining, hasPaymentMethod, isLoggedIn,
  onUnlock, unlocking, error, errorNeedsCard,
  writerUsername, writerName, subscriptionPricePence, isSubscribed,
  onSubscribe, subscribing,
  writerSpendThisMonthPence, nudgeShownThisMonth, writerId,
}: PaywallGateProps) {
  // THE GATE IS AGNOSTIC BETWEEN A STRANGER AND A MEMBER WHO IS LOGGED OUT,
  // and it was not (2026-09-04). Every logged-out variant offered exactly one
  // way forward — sign up, or the waiting list — while PAYWALL-ARRIVAL §11.5
  // had already established that a returning member is who half this gate's
  // traffic is the day the beta opens. They met a wall that only spoke to
  // people without an account. So the heavy line names both ways in and the
  // control row carries both, at equal weight.
  //
  // THE HEADING NOW CARRIES THE PRICE, which retires the 40pt display for
  // logged-out readers (`showPrice` stays false on all three branches below).
  // §8.4 ruled the below-cap gate must not stand a £0.30 in 40pt type under an
  // offer of a free read; naming the price mid-sentence keeps the fact and
  // drops the drama, and it means the above-cap variant no longer states the
  // price twice.
  let heading = 'Keep reading'
  let subtext: string
  const buttonLabel = 'Continue reading'
  let showPrice = false
  let suggestCard = false

  // The copy must match what the server will actually do (accrual.ts):
  // card on file → the read accrues to the tab (allowance untouched);
  // no card → the read draws on the free credit, and is REFUSED once the
  // price exceeds what's left (the F3 floor). Never claim an article is
  // "part of your free allowance" when the credit can't cover it.
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
    pricePence != null ? formatPrice(pricePence) : pricePounds ? `£${pricePounds}` : null
  const keepReading = priceLabel ? `${priceLabel} to keep reading.` : 'Keep reading.'

  // Both logged-out controls carry the arrival intent, and it travels as the
  // article's IDENTIFIER rather than a path or a price (PAYWALL-ARRIVAL §5):
  // the price is looked up server-side because a client-supplied one is a
  // free-money endpoint, and each terminus rebuilds `/article/<dTag>` rather
  // than navigating to a string it was handed. `/auth` already takes the same
  // param and threads it through both the magic link and the Google button, so
  // a MEMBER who logs in here lands back on the piece — with no gift and no
  // welcome, both of which are gated server-side on `arrival_article_id`.
  const arrivalQs = dTag ? `?arrival=${encodeURIComponent(dTag)}` : ''

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
    subtext = `Make an account and this one’s on the haus — plus a free £${welcomeGiftPounds} reading credit to get you started.`
  } else if (!isLoggedIn) {
    // Above the cap (D3). The gift survives whole, by refusal rather than by
    // arithmetic: a card-less read the allowance can't cover is declined at the
    // F3 floor, so the piece stays gated and the £5 was never reachable. Do NOT
    // "improve" this to applying the gift and charging the remainder — that
    // spends the entire welcome on the single most expensive article the reader
    // will meet, which is the opposite of what the gift is for.
    //
    // THE COPY LEADS WITH THE GIFT AND THEN DECLINES TO SPEND IT, which is the
    // honest order: the credit is real and this piece is simply outside it. It
    // no longer says "add a card", and it does not need to — a signup cannot
    // carry one (`SignupSchema` is two strings; the card lives behind an
    // authenticated route), so the card is never this screen's next step. What
    // happens is that they sign up, land on the piece still gated, and meet the
    // LOGGED-IN card-less branch below, which owns that instruction and states
    // it with their real remaining figure ("costs more than your remaining free
    // credit … Add a payment card"). Two screens, each saying the true thing at
    // the moment it is actionable — rather than one screen promising a step the
    // reader cannot yet take.
    heading = `${keepReading} Log in or sign up to all.haus.`
    subtext = `Make an account and get £${welcomeGiftPounds} of free reading credit. That said, this particular article is priced quite punchily so we’ll have to bill you for it separately. Wonder what makes it so special.`
  } else if (hasPaymentMethod) {
    subtext = 'This will be added to your reading tab.'
    showPrice = true
  } else if (freeAllowanceRemaining > 0 && coveredByAllowance) {
    subtext = `This article is part of your free reading credit. You have £${remainingPounds} remaining.`
  } else if (freeAllowanceRemaining > 0) {
    subtext = `This article costs more than your remaining free credit (£${remainingPounds}). Add a payment card to keep reading — you only pay for what you read.`
    showPrice = true
    suggestCard = true
  } else {
    subtext = 'You’ve used your free reading credit. Add a payment card to keep reading — you only pay for what you read.'
    showPrice = true
    suggestCard = true
  }

  const showSubscribeOption = isLoggedIn && !isSubscribed && subscriptionPricePence && subscriptionPricePence > 0
  const subPricePounds = subscriptionPricePence ? (subscriptionPricePence / 100).toFixed(2) : null

  // Subscription nudge logic
  const spendPounds = writerSpendThisMonthPence != null
    ? (writerSpendThisMonthPence / 100).toFixed(2)
    : null
  const meetsThreshold = writerSpendThisMonthPence != null && subscriptionPricePence != null
    && writerSpendThisMonthPence >= subscriptionPricePence * 0.7
  const overThreshold = writerSpendThisMonthPence != null && subscriptionPricePence != null
    && writerSpendThisMonthPence > subscriptionPricePence
  const showConversionOffer = meetsThreshold && !overThreshold && !nudgeShownThisMonth
  const showOverThresholdNote = overThreshold

  // Mark nudge as shown (one-shot per reader/writer/month)
  const nudgeMarked = useRef(false)
  useEffect(() => {
    if (showConversionOffer && writerId && !nudgeMarked.current) {
      nudgeMarked.current = true
      fetch('/api/v1/nudge/shown', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writerId }),
      }).catch(err => console.error('Failed to log subscription nudge', err))
    }
  }, [showConversionOffer, writerId])

  const gateRef = useRef<HTMLDivElement>(null)
  const [animateEllipsis, setAnimateEllipsis] = useState(false)

  useEffect(() => {
    const el = gateRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setAnimateEllipsis(true); observer.disconnect() } },
      { threshold: 0.3 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="my-16 -mx-[48px]" ref={gateRef}>
      {/* Gradient fade */}
      <div className="relative h-[100px] -mt-[100px] pointer-events-none" style={{ background: 'linear-gradient(to bottom, transparent, var(--ah-white))' }} />

      <div
        // Explain C1: the paywall gate's own label (reading-tab money copy).
        // Inert outside a pane-mode Explain program.
        data-explain="reader.gate"
        className="px-8 py-12 text-center"
        style={{ borderTop: '4px solid var(--ah-crimson)', borderBottom: '4px solid var(--ah-crimson)' }}
      >
        <h2 className="font-serif text-[26px] font-normal text-black mb-3">{heading}</h2>
        {/* ONE SPACING FOR EVERY VARIANT NOW. The logged-out copy used to end in
            a comma that the single button finished ("...To read pieces like
            this, [Join the waiting list]"), which is why this margin was
            conditional. With two controls there is no sentence to run on into —
            a comma cannot lead into a choice — so every variant is a complete
            sentence that keeps its distance from the row beneath it. */}
        <p className="font-sans text-[15px] text-grey-600 max-w-sm mx-auto leading-[1.6] mb-8">
          {subtext}
        </p>

        {showPrice && pricePounds && (
          <p className="font-serif text-[40px] font-normal text-black mb-6">£{pricePounds}</p>
        )}

        {error && (
          <div className="mb-6 px-4 py-3 text-[12px] font-sans max-w-sm mx-auto bg-grey-100 text-black">
            {error}
          </div>
        )}

        {isLoggedIn ? (
          <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
            {unlocking ? 'Unlocking...' : buttonLabel}
          </button>
        ) : (
          // BOTH WAYS IN, AT EQUAL WEIGHT — two `.btn`, not an accent and a
          // text link. The gate must not rank the stranger above the member
          // who is merely logged out, and the register's one-accent-per-screen
          // rule is the other half of it: `PublicNavBar` already spends this
          // page's single `.btn-accent` on the waiting-list CTA, so the gate's
          // old accent was a second primary on the same screen. Two ink
          // buttons settle both at once.
          <div className="flex flex-wrap gap-3 justify-center">
            <a href={`/auth${arrivalQs}`} className="btn inline-block">
              Log in
            </a>
            {signupOffer ? (
              <a href={`/auth/signup${arrivalQs}`} className="btn inline-block">
                Sign up
              </a>
            ) : (
              // `title` only, not `aria-label`: the aside is a hover reward, and
              // the accessible name should stay the plain thing the link does.
              <a href="/waitlist" title={WAITLIST_HOVER} className="btn inline-block">
                Join the waiting list
              </a>
            )}
          </div>
        )}

        {/* Add-card affordance whenever a card is the fix (pre-empted by the
            copy above, or surfaced by a 402 from the unlock attempt). Links to
            the Settings overlay; a full-page hop lands back in the workspace. */}
        {isLoggedIn && !hasPaymentMethod && (suggestCard || errorNeedsCard) && (
          <div className="mt-4">
            <a href="/reader?overlay=settings" className="btn-text">
              Add a payment card →
            </a>
          </div>
        )}

        {/* Subscribe option */}
        {showSubscribeOption && (
          <div className="mt-6 pt-6 max-w-sm mx-auto" style={{ borderTop: '4px solid var(--ah-grey-100)' }}>
            <p className="font-sans text-ui-sm text-grey-600 mb-4">
              Or subscribe to {writerName ?? writerUsername} for <strong>£{subPricePounds}/mo</strong> to read everything
            </p>
            {onSubscribe ? (
              <button
                onClick={onSubscribe}
                disabled={subscribing}
                className="btn disabled:opacity-50"
              >
                {subscribing ? 'Subscribing...' : 'Subscribe'}
              </button>
            ) : writerUsername ? (
              <ProfileLink href={`/${writerUsername}`} className="btn inline-block">
                Subscribe
              </ProfileLink>
            ) : null}

            {/* Spend-threshold subscription nudge */}
            {showConversionOffer && spendPounds && (
              <p className="mt-4 font-mono text-[12px] text-grey-400">
                You&apos;ve spent £{spendPounds} on {writerName ?? writerUsername} this month. Subscribe now and that spending converts to your first month.
              </p>
            )}
            {showOverThresholdNote && spendPounds && subPricePounds && (
              <p className="mt-4 font-mono text-[12px] text-grey-400">
                You&apos;ve spent £{spendPounds} on {writerName ?? writerUsername} this month. A subscription is £{subPricePounds}/mo.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
