'use client'

import { useState, useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { auth } from '../../../lib/api'
import { useAuth } from '../../../stores/auth'
import { ApiError } from '../../../lib/api/client'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import {
  TextField,
  PublicButton,
  PublicLink,
  FormError,
  OrDivider,
} from '../../../components/public/Field'

// =============================================================================
// /auth/signup — the way in.
//
// PAYWALL-ARRIVAL-ADR D9, §11.1. THERE WAS NO SIGNUP SURFACE AT ALL: the route
// existed, its client wrapper existed, and `auth.signup` had zero callers. The
// beta closed the way in by REMOVING it rather than by hiding it, so the flow
// this ADR describes had a missing first step that no decision mentioned —
// which is how it went missing from the list of what to build.
//
// TWO FIELDS, AND THE THIRD IS DERIVED. Email and display name; the username is
// minted server-side by the same `deriveUsername` the Google path has always
// used. A stranger stopped mid-article has a fixed amount of patience and has
// already spent most of it on the piece, and a username field spends what is
// left on a decision they have no basis for making — they have not seen a
// profile, a byline or another member. Its failure mode is a REJECTION (23505
// on a name they typed hopefully) at the one moment in this reader's life with
// us where a rejection costs the most. And the Google button never showed that
// field at all, so leaving it here put two offers on the same page at visibly
// different prices, with the cheaper one handing the account to a third party.
//
// The handle is a DEFAULT, not a decision taken away: the first change is free
// and immediate (`username_changed_at` starts NULL, so the 30-day cooldown has
// not begun) and the old one keeps resolving for 90 days. The welcome sheet
// names it; Settings changes it.
//
// `?arrival=<dTag>` IS THE CARRIER, and on this path it is simply held in the
// browser: `POST /auth/signup` creates the session inside its own request, so
// the browser never leaves and no round trip has to survive. The other two
// termini need real carriers (the signed OAuth state, the emailed URL) and have
// them. What travels is the article's IDENTITY — never its price, which would
// be a free-money endpoint on the one route that must accept unauthenticated
// input by definition, and never a path, which is an open redirect.
//
// CLOSED BETA IS STILL SERVER-SIDE AND STILL AUTHORITATIVE. The gate that sends
// people here only offers the link when `GET /auth/open` says so, but a stale
// tab or a typed URL can still arrive — so a 403 routes to the waiting list
// rather than showing a raw error, exactly as the Google callback does.
// =============================================================================

export default function SignupPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const fetchMe = useAuth((s) => s.fetchMe)

  const arrival = searchParams.get('arrival')

  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    if (closed) router.replace('/waitlist?from=beta')
  }, [closed, router])

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await auth.signup({
        email,
        displayName,
        arrivalDTag: arrival ?? undefined,
      })
      await fetchMe()
      // The terminus RECONSTRUCTS the path from the identifier it holds; it
      // never navigates to a string it was handed. Same rule on all three
      // carriers, and the one that makes the emailed one safe.
      router.replace(arrival ? `/article/${encodeURIComponent(arrival)}` : '/reader')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setClosed(true)
        return
      }
      if (err instanceof ApiError && err.status === 409) {
        // TWO DIFFERENT 409s, AND ONLY ONE OF THEM IS ABOUT THIS FORM.
        //
        // `email_taken` is the reader's to fix and is the whole reason this
        // branch exists. `account_taken` is the OTHER one — the derived-handle
        // uniqueness check losing a race (PAYWALL-ARRIVAL D9), which is nothing
        // the reader typed and nothing they can do anything about. Telling them
        // their email is taken when it is not sends them to a login they cannot
        // complete; the honest answer is that it went wrong and to try again,
        // which for this fault is also the answer that works, since the next
        // attempt derives a fresh handle.
        //
        // The distinction was already MADE server-side, deliberately and with a
        // comment saying why, and then collapsed here by a client that read only
        // the status. A code the server went to the trouble of splitting is one
        // the client has to read.
        setError(
          err.body?.error === 'email_taken'
            ? 'There is already an account with that email. Try logging in instead.'
            : 'Something went wrong setting up your account. Please try again.',
        )
        return
      }
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (closed) return null

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Make an account</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {arrival
                ? 'Two things, and then the piece you were reading.'
                : 'Two things, and no password to remember.'}
            </PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          <PublicButton
            variant="outline"
            full
            href={`/api/v1/auth/google${arrival ? `?arrival=${encodeURIComponent(arrival)}` : ''}`}
          >
            Continue with Google
          </PublicButton>

          <div style={{ margin: '18px 0' }}>
            <OrDivider />
          </div>

          <form
            onSubmit={handleSignup}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            <TextField
              id="signup-email"
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
            />
            <TextField
              id="signup-name"
              label="Your name"
              required
              autoComplete="name"
              value={displayName}
              onChange={setDisplayName}
              placeholder="What people should call you"
            />
            <PublicButton type="submit" full disabled={loading}>
              {loading ? 'Working…' : 'Make my account'}
            </PublicButton>
          </form>
        </PublicCard>

        <PublicCard>
          <PublicBody>
            Been here before? <PublicLink href="/auth">Log in</PublicLink>
          </PublicBody>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
