'use client'

import { useState, useEffect, useRef } from 'react'
import { ProfileLink } from '../ui/ProfileLink'

interface PaywallGateProps {
  pricePounds: string | null
  pricePence?: number | null
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
  pricePounds, pricePence, freeAllowanceRemaining, hasPaymentMethod, isLoggedIn,
  onUnlock, unlocking, error, errorNeedsCard,
  writerUsername, writerName, subscriptionPricePence, isSubscribed,
  onSubscribe, subscribing,
  writerSpendThisMonthPence, nudgeShownThisMonth, writerId,
}: PaywallGateProps) {
  const heading = 'Keep reading'
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

  if (!isLoggedIn) {
    // Closed beta (CLOSED-BETA-ADR §IV): no public signup. A logged-out reader
    // on a shared paywalled article joins the waiting list rather than being
    // offered an account that can't be created. Rendered as a /waitlist link
    // below (not the onUnlock button, which assumes an account).
    subtext = 'all.haus is in closed beta. Join the waiting list to read pieces like this.'
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
        <p className="font-sans text-[15px] text-grey-600 max-w-sm mx-auto mb-8 leading-[1.6]">{subtext}</p>

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
          <a href="/waitlist" className="btn-accent inline-block">
            Join the waiting list
          </a>
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
