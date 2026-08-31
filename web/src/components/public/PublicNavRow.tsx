'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ForallLockup } from '../brand/ForallLockup'
import { useAuth } from '../../stores/auth'

// =============================================================================
// PublicNavRow — the non-workspace nav row, and the only chrome outside the
// workspace.
//
// SUPERSEDES LandingNavRow AND Nav (the black topbar). The topbar was the last
// carrier of the retired marketing/auth register: black beam, white wordmark, a
// bare 21px crimson ∀ at the left, a mobile sheet of auth links. It survived on
// `/auth`, `/waitlist` and every share/SEO page while `/`, `/about` and
// `/admin` had already left it, so a visitor following a shared article link
// met one house and a visitor landing on `/` met another. One row now.
//
// IT NO LONGER MIRRORS THE WORKSPACE (2026-08-24). It used to: same NAV_ROW_H,
// same `--ah-bone` ground, same lockup docked at the right end at disc 40 /
// wordmark 24, as a deliberate "one row, in the same place, on every route".
// The workspace chrome has moved twice since — up the left margin as a rail,
// then along the TOP edge as a bar (`NavBar`) — and this row stayed at the
// bottom through both. The split is on purpose and is not drift: the workspace
// chrome is placed by the columnar floor's axes and by where its own occupants
// need room, and a public page has neither a floor nor a pan, so neither
// argument reaches it. What the two still share is the LOCKUP: disc 40 /
// wordmark 24, one GRID of clearance, the same `--ah-bone` global-chrome
// ground. `NAV_ROW_H` lives here, because this row is the only thing left that
// reserves a height.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT SERVES MEMBERS TOO (added in tranche 2, correcting tranche 1).
//
// The first cut mounted this for logged-out visitors only, on the reasoning
// that a member has the workspace ∀. That was wrong, and the retired topbar had
// already got it right: it rendered a BARE WORDMARK BEAM for a logged-in member
// on any standalone route, because those routes exist outside the workspace and
// a member who lands on one — an invite link in their email, a subscription
// offer, a shared article — would otherwise have no navigation at all. Deleting
// the topbar deleted that, and tranche 2's pages are exactly the ones a member
// reaches by following a link from outside the app.
//
// So the row mounts for everyone off the workspace, and the LEFT END is what
// changes:
//   • logged out — the two destinations the topbar carried (CLOSED-BETA-ADR
//     §IV: log in, and the waiting list; there is no public signup), and each
//     page shows the one it is NOT. Offering "Log in" on the login page was the
//     retired register's habit and read as a mistake.
//   • logged in — nothing. The member's destinations all live behind the ∀ in
//     the workspace, so duplicating any of them here would be dead chrome, and
//     showing "Log in" to a member would be simply wrong. The lockup alone is
//     the whole row, exactly as the bare beam was.
//
// AND THE LOCKUP POINTS SOMEWHERE DIFFERENT depending on who and where:
//   • member — `/reader`. A member's home IS the workspace; sending them to the
//     landing page, which HomeRedirect immediately bounces, is a round trip
//     through a page that exists to argue them into signing up for something
//     they already have.
//   • visitor ON `/` — `/waitlist`. `/` is already home, so a link there is a
//     dead no-op; on the landing page the lockup doubles as the get-started
//     target (`/auth?mode=signup` only redirects to the waiting list anyway).
//     Carried over from LandingNavRow, which this supersedes — the decision is
//     older than this component and shouldn't be lost with the file.
//   • visitor anywhere else — `/`.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO DIVIDER, for the same reason the rail has none: the lockup docked at its end
// is indicator enough, a full-width rule is a heavier statement than the row is
// making, and the sitewide no-single-pixel-lines invariant forbids a thin one
// in its place outright.
//
// NO LIGHT ISLAND. Unlike PublicVessel this sits on the plain `--ah-bone`
// floor and wants the neutral slugs as html.dark leaves them — it inverts with
// the global toggle, exactly as the rail and the mobile bar do.
//
// The floor never reaches behind it: LayoutShell publishes `--ah-row-band`
// (NAV_ROW_H + GRID) whenever this row is mounted, which fitted pages subtract
// from their height and scrolling pages add as bottom padding.
// =============================================================================

/** Row height in px. Published by `LayoutShell` as `--ah-row-band`
 *  (NAV_ROW_H + GRID) for as long as this row is mounted; fitted public pages
 *  subtract it from their height and scrolling ones add it as bottom padding.
 *  56 leaves exactly one GRID (8px) of clearance above and below the 40px
 *  disc. */
export const NAV_ROW_H = 56

export function PublicNavRow() {
  const pathname = usePathname()
  const user = useAuth((s) => s.user)

  const onAuth = pathname.startsWith('/auth')
  const onWaitlist = pathname.startsWith('/waitlist')
  const onLanding = pathname === '/'

  const lockupHref = user ? '/reader' : onLanding ? '/waitlist' : '/'

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: NAV_ROW_H,
        background: 'var(--ah-bone)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 16,
        paddingRight: 16,
        // Above the Glasshouse scrim (z-55) and pane (z-56), below the lockup's
        // own layer (z-60) and the lightbox (z-70) — the rail's z-order exactly.
        zIndex: 58,
      }}
      // Explain chrome: never dimmed, never annotatable. Mirrors the rail.
      data-explain-chrome=""
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        {!user && !onAuth && (
          <Link
            href="/auth?mode=login"
            className="label-ui text-grey-600 hover:text-black transition-colors"
          >
            Log in
          </Link>
        )}
        {!user && !onWaitlist && (
          // The register's ONLY accent button. No inline colour override: the
          // dark-mode bug this row surfaced (`.btn-accent` was `color:
          // var(--ah-white)`, and `white` is a DARK_SLUG that inverts to 30 29
          // 26 while crimson holds) is repaired at source in globals.css, which
          // now uses the non-inverting `--ah-on-crimson`.
          <Link href="/waitlist" className="btn-accent btn-sm">
            Join the waiting list
          </Link>
        )}
      </div>

      <ForallLockup href={lockupHref} />
    </div>
  )
}
