'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'

// =============================================================================
// WorkspacePaneRedirect
//
// The standalone pages that back a URL-synced workspace *pane* overlay —
//   reader   → /article/<dTag> · /read/<postId>
//   profile  → /<username>     · /author/<id>
//   surface  → /source/<id> · /tag/<name> · /pub/<slug>[/sub-view]
// — are real, addressable, SEO/share/new-tab destinations, so they SSR full-page
// for logged-out visitors (the public share register: the page body under the
// one nav row).
//
// But the overlay puts that same canonical URL in the address bar, so a reload
// (or a shared link opened by a member) lands a *logged-in* user on the
// standalone page rather than in the workspace. This bounces them back in:
// replace the URL with /reader?overlay=<name>&<seed> so the workspace reopens
// the matching pane on that target (overlays.ts dispatcher).
//
// Mirrors HomeRedirect: mounted inside the SSR'd page so logged-out first paint
// is untouched; only authenticated sessions are redirected. `replace` (not
// `push`) keeps the standalone URL out of history. Feed context (skip ears /
// frame) is gone after a cold reload, so the pane reopens plain.
// =============================================================================

export default function WorkspacePaneRedirect({
  overlay,
  params,
}: {
  overlay: 'reader' | 'profile' | 'surface'
  params: Record<string, string>
}) {
  const router = useRouter()
  const user = useAuth((s) => s.user)
  const loading = useAuth((s) => s.loading)
  // NO LONGER SIGNALS THE SHELL. This used to flip a `usePaneRedirect` bit so
  // LayoutShell could hold the black topbar through the auth-resolve window and
  // spare a member the flash of chrome they were about to leave. There is no
  // topbar to hold: every route is chromeless, the one nav row is the same for
  // members and visitors, and it waits for auth to resolve before it renders at
  // all. The store is deleted.

  useEffect(() => {
    if (loading || !user) return
    const qs = new URLSearchParams({ overlay, ...params }).toString()
    router.replace(`/reader?${qs}`)
  }, [overlay, params, user, loading, router])

  return null
}
