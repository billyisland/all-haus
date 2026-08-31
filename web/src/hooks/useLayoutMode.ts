'use client'

import { usePathname } from 'next/navigation'

export type LayoutMode = 'platform' | 'canvas' | 'workspace'

/**
 * Known platform-register route prefixes.
 * Everything else at the root level (/:username) is canvas.
 */
const PLATFORM_PREFIXES = [
  '/feed',
  '/write',
  '/dashboard',
  '/about',
  '/auth',
  '/waitlist',
  '/search',
  '/profile',
  '/settings',
  '/notifications',
  '/history',
  '/following',
  '/followers',
  '/messages',
  '/account',
  '/admin',
  '/ledger',
  '/network',
  '/library',
  '/social',
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
