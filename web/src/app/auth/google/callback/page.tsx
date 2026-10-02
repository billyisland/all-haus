'use client'

import { useEffect, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../../stores/auth'
import { takeGoogleBind } from '../../../../lib/google-oauth'
import { request, ApiError } from '../../../../lib/api/client'
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
// the code + state to the gateway exchange endpoint, which validates the signed
// state, exchanges the code, and sets the session cookie in its response. We
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

function GoogleCallbackPageBody() {
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

    // The browser binding this flow started with (MIRROR-AUDIT §2.5). It is in
    // OUR sessionStorage, so a callback URL forwarded to another browser cannot
    // carry it — and the absence is a failed sign-in, not an unbound one: there
    // is no request to make without it, and making one anyway would only teach
    // the far end to accept a blank binding.
    const bind = takeGoogleBind()
    if (!bind) {
      router.replace('/auth?mode=login&error=google_failed')
      return
    }

    request<{ arrivalDTag?: string | null } | null>('/auth/google/exchange', {
      method: 'POST',
      body: JSON.stringify({ code, state, bind }),
    })
      .then(async (body) => {
        // The arrival intent came back inside the HMAC-SIGNED state, so the
        // gateway has already verified it and looked any price up server-side.
        // This page still rebuilds the path from the identifier rather than
        // following one — same rule on all three carriers.
        await fetchMe()
        router.replace(
          body?.arrivalDTag
            ? `/article/${encodeURIComponent(body.arrivalDTag)}`
            : '/reader',
        )
      })
      .catch((err: unknown) => {
        // Closed beta: this Google email has no account and the gateway
        // refused to create one (CLOSED-BETA-ADR D1). That is a normal
        // outcome, not a failure — route straight to the waitlist surface
        // (D4), which explains and captures the interest, rather than the
        // generic error, which would read as "something broke".
        if (err instanceof ApiError && err.body?.error === 'closed_beta') {
          router.replace('/waitlist?from=beta')
          return
        }
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

// useSearchParams() bails this subtree out to client rendering; the boundary
// keeps that bail-out to the page instead of the whole route (CA-F13).
export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={null}>
      <GoogleCallbackPageBody />
    </Suspense>
  )
}
