'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { auth } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { PublicShell } from '../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../components/public/PublicVessel'
import {
  TextField,
  PublicButton,
  PublicLink,
  FormError,
  OrDivider,
} from '../../components/public/Field'
import {
  usePublicPalette,
  controlLine,
  SLAB,
} from '../../components/public/palette'

// Closed beta (CLOSED-BETA-ADR Phase 3, D4). `/auth` is login-only: the signup
// form and the login/signup toggle are gone (account creation is closed
// server-side — D1). Two edge cases route to the waitlist surface instead of
// showing a raw error here:
//   (a) a visitor arriving directly at `/auth?mode=signup`, and
//   (b) a new Google email the gateway refused (`?error=closed_beta`).
//
// REDESIGNED 2026-07-25 onto the public chassis. What went: the black topbar
// above it (deleted sitewide — see LayoutShell), the `max-w-sm` / `py-28`
// centred column on a white page, the `1.5px solid grey-200` input boxes, the
// `.rule` divider with a white-backed "or" knocked out of it, and the ∀ used as
// a decorative dingbat over the confirmation state. The mark now appears once
// per page, in the nav row, where it is also a link home.
//
// THE DEV-MODE BLOCK STAYS but is now a card like any other, marked by a label
// rather than by a dashed border — the house has no dashed line weight, and  hairline-ok (prose: describes the border this file REMOVED)
// inventing one for a development affordance was how the register drifted in
// the first place.
export default function AuthPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const setUser = useAuth((s) => s.setUser)
  const palette = usePublicPalette()

  const wantsSignup = searchParams.get('mode') === 'signup'
  const initialError = searchParams.get('error')
  const redirectingToWaitlist = wantsSignup || initialError === 'closed_beta'

  useEffect(() => {
    if (redirectingToWaitlist) router.replace('/waitlist?from=beta')
  }, [redirectingToWaitlist, router])

  const [error, setError] = useState<string | null>(
    initialError === 'google_denied'
      ? 'Google sign-in was cancelled.'
      : initialError === 'google_failed'
        ? 'Google sign-in didn’t complete. Please try again.'
        : null,
  )
  const [loading, setLoading] = useState(false)
  const [magicLinkSent, setMagicLinkSent] = useState(false)
  const [email, setEmail] = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await auth.login(email)
      setMagicLinkSent(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDevLogin() {
    setLoading(true)
    setError(null)
    try {
      await auth.devLogin(email)
      const me = await auth.me()
      setUser(me)
      router.push('/reader')
    } catch {
      setError('Dev login failed — is that email in the database?')
    } finally {
      setLoading(false)
    }
  }

  // Redirecting to the waitlist — render nothing so the login form never flashes.
  if (redirectingToWaitlist) return null

  if (magicLinkSent) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>Check your email</PublicTitle>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              If an account exists for{' '}
              <span style={{ color: palette.cardTitle }}>{email}</span>, we’ve
              sent a login link. It expires in fifteen minutes.
            </PublicBody>
          </PublicCard>
          <PublicCard>
            <PublicButton
              variant="outline"
              full
              onClick={() => {
                setMagicLinkSent(false)
                setEmail('')
              }}
            >
              Try a different email
            </PublicButton>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Welcome back</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>We’ll send a login link to your email.</PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          <PublicButton variant="outline" full href="/api/v1/auth/google">
            <GoogleMark />
            Continue with Google
          </PublicButton>

          <div style={{ margin: '18px 0' }}>
            <OrDivider />
          </div>

          <form
            onSubmit={handleLogin}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            <TextField
              id="email"
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
            />
            <PublicButton type="submit" full disabled={loading}>
              {loading ? 'Working…' : 'Send login link'}
            </PublicButton>
          </form>
        </PublicCard>

        <PublicCard>
          <PublicBody>
            New here? <PublicLink href="/waitlist">Join the waiting list</PublicLink>
          </PublicBody>
        </PublicCard>

        {process.env.NODE_ENV === 'development' && (
          <PublicCard>
            <div
              className="label-ui"
              style={{
                color: palette.cardMeta,
                marginBottom: 12,
                paddingBottom: 12,
                borderBottom: `${SLAB}px solid ${controlLine(palette)}`,
              }}
            >
              Dev mode
            </div>
            <PublicButton
              variant="outline"
              full
              disabled={loading || !email}
              onClick={handleDevLogin}
            >
              {loading ? 'Working…' : 'Instant login (skip magic link)'}
            </PublicButton>
          </PublicCard>
        )}
      </PublicVessel>
    </PublicShell>
  )
}

// Google's mark is Google's, and its four brand colours are the one place in
// the public register where an off-palette colour is correct: the button is a
// third-party affordance and must be recognisable as one. It is also the ONLY
// such place — every other hard-coded colour in the retired register (the green
// tick on /auth/verify, the blue checkbox accent) was drift, not licence.
function GoogleMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  )
}
