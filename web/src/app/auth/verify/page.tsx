'use client'

import { useState, useEffect, Suspense, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { auth } from '../../../lib/api'
import { useAuth } from '../../../stores/auth'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  PublicButton,
  IndeterminateSlab,
} from '../../../components/public/Field'
import {
  VERIFY_FAILED_TITLE,
  VERIFY_EXPIRED,
  VERIFY_NO_TOKEN,
  VERIFY_REQUEST_NEW,
} from '../../../content/auth'

// =============================================================================
// Magic Link Verification — /auth/verify?token=<token>
//                  and email change — /auth/verify?emailChange=<token>
//
// On mount: extract the token, POST /auth/verify, hydrate the session and
// REPLACE straight to the piece they came for — or the workspace when there
// isn't one. On failure, offer a fresh link.
//
// `replace`, not `push`: a consumed one-time token is not somewhere Back should
// be able to return to.
//
// `?arrival=<dTag>` IS THE ONE CARRIER THAT SURVIVES A DIFFERENT DEVICE, which
// is why it rides the emailed URL (PAYWALL-ARRIVAL §5). It is also the classic
// open-redirect shape — an emailed value ending in a client-side navigation —
// so the rule is absolute: THIS PAGE RECONSTRUCTS `/article/<dTag>` FROM AN
// IDENTIFIER. It never navigates to a string it was handed, which is what makes
// carrying the d-tag rather than a path the whole of the defence.
//
// WHO IT CARRIES IS A MEMBER, NOT A NEW ACCOUNT (§11.5). Magic link creates
// nothing, so this arm serves someone who already has an account and met the
// gate logged out. They land on the piece — that is what they came for — and
// get no gift and no welcome, both of which are gated on `arrival_article_id`,
// a fact stamped at account creation and therefore false for them.
//
// REDESIGNED 2026-07-25. This page had drifted furthest of any in the register:
// `font-sans text-xl font-bold` headings (a type role that exists nowhere else
// in the app — the house is serif for claims, mono for prose), a `border-2`
// spinning ring, and a `bg-green-100 / text-green-600` tick lifted straight
// from Tailwind's default palette. All three are gone.
//
// THERE IS NO SPINNER. The house has no spinner and does not want one: a
// spinning ring is a radius, an animation and a borrowed idiom all at once. The
// waiting state is a crimson slab that grows across the card — the same 4px
// weight as every other line here, doing the one thing a progress indicator
// actually has to do. It is indeterminate, so it loops; `prefers-reduced-motion`
// holds it still at full width and lets the text carry the state.
//
// SUCCESS IS NOT A TICK — AND SINCE 2026-09-04 IT IS NOT A WORD EITHER. The
// tick glyph in a coloured disc went first (it was the app's only iconographic
// state badge, with no siblings to be consistent with); the card that replaced
// it has now gone too. Success here is the redirect and nothing else. See the
// note in `verify()` for why: the sentence it printed was a promise this page
// could only sometimes keep.
//
// `?emailChange=` IS THE OTHER LINK THIS PAGE RECEIVES. The change-email route
// (gateway `POST /auth/change-email`) mails `/auth/verify?emailChange=<token>`,
// and until 2026-09-28 this page read only `?token` — so every confirmation
// landed on "missing its token" and no email change could ever complete. That
// arm is not a login: it creates no session (a device already signed in to this
// account keeps its own; every other one is signed out by the change), so it ends on the word rather than
// a redirect (there is nowhere it was going), and a refusal points back to
// Settings, where a new link is asked for, rather than to the login form.
// =============================================================================

function VerifyPageBody() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { fetchMe } = useAuth()
  // No 'success' state: verification either navigates away or reports a
  // failure, so there is no third thing for this page to be.
  // …except for an email change, which has no destination and so ends on the
  // word ('changed').
  const [status, setStatus] = useState<'verifying' | 'changed' | 'error'>('verifying')
  const [errorMessage, setErrorMessage] = useState('')
  const [isEmailChange, setIsEmailChange] = useState(false)
  // The token this page has already spent (CA-E13c). Both tokens are
  // single-use, and an effect that runs twice for one link (StrictMode's dev
  // double-invoke, a searchParams identity change) spends it twice: the loser
  // 401s and flashes the expired card before the winner's navigation lands.
  const spent = useRef<string | null>(null)

  useEffect(() => {
    const emailChange = searchParams.get('emailChange')
    const once = emailChange ?? searchParams.get('token')
    if (once && spent.current === once) return
    spent.current = once
    if (emailChange) {
      setIsEmailChange(true)
      void (async () => {
        try {
          await auth.verifyEmailChange(emailChange)
          // Refresh the session's copy of the address, if there is a session.
          // fetchMe swallows its own 401, so a logged-out click still lands here.
          await fetchMe()
          setStatus('changed')
        } catch (err: any) {
          setStatus('error')
          if (err.status === 400) {
            setErrorMessage('This link has expired or has already been used. You can ask for a new one in Settings, under Email.')
          } else if (err.status === 409) {
            setErrorMessage('That address now belongs to another account, so the change was cancelled.')
          } else {
            setErrorMessage('Something went wrong. Please try again.')
          }
        }
      })()
      return
    }

    const token = searchParams.get('token')
    const arrival = searchParams.get('arrival')
    if (!token) {
      setStatus('error')
      setErrorMessage(VERIFY_NO_TOKEN)
      return
    }

    async function verify() {
      try {
        await auth.verify(token!)
        await fetchMe()
        // STRAIGHT THERE, WITH NOTHING SAID. There was a success card here
        // ("You're in." / "Taking you back to your reading.") on an 800ms
        // delay, and it was wrong in both halves: the delay put a beat of
        // ceremony between a reader and the thing they asked for, and the
        // sentence promised a return this page could only sometimes make —
        // printed unconditionally, including on the ordinary login where there
        // is no piece and the destination is the workspace. Getting somebody
        // where they were going is not an event that needs announcing; saying
        // so and then not doing it is the failure. Removed 2026-09-04.
        router.replace(arrival ? `/article/${encodeURIComponent(arrival)}` : '/reader')
      } catch (err: any) {
        setStatus('error')
        if (err.status === 401) {
          setErrorMessage(VERIFY_EXPIRED)
        } else {
          setErrorMessage('Something went wrong. Please try again.')
        }
      }
    }

    void verify()
  }, [searchParams, router, fetchMe])

  return (
    <PublicShell>
      <PublicVessel>
        {status === 'verifying' && (
          <>
            <PublicCard>
              <PublicTitle>{isEmailChange ? 'Changing your email' : 'Logging you in'}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>Checking your link.</PublicBody>
              </div>
            </PublicCard>
            <PublicCard style={{ padding: 0 }}>
              <IndeterminateSlab />
            </PublicCard>
          </>
        )}

        {status === 'changed' && (
          <>
            <PublicCard>
              <PublicTitle>Email changed</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>Your account now uses the new address. Every other device has been logged out, and we've written to your old address to tell it.</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/reader">
                Continue
              </PublicButton>
            </PublicCard>
          </>
        )}

        {status === 'error' && (
          <>
            <PublicCard>
              <PublicTitle>{VERIFY_FAILED_TITLE}</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{errorMessage}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              {isEmailChange ? (
                <PublicButton full href="/settings">
                  Go to Settings
                </PublicButton>
              ) : (
                <PublicButton full href="/auth?mode=login">
                  {VERIFY_REQUEST_NEW}
                </PublicButton>
              )}
            </PublicCard>
          </>
        )}
      </PublicVessel>
    </PublicShell>
  )
}

// useSearchParams() bails this subtree out to client rendering; the boundary
// keeps that bail-out to the page instead of the whole route (CA-F13).
export default function VerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyPageBody />
    </Suspense>
  )
}
