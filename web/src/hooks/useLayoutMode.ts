'use client'

import { usePathname } from 'next/navigation'

export type LayoutMode = 'platform' | 'canvas' | 'workspace'

/**
 * Platform-register route prefixes. Everything else at the root level
 * (/:username) is canvas.
 *
 * ONLY ROUTES THAT PAINT BELONG HERE. A route whose page is nothing but a
 * server `redirect()` never renders in any register — Next answers the request
 * with the redirect and no HTML, and a client navigation follows it from the
 * RSC payload — so listing one says a surface exists where none does. Thirteen
 * of the twenty entries were that: the whole overlay migration (/feed,
 * /dashboard, /search, /profile, /settings, /notifications, /history, /ledger,
 * /library) plus the dissolved Network family (/following, /followers,
 * /network, /social), each now a shim into `/reader?overlay=…`.
 *
 * `/account` stays despite its own index being a shim, because `/account/export`
 * beneath it is a real page — the check is whether ANYTHING under the prefix
 * renders, not whether its index does.
 */
const PLATFORM_PREFIXES = [
  '/write',
  '/about',
  '/auth',
  '/waitlist',
  '/messages',
  '/account',
  '/admin',
]

export function useLayoutMode(): LayoutMode {
  const pathname = usePathname()

  // Workspace runs without the public nav row or the compose overlay.
  // Canonical route is /reader (the article reader lives at /read/:postId).
  if (pathname === '/reader' || pathname.startsWith('/reader/')) {
    return 'workspace'
  }

  // Article reader is always canvas
  if (pathname.startsWith('/article/')) return 'canvas'

  // Homepage is platform
  if (pathname === '/') return 'platform'

  // Known platform routes
  for (const prefix of PLATFORM_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      return 'platform'
    }
  }

  // Anything else at root level (e.g. /:username) is canvas
  return 'canvas'
}
