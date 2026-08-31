'use client'

import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useAuth } from '../../../stores/auth'
import { tributesEnabled } from '../../../lib/api'
import { TRIBUTE_CLAIM_KEY } from '../../../components/tribute/TributeClaimResumer'
import { PublicShell } from '../../../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../../../components/public/PublicVessel'
import { PublicButton, PublicLink } from '../../../components/public/Field'

// =============================================================================
// /tribute/claim?token=… — the landing for an external tribute-offer email.
//
// The token is stashed in sessionStorage, then the global TributeClaimResumer
// (mounted in LayoutShell) redeems it as soon as auth resolves — so the claim
// survives the signup round-trip. This page only routes: a logged-in invitee is
// claimed in place (the resumer redirects to the piece); an anonymous one is
// pointed at the waiting list, since account creation is closed during the beta
// (CLOSED-BETA-ADR §IV).
//
// REDESIGNED 2026-07-25 (tranche 2) onto the public chassis. Its local `Card`
// helper — `max-w-sm`, `py-28`, a centred ∀ dingbat, and a `text-2xl
// font-medium` heading in the SANS face — is replaced by the shared vessel. The
// heading face matters: this page's title was the only display heading in the
// register set in Jost rather than the serif, which made it read as a system
// notice rather than as the house speaking.
//
// THE STATES ARE A ROUTING TABLE, not a page with variants — hence one small
// component per outcome and no shared body. Every one of them is a leaf a
// stranger arrives at from an email, so each says what happened in one serif
// line and what to do in one mono paragraph.
// =============================================================================

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>{title}</PublicTitle>
          <div style={{ marginTop: 10 }}>{children}</div>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}

function ClaimInner() {
  const params = useSearchParams()
  const router = useRouter()
  const { user, loading } = useAuth()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    const t = params.get('token')
    if (!t) return
    setToken(t)
    try {
      sessionStorage.setItem(TRIBUTE_CLAIM_KEY, t)
    } catch {
      /* ignore */
    }
    // Strip the token from the URL once stashed — it binds money to an account,
    // so it must not linger in browser history, server access logs, or Referer.
    router.replace('/tribute/claim')
  }, [params, router])

  if (!tributesEnabled()) {
    return (
      <Frame title="Not available">
        <PublicBody>This isn’t available right now.</PublicBody>
      </Frame>
    )
  }

  if (!token) {
    return (
      <Frame title="This link is incomplete">
        <PublicBody>
          Use the link from your email — this one is missing the part that
          identifies the offer.
        </PublicBody>
      </Frame>
    )
  }

  if (loading) {
    return (
      <Frame title="One moment">
        <PublicBody>Checking your session.</PublicBody>
      </Frame>
    )
  }

  if (user) {
    // The resumer claims the stashed token and redirects to the piece.
    return (
      <Frame title="Claiming your tribute">
        <PublicBody>Taking you to the piece you inspired.</PublicBody>
      </Frame>
    )
  }

  // Anonymous external invitee. Account creation is closed during the beta, so
  // the CTA is the waiting list rather than a signup form that no longer
  // exists. Existing members can still log in and bind the offer.
  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>
            Someone wants to share what their writing earns with you
          </PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              A writer on all.haus has credited you as an inspiration for a
              piece, and offered you a share of what it earns.
            </PublicBody>
          </div>
        </PublicCard>

        <PublicCard>
          <div style={{ marginBottom: 16 }}>
            <PublicBody>
              all.haus is in closed beta. Join the waiting list and we’ll be in
              touch — the offer will be waiting.
            </PublicBody>
          </div>
          <PublicButton full onClick={() => router.push('/waitlist')}>
            Join the waiting list
          </PublicButton>
        </PublicCard>

        <PublicCard>
          <PublicBody>
            Already on all.haus?{' '}
            <PublicLink href="/auth?mode=login">Log in</PublicLink> and we’ll
            bind the offer to your account.
          </PublicBody>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}

export default function TributeClaimPage() {
  return (
    <Suspense fallback={null}>
      <ClaimInner />
    </Suspense>
  )
}
