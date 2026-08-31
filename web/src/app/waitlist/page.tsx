'use client'

import { useState, useEffect } from 'react'
import { waitlist } from '../../lib/api'
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
} from '../../components/public/Field'
import { usePublicPalette } from '../../components/public/palette'

// Closed-beta waiting-list surface (CLOSED-BETA-ADR Phase 2, D2/D4).
//
// THE FORM ASKS FOR AN EMAIL AND NOTHING ELSE. D3's "I'd also like to publish"
// tickbox was removed 2026-07-27, along with the reporting behind it: the answer
// implied nothing about what we would give anyone, and there is no larger
// interest here looking for hints about revenue. Someone joining a waiting list
// is owed a way to be told when it opens, not a survey. Don't reinstate it, and
// don't add a second question in its place — if we ever genuinely need to know
// something, ask the people who are already in, where the question has a
// consequence they can see.
//
// The endpoint is enumeration-safe, so every success looks identical — we never
// say whether the email was new.
//
// REDESIGNED 2026-07-25 onto the public chassis, same removals as /auth.
export default function WaitlistPage() {
  const palette = usePublicPalette()

  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)
  // Arrived here from a rejected signup / Google sign-in (D4 edge cases) — show
  // the §V "you're not in the beta yet" line. Read from location rather than
  // useSearchParams so the page needn't be wrapped in a Suspense boundary.
  const [fromBeta, setFromBeta] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('from') === 'beta') setFromBeta(true)
  }, [])

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await waitlist.join({ email })
      setJoined(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (joined) {
    return (
      <PublicShell>
        <PublicVessel>
          <PublicCard>
            <PublicTitle>You’re on the list.</PublicTitle>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              We’ll write to{' '}
              <span style={{ color: palette.cardTitle }}>{email}</span> when
              we’re ready for you.
            </PublicBody>
          </PublicCard>
          <PublicCard>
            <PublicBody>
              Already have an account?{' '}
              <PublicLink href="/auth?mode=login">Log in</PublicLink>
            </PublicBody>
          </PublicCard>
        </PublicVessel>
      </PublicShell>
    )
  }

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Not open yet.</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              {fromBeta
                ? 'You’re not in the beta yet. Join the waiting list and we’ll be in touch when we’re ready for you.'
                : 'all.haus is in closed beta. Join the list and we’ll write when we’re ready for you.'}
            </PublicBody>
          </div>
        </PublicCard>

        {error && <FormError>{error}</FormError>}

        <PublicCard>
          <form
            onSubmit={handleJoin}
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
              {loading ? 'Working…' : 'Join the list'}
            </PublicButton>
          </form>
        </PublicCard>

        <PublicCard>
          <PublicBody>
            Already have an account?{' '}
            <PublicLink href="/auth?mode=login">Log in</PublicLink>
          </PublicBody>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
