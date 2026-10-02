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
import { TermsConsent } from '../../../components/legal/TermsConsent'
import { auth as authApi } from '../../../lib/api/auth'
import { mapSubscribeError } from '../../../lib/subscribe-errors'
import { TERMS_PURPOSE, termsVersionMismatch, TERMS_ACCEPT_FAILED } from '../../../content/terms-consent'
import {
  OFFER_FOR_YOU_TITLE,
  OFFER_FOR_YOU_BODY,
  OFFER_FOR_YOU_ACTION,
  OFFER_UNAVAILABLE_TITLE,
  OFFER_SUBSCRIBED_TITLE,
  offerSubscribedBody,
  offerKind,
  offerWriterLead,
  offerWasPrice,
  offerPrice,
  offerDiscount,
  offerTerms,
  OFFER_SIGN_IN,
  offerButton,
  offerLookupMessage,
  OFFER_LOAD_FAILED,
  OFFER_RETRY,
} from '../../../content/subscribe-offer'
import { SUBSCRIBE_ACCEPT } from '../../../content/ledger'

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
//
// THE READER TERMS (§0z item 5). A card-holder who registered before the text
// existed meets a 403 here, the same one the paywall gate meets; the consent
// takes the button's card, REPLACING the button, and accepting re-sends the
// press. The control is the house's one `TermsConsent`, wearing this
// register's colours through its `tone` seam.
// =============================================================================

export default function RedeemOfferPage() {
  const params = useParams<{ code: string }>()
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const palette = usePublicPalette()

  const [offer, setOffer] = useState<OfferLookup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The lookup got no answer (network, 5xx) — an outage, not a refusal, so the
  // page offers a retry rather than a way home.
  const [lookupOutage, setLookupOutage] = useState(false)
  const [lookupAttempt, setLookupAttempt] = useState(0)
  // A grant offer names one recipient, so a logged-out visitor cannot be
  // resolved and the lookup 401s (§1.10). That is the COMMON arrival — the
  // recipient following the link from their notification — so it gets its own
  // state and a log-in CTA rather than falling into the dead-end error card.
  const [needsLogin, setNeedsLogin] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [success, setSuccess] = useState(false)
  const [needsTerms, setNeedsTerms] = useState(false)
  const [termsChecked, setTermsChecked] = useState(false)
  const [acceptingTerms, setAcceptingTerms] = useState(false)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setLookupOutage(false)
      try {
        const result = await subscriptionOffers.lookup(params.code)
        setOffer(result)
        setNeedsLogin(false)
      } catch (err) {
        if ((err as { status?: number })?.status === 401) {
          setNeedsLogin(true)
        } else {
          // By STATUS, never `err.message` (CA-E2): an `ApiError` is an Error
          // whose message is `API error 404: {"error":…}`, and that rendered
          // on the page. A 404 is worded here, a 410 carries the route's own
          // sentence, and anything else is an outage with a retry.
          const mapped = offerLookupMessage(err)
          setError(mapped.body)
          setLookupOutage(mapped.outage)
        }
      } finally {
        setLoading(false)
      }
    })()
    // Not keyed on auth: the lookup carries the session cookie whether or not
    // the auth store has resolved yet, so the gateway already sees the viewer
    // on the first call. Logging in remounts this page anyway.
  }, [params.code, lookupAttempt])

  async function handleSubscribe() {
    if (!offer || !user) return
    setSubscribing(true)
    setError(null)
    try {
      await subscribe(offer.writerId, { offerCode: params.code })
      setSuccess(true)
      setTimeout(() => router.push(`/${offer.writerUsername}`), 2000)
    } catch (err) {
      // One mapper for every subscribe surface (lib/subscribe-errors.ts) —
      // this used to read ANY 402 as "add a card", which is wrong for the
      // card-holder whose card declined, and render `err.message`, which on an
      // ApiError is the raw "API error 410: {…}" string.
      const view = mapSubscribeError(err)
      if (view.needsTerms) {
        setNeedsTerms(true)
        return
      }
      setError(view.message)
    } finally {
      setSubscribing(false)
    }
  }

  // Accept, then resume the press — the paywall gate's shape. The version is
  // the server's own `current`; `/auth/me` is refreshed before the retry; a
  // refused acceptance is shown and the reader is asked again.
  async function handleAcceptTerms() {
    const version = user?.terms.reader.current
    if (!version) return
    setAcceptingTerms(true)
    setError(null)
    try {
      await authApi.acceptTerms('reader', version)
      await useAuth.getState().fetchMe()
      setNeedsTerms(false)
      setTermsChecked(false)
      await handleSubscribe()
    } catch (err) {
      const code = (err as { body?: { error?: string } })?.body?.error
      setError(
        code === 'terms_version_mismatch'
          ? termsVersionMismatch('reader')
          : TERMS_ACCEPT_FAILED,
      )
      await useAuth.getState().fetchMe()
    } finally {
      setAcceptingTerms(false)
    }
  }

  if (loading || authLoading) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard style={{ padding: 0 }}>
            <IndeterminateSlab />
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
            <PublicTitle>{OFFER_FOR_YOU_TITLE}</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                {OFFER_FOR_YOU_BODY}
              </PublicBody>
            </div>
          </PublicCard>
          <PublicCard>
            <PublicButton
              full
              href="/auth?mode=login"
            >
              {OFFER_FOR_YOU_ACTION}
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
            <PublicTitle>{lookupOutage ? OFFER_LOAD_FAILED : OFFER_UNAVAILABLE_TITLE}</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                {lookupOutage ? (
                  <PublicLink onClick={() => setLookupAttempt((n) => n + 1)}>
                    {OFFER_RETRY}
                  </PublicLink>
                ) : (
                  error
                )}
              </PublicBody>
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

  const isFree = offer.discountedPricePence === 0
  const writerName = offer.writerDisplayName ?? offer.writerUsername

  if (success) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>{OFFER_SUBSCRIBED_TITLE}</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>
                {offerSubscribedBody(writerName)}
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
            {offerKind(offer)}
          </div>
          <PublicTitle>{offer.label}</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {offerWriterLead(offer)}
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
                {offerWasPrice(offer)}
              </span>
            )}
            <span
              className="font-serif font-medium tracking-tight"
              style={{ fontSize: 34, lineHeight: 1, color: palette.cardTitle }}
            >
              {offerPrice(offer)}
            </span>
            {!offer.isComp && (
              <span className="label-ui" style={{ color: palette.crimson }}>
                {offerDiscount(offer)}
              </span>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            <PublicBody>
              {offerTerms(offer)}
            </PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          {!user ? (
            <PublicButton
              full
              href="/auth?mode=login"
            >
              {OFFER_SIGN_IN}
            </PublicButton>
          ) : needsTerms ? (
            <>
              <TermsConsent
                kind="reader"
                checked={termsChecked}
                onChange={setTermsChecked}
                purpose={TERMS_PURPOSE.subscribe}
                state={user.terms.reader}
                disabled={acceptingTerms}
                tone={{ text: palette.cardStandfirst, link: palette.cardTitle }}
              />
              <PublicButton
                full
                disabled={!termsChecked || acceptingTerms || subscribing}
                onClick={handleAcceptTerms}
              >
                {acceptingTerms || subscribing ? 'Subscribing…' : SUBSCRIBE_ACCEPT}
              </PublicButton>
            </>
          ) : (
            <PublicButton full disabled={subscribing} onClick={handleSubscribe}>
              {subscribing
                ? 'Subscribing…'
                : offerButton(offer)}
            </PublicButton>
          )}
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
