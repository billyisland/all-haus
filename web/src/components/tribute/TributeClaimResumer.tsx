'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { tributes, tributesEnabled } from '../../lib/api'

// =============================================================================
// Tribute claim resumer (Upstream Edges Phase 2)
//
// An external tribute invitee is always logged out (the offer email goes to
// someone with no account), so the claim must survive a signup. The claim page
// stashes the token in sessionStorage and sends them to sign up; once auth
// resolves to a logged-in user — anywhere in the app — this headless component
// redeems the stashed token, binding their fresh account to the tribute and
// granting the comp read, then sends them to read the piece (where the Accept /
// Decline affordance lives). An already-registered invitee is claimed straight
// away. Mounted unconditionally in LayoutShell; renders nothing.
// =============================================================================

export const TRIBUTE_CLAIM_KEY = 'ah:tribute-claim-token'

export function TributeClaimResumer() {
  const user = useAuth((s) => s.user)
  const router = useRouter()
  const claiming = useRef(false)

  useEffect(() => {
    if (!tributesEnabled() || !user || claiming.current) return
    let token: string | null = null
    try {
      token = sessionStorage.getItem(TRIBUTE_CLAIM_KEY)
    } catch {
      token = null
    }
    if (!token) return

    claiming.current = true
    tributes
      .claim(token)
      .then((res) => {
        try { sessionStorage.removeItem(TRIBUTE_CLAIM_KEY) } catch { /* ignore */ }
        // Send them to the piece they're credited on — the Tributes apparatus
        // there carries the Accept / Decline buttons.
        if (res.articleDTag) router.replace(`/article/${res.articleDTag}`)
      })
      .catch(() => {
        // Invalid / already-claimed / expired — drop it silently so we don't
        // loop. The user keeps their (now logged-in) session regardless.
        try { sessionStorage.removeItem(TRIBUTE_CLAIM_KEY) } catch { /* ignore */ }
        claiming.current = false
      })
  }, [user, router])

  return null
}
