'use client'

import { usePathname } from 'next/navigation'

// =============================================================================
// Where logging in sends you back to.
//
// A logged-out reader who presses "Log in" from a piece should come back to
// THAT PIECE, not be deposited in the workspace with the article to find again.
// Every logged-out login affordance on a reading surface goes through here, so
// the carrier and its defence are written down once.
//
// THE CARRIER IS `?arrival=<dTag>`, which already existed for the paywall gate
// (PAYWALL-ARRIVAL §5) and is the ONE that survives the reader opening the
// emailed magic link on a different device. It threads
// `/auth` → `auth.login(email, dTag)` → the gateway's `sendMagicLinkEmail` →
// `&arrival=` on the emailed URL → `/auth/verify`, which rebuilds the path.
//
// IT IS AN IDENTIFIER READ OFF OUR OWN ROUTE, NEVER A PATH, and that is the
// whole of what keeps this off the classic open-redirect shape: the d-tag comes
// from the URL the component is already rendering on, and the terminus
// RECONSTRUCTS `/article/<dTag>` from it rather than navigating to any string
// it was handed. **Do not generalise this to a `next=`/`returnTo=` parameter** —
// that is the shape the whole arrangement exists to avoid.
//
// IT CARRIES SIGN-IN INTENT AND NOTHING ELSE. Magic link creates no account, so
// this arm serves a MEMBER. The arrival gift and the welcome modal are gated
// server-side on `accounts.arrival_article_id` — a fact stamped at account
// creation — so a returning member triggers neither, whatever this passes.
//
// NATIVE ARTICLES ONLY. `arrival` is a d-tag by definition, so there is nothing
// to carry from `/read/:postId` (external, keyed on a post_id) or from a
// publication article path. Those fall back to the workspace, which is the
// honest answer rather than a wrong one.
// =============================================================================

const ARTICLE_PREFIX = '/article/'

/** The piece this path is showing, or null if it is not an article page. */
export function articleDTagFromPath(pathname: string | null): string | null {
  if (!pathname || !pathname.startsWith(ARTICLE_PREFIX)) return null
  const raw = pathname.slice(ARTICLE_PREFIX.length).split('/')[0]
  if (!raw) return null
  // The pathname arrives percent-encoded; `arrival` is re-encoded on the way
  // out, so decode first or a d-tag with an escaped character is double-encoded
  // and the terminus rebuilds a path to nothing.
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * `/auth?mode=login`, carrying the current piece when there is one.
 * For a logged-out login affordance rendered on a reading surface.
 */
export function useLoginHref(): string {
  const dTag = articleDTagFromPath(usePathname())
  return dTag
    ? `/auth?mode=login&arrival=${encodeURIComponent(dTag)}`
    : '/auth?mode=login'
}
