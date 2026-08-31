'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'

// =============================================================================
// HomeRedirect
//
// The marketing landing page at `/` serves logged-out visitors. Once auth
// resolves to a logged-in user, send them to their home — the workspace —
// so all.haus's root is the workspace for anyone with a session.
//
// Mounted inside the SSR'd marketing page so logged-out first-paint is
// untouched; only authenticated sessions get bounced. `replace` (not `push`)
// keeps `/` out of history, so Back from the workspace doesn't ping-pong.
// =============================================================================

export default function HomeRedirect() {
  const router = useRouter()
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)

  useEffect(() => {
    if (!loading && user) router.replace('/reader')
  }, [user, loading, router])

  return null
}
