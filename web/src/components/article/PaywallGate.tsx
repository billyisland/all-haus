'use client'

import { useState, useEffect, useRef } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { TermsConsent } from '../legal/TermsConsent'
import type { TermsState } from '../../lib/api/auth'
import { TERMS_PURPOSE } from '../../content/terms-consent'
import {
  paywallGateCopy,
  PAYWALL_ACCEPT_AND_CONTINUE,
  paywallCardLink,
  paywallSubscribeOffer,
  PAYWALL_SUBSCRIBE,
  PAYWALL_LOG_IN,
  PAYWALL_SIGN_UP,
  PAYWALL_WAITLIST,
} from '../../content/paywall'

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
  /** The gate's third refusal: a card-holder who has never seen the Reader
   *  Terms. Neither money nor a card is the fix, so it gets its own control. */
  errorNeedsTerms?: boolean
  readerTerms?: TermsState | null
  onAcceptTerms?: () => void
  acceptingTerms?: boolean
  writerUsername?: string
  writerName?: string
  subscriptionPricePence?: number
  isSubscribed?: boolean
  onSubscribe?: () => void
  subscribing?: boolean
  writerSpendThisMonthPence?: number
  writerId?: string
}

export function PaywallGate({
  pricePounds, pricePence, dTag, signupOffer,
  freeAllowanceRemaining, hasPaymentMethod, isLoggedIn,
  onUnlock, unlocking, error, errorNeedsCard,
  errorNeedsTerms, readerTerms, onAcceptTerms, acceptingTerms,
  writerUsername, writerName, subscriptionPricePence, isSubscribed,
  onSubscribe, subscribing,
  writerSpendThisMonthPence, writerId,
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
  const { heading, subtext, buttonLabel, showPrice, suggestCard } = paywallGateCopy({
    isLoggedIn,
    signupOffer: signupOffer ?? null,
    hasPaymentMethod,
    freeAllowanceRemaining,
    pricePence: pricePence ?? null,
    pricePounds,
    writerName,
  })

  // Both logged-out controls carry the arrival intent, and it travels as the
  // article's IDENTIFIER rather than a path or a price (PAYWALL-ARRIVAL §5):
  // the price is looked up server-side because a client-supplied one is a
  // free-money endpoint, and each terminus rebuilds `/article/<dTag>` rather
  // than navigating to a string it was handed. `/auth` already takes the same
  // param and threads it through both the magic link and the Google button, so
  // a MEMBER who logs in here lands back on the piece — with no gift and no
  // welcome, both of which are gated server-side on `arrival_article_id`.
  const arrivalQs = dTag ? `?arrival=${encodeURIComponent(dTag)}` : ''

  const showSubscribeOption = isLoggedIn && !isSubscribed && subscriptionPricePence && subscriptionPricePence > 0
  const subPricePounds = subscriptionPricePence ? (subscriptionPricePence / 100).toFixed(2) : null
  const subscribeOffer = paywallSubscribeOffer(writerName ?? writerUsername ?? '', subscriptionPricePence ?? 0)

  // The spend note: what this reader has actually paid this writer this
  // month, set beside the subscription price once it is most of the way
  // there. It STATES and promises nothing — the copy that said the spend
  // "converts to your first month" described a conversion route that was a
  // documented money pump, dark behind a do-not-flip flag, and was deleted
  // 2026-09-29 (CA-I6) together with the one-shot nudge log that throttled
  // this paragraph.
  const spendPounds = writerSpendThisMonthPence != null
    ? (writerSpendThisMonthPence / 100).toFixed(2)
    : null
  const showSpendNote = writerSpendThisMonthPence != null && subscriptionPricePence != null
    && writerSpendThisMonthPence >= subscriptionPricePence * 0.7

  const gateRef = useRef<HTMLDivElement>(null)
  const [animateEllipsis, setAnimateEllipsis] = useState(false)
  // Never pre-ticked, and reset by nothing: the gate only ever shows this
  // control once, in response to a refusal the reader has just met.
  const [termsChecked, setTermsChecked] = useState(false)

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

        {/* THE TERMS REFUSAL REPLACES THE UNLOCK BUTTON, it does not sit beside
            it. Two primary actions on one gate — "accept" and "continue" —
            would let a reader press the one that cannot work, and the press
            they already made is what the acceptance resumes: accepting IS
            continuing, so there is one button and it says so. */}
        {isLoggedIn && errorNeedsTerms && onAcceptTerms ? (
          <div className="max-w-sm mx-auto text-left">
            <TermsConsent
              kind="reader"
              checked={termsChecked}
              onChange={setTermsChecked}
              purpose={TERMS_PURPOSE.read}
              state={readerTerms ?? null}
              disabled={acceptingTerms}
            />
            <div className="text-center">
              <button
                onClick={onAcceptTerms}
                disabled={!termsChecked || acceptingTerms}
                className="btn-accent disabled:opacity-50"
              >
                {acceptingTerms ? 'Unlocking…' : PAYWALL_ACCEPT_AND_CONTINUE}
              </button>
            </div>
          </div>
        ) : isLoggedIn ? (
          <button onClick={onUnlock} disabled={unlocking} className="btn-accent disabled:opacity-50">
            {unlocking ? 'Unlocking…' : buttonLabel}
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
              {PAYWALL_LOG_IN}
            </a>
            {signupOffer ? (
              <a href={`/auth/signup${arrivalQs}`} className="btn inline-block">
                {PAYWALL_SIGN_UP}
              </a>
            ) : (
              // `title` only, not `aria-label`: the aside is a hover reward, and
              // the accessible name should stay the plain thing the link does.
              <a href="/waitlist" title={WAITLIST_HOVER} className="btn inline-block">
                {PAYWALL_WAITLIST}
              </a>
            )}
          </div>
        )}

        {/* Card affordance whenever a card is the fix (pre-empted by the copy
            above, or surfaced by a 402 from the unlock attempt). Links to the
            Settings overlay; a full-page hop lands back in the workspace.

            IT ALSO RENDERS FOR A READER WHO HAS A CARD, and it did not until
            the tab's own refusals existed. `card_action_required` reaches only
            card-HOLDERS — their card declined terminally — so the old
            `!hasPaymentMethod` term switched the link off for exactly the
            reader the refusal was written for: told to add a working card, on a
            page with no way to get to one. The label changes with the act,
            because "add" is wrong for someone replacing a dead card. */}
        {isLoggedIn && (errorNeedsCard || (!hasPaymentMethod && suggestCard)) && (
          <div className="mt-4">
            <a href="/reader?overlay=settings" className="btn-text">
              {paywallCardLink(hasPaymentMethod)} →
            </a>
          </div>
        )}

        {/* Subscribe option */}
        {showSubscribeOption && (
          <div className="mt-6 pt-6 max-w-sm mx-auto" style={{ borderTop: '4px solid var(--ah-grey-100)' }}>
            <p className="font-sans text-ui-sm text-grey-600 mb-4">
              {subscribeOffer.before}<strong>{subscribeOffer.price}</strong>{subscribeOffer.after}
            </p>
            {onSubscribe ? (
              <button
                onClick={onSubscribe}
                disabled={subscribing}
                className="btn disabled:opacity-50"
              >
                {subscribing ? 'Subscribing…' : PAYWALL_SUBSCRIBE}
              </button>
            ) : writerUsername ? (
              <ProfileLink href={`/${writerUsername}`} className="btn inline-block">
                {PAYWALL_SUBSCRIBE}
              </ProfileLink>
            ) : null}

            {/* The spend note (see above) */}
            {showSpendNote && spendPounds && subPricePounds && (
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
