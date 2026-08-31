'use client'

import { useState, useEffect } from 'react'
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

// =============================================================================
// Magic Link Verification — /auth/verify?token=<token>
//
// On mount: extract the token, POST /auth/verify, and on success hydrate the
// session and push /reader. On failure, offer a fresh link.
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
// SUCCESS IS NOT A TICK. It is the word, in the serif, and the redirect. A tick
// glyph in a coloured disc was the only iconographic state badge in the app and
// it had no siblings to be consistent with.
// =============================================================================

export default function VerifyPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { fetchMe } = useAuth()
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>(
    'verifying',
  )
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    const token = searchParams.get('token')
    if (!token) {
      setStatus('error')
      setErrorMessage('No login token found in the URL.')
      return
    }

    async function verify() {
      try {
        await auth.verify(token!)
        setStatus('success')
        await fetchMe()
        // Short delay so the success message is visible.
        setTimeout(() => router.push('/reader'), 800)
      } catch (err: any) {
        setStatus('error')
        if (err.status === 401) {
          setErrorMessage('This login link has expired, or has already been used.')
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
              <PublicTitle>Logging you in</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>Checking your login link.</PublicBody>
              </div>
            </PublicCard>
            <PublicCard style={{ padding: 0 }}>
              <IndeterminateSlab label="Verifying your login link" />
            </PublicCard>
          </>
        )}

        {status === 'success' && (
          <PublicCard>
            <PublicTitle>You’re in.</PublicTitle>
            <div style={{ marginTop: 10 }}>
              <PublicBody>Taking you to your workspace.</PublicBody>
            </div>
          </PublicCard>
        )}

        {status === 'error' && (
          <>
            <PublicCard>
              <PublicTitle>That link didn’t work</PublicTitle>
              <div style={{ marginTop: 10 }}>
                <PublicBody>{errorMessage}</PublicBody>
              </div>
            </PublicCard>
            <PublicCard>
              <PublicButton full href="/auth?mode=login">
                Request a new link
              </PublicButton>
            </PublicCard>
          </>
        )}
      </PublicVessel>
    </PublicShell>
  )
}
