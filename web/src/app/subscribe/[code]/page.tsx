'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ProfileLink } from '../../../components/ui/ProfileLink'
import { useAuth } from '../../../stores/auth'
import {
  subscriptionOffers,
  subscribe,
  type OfferLookup,
} from '../../../lib/api'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  PublicButton,
  PublicLink,
  FormError,
  IndeterminateSlab,
} from '../../../components/public/Field'
import { usePublicPalette } from '../../../components/public/palette'

// =============================================================================
// Offer redeem page — /subscribe/:code
//
// Public landing for a subscription offer code: who the writer is, what the
// discount is, and a button. Redirects to the writer's profile on success.
//
// REDESIGNED 2026-07-25 (tranche 2) onto the public chassis. What went: three
// `animate-pulse` skeleton bars, the `bg-red-50 / text-red-700` error box (the
// only Tailwind-default red left in the register), and the serif ITALIC display
// heading, which appears nowhere else in the app — the house's serif carries
// claims upright.
//
// THE PRICE IS THE PAGE, so it gets its own card and the largest type on it.
// The old-price strike-through stays, ranged beside the new one; the discount
// percentage takes the crimson, which is the one thing on the page that is
// genuinely an accent rather than a fact.
//
// MIXED REGISTER: a member can redeem in place; a visitor is sent to log in
// with a redirect back. Account creation is closed during the beta
// (CLOSED-BETA-ADR D1), so there is no signup path from here.
// =============================================================================

export default function RedeemOfferPage() {
  const params = useParams<{ code: string }>()
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const palette = usePublicPalette()

  const [offer, setOffer] = useState<OfferLookup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // A grant offer names one recipient, so a logged-out visitor cannot be
  // resolved and the lookup 401s (§1.10). That is the COMMON arrival — the
  // recipient following the link from their notification — so it gets its own
  // state and a log-in CTA rather than falling into the dead-end error card.
  const [needsLogin, setNeedsLogin] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        const result = await subscriptionOffers.lookup(params.code)
        setOffer(result)
        setNeedsLogin(false)
      } catch (err) {
        if ((err as { status?: number })?.status === 401) {
          setNeedsLogin(true)
        } else {
          setError(
            err instanceof Error ? err.message : 'This offer is not available.',
          )
        }
      } finally {
        setLoading(false)
      }
    })()
    // Not keyed on auth: the lookup carries the session cookie whether or not
    // the auth store has resolved yet, so the gateway already sees the viewer
    // on the first call. Logging in remounts this page anyway.
  }, [params.code])

  async function handleSubscribe() {
    if (!offer || !user) return
    setSubscribing(true)
    setError(null)
    try {
      await subscribe(offer.writerId, { offerCode: params.code })
      setSuccess(true)
      setTimeout(() => router.push(`/${offer.writerUsername}`), 2000)
    } catch (err) {
      // 402 card_required: subscriptions charge the reading tab, which needs a
      // card on file to be collectable.
      const status = (err as { status?: number })?.status
      setError(
        status === 402
          ? 'Add a payment card in Settings before subscribing.'
          : err instanceof Error
            ? err.message
            : 'Failed to subscribe. Please try again.',
      )
    } finally {
      setSubscribing(false)
    }
  }

  if (loading || authLoading) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard style={{ padding: 0 }}>
            <IndeterminateSlab label="Loading offer" />
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (needsLogin && !offer) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>This one’s addressed to you</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                It’s a gift subscription for a particular account. Log in and
                we’ll show you what it is.
              </PublicBody>
            </div>
          </PublicCard>
          <PublicCard>
            <PublicButton
              full
              href={`/auth?mode=login&redirect=${encodeURIComponent(`/subscribe/${params.code}`)}`}
            >
              Log in to view
            </PublicButton>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (error && !offer) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>This offer isn’t available</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>{error}</PublicBody>
            </div>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              <PublicLink href="/">Back to the front</PublicLink>
            </PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  if (!offer) return null

  const standardDisplay = `\u00A3${(offer.standardPricePence / 100).toFixed(2)}`
  const discountedDisplay = `\u00A3${(offer.discountedPricePence / 100).toFixed(2)}`
  const isFree = offer.discountedPricePence === 0
  const writerName = offer.writerDisplayName ?? offer.writerUsername

  if (success) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>Subscribed.</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                You’re subscribed to {writerName}. Taking you to their profile.
              </PublicBody>
            </div>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <div
            className="label-ui"
            style={{ color: palette.cardMeta, marginBottom: 12 }}
          >
            {offer.mode === 'grant' ? 'A gift for you' : 'Subscription offer'}
          </div>
          <PublicTitle>{offer.label}</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {offer.mode === 'grant' ? 'From ' : 'Subscribe to '}
              <ProfileLink
                href={`/${offer.writerUsername}`}
                className="underline underline-offset-4"
                style={{ color: palette.cardTitle }}
              >
                {writerName}
              </ProfileLink>
            </PublicBody>
          </div>
        </PublicCard>

        <PublicCard>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            {!isFree && (
              <span
                className="font-mono"
                style={{
                  fontSize: 17,
                  color: palette.cardMeta,
                  textDecoration: 'line-through',
                }}
              >
                {standardDisplay}/mo
              </span>
            )}
            <span
              className="font-serif font-medium tracking-tight"
              style={{ fontSize: 34, lineHeight: 1, color: palette.cardTitle }}
            >
              {isFree ? 'Free' : `${discountedDisplay}/mo`}
            </span>
            <span className="label-ui" style={{ color: palette.crimson }}>
              {offer.discountPct}% off
            </span>
          </div>
          <div style={{ marginTop: 14 }}>
            <PublicBody>
              {offer.durationMonths
                ? `Discounted rate for ${offer.durationMonths} month${offer.durationMonths > 1 ? 's' : ''}, then ${standardDisplay}/mo.`
                : 'Permanent rate.'}
            </PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          {!user ? (
            <PublicButton
              full
              href={`/auth?mode=login&redirect=${encodeURIComponent(`/subscribe/${params.code}`)}`}
            >
              Log in to subscribe
            </PublicButton>
          ) : (
            <PublicButton full disabled={subscribing} onClick={handleSubscribe}>
              {subscribing
                ? 'Subscribing…'
                : isFree
                  ? 'Subscribe for free'
                  : `Subscribe for ${discountedDisplay}/mo`}
            </PublicButton>
          )}
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
