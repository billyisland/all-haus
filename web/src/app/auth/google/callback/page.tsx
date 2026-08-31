'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../../stores/auth'
import { PublicShell } from '../../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../../components/public/PublicVessel'

// =============================================================================
// Google OAuth callback.
//
// Google redirects here after the visitor approves (or denies) consent. We POST
// the code + state to the gateway exchange endpoint, which validates the state
// cookie, exchanges the code, and sets the session cookie in its response. We
// then call /auth/me to hydrate the store and navigate.
//
// Doing the exchange via a regular fetch (not a gateway redirect) ensures
// Set-Cookie is in a normal response body, not a redirect — Next.js rewrite
// proxies reliably forward cookies in regular responses.
//
// REDESIGNED 2026-07-25. It was a bare grey mono line vertically centred on
// nothing, under the black topbar. It is a transient frame — typically well
// under a second — so it stays deliberately quiet, but quiet is not the same as
// unhoused: it now sits in the same vessel as every other step of the sign-in,
// so the visitor's screen doesn't change shape underneath them mid-flow.
// =============================================================================

export default function GoogleCallbackPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const fetchMe = useAuth((s) => s.fetchMe)
  const called = useRef(false)

  useEffect(() => {
    if (called.current) return
    called.current = true

    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    if (error || !code || !state) {
      router.replace('/auth?mode=login&error=google_denied')
      return
    }

    fetch('/api/v1/auth/google/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })
      .then(async (res) => {
        if (!res.ok) {
          // Closed beta: this Google email has no account and the gateway
          // refused to create one (CLOSED-BETA-ADR D1). That is a normal
          // outcome, not a failure — route straight to the waitlist surface
          // (D4), which explains and captures the interest, rather than the
          // generic error, which would read as "something broke".
          const body = await res.json().catch(() => null)
          if (body?.error === 'closed_beta') {
            router.replace('/waitlist?from=beta')
            return
          }
          throw new Error('Exchange failed')
        }
        await fetchMe()
        router.replace('/reader')
      })
      .catch(() => {
        router.replace('/auth?mode=login&error=google_failed')
      })
  }, [])

  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Signing you in</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>One moment.</PublicBody>
          </div>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
