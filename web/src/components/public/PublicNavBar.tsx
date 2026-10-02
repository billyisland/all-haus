'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ForallLockup } from '../brand/ForallLockup'
import { useAuth } from '../../stores/auth'
import { useLoginHref } from '../../lib/auth-return'
import { NAV_BAR_H, NAV_BAR_INSET } from '../workspace/NavBar'
import { WAITLIST_HOVER } from '../article/PaywallGate'

// =============================================================================
// PublicNavBar — the non-workspace nav bar, and the only chrome outside the
// workspace.
//
// SUPERSEDES PublicNavRow (2026-08-31), which itself superseded LandingNavRow
// AND Nav (the black topbar). The topbar was the last carrier of the retired
// marketing/auth register: black beam, white wordmark, a bare 21px crimson ∀ at
// the left, a mobile sheet of auth links. It survived on `/auth`, `/waitlist`
// and every share/SEO page while `/`, `/about` and `/admin` had already left
// it, so a visitor following a shared article link met one house and a visitor
// landing on `/` met another. One bar now.
//
// THE TOP BAR IS THE RULE ACROSS THE SITE (2026-08-31). PublicNavRow sat at the
// BOTTOM edge and its header defended the split from the workspace chrome as
// "on purpose and not drift" — the workspace chrome is placed by the columnar
// floor's axes, a public page has no floor. That reasoning cut the other way
// too: nothing about a public page argued FOR the bottom edge either, and the
// cost of the split was real — the brand mark greeted a workspace member at the
// top-left and a visitor at the bottom-right of the same site. The operator
// closed it: the lockup sits at the TOP LEFT of every page, logged in or out,
// and no page carries bottom chrome.
//
// SO THE GEOMETRY IS IMPORTED, NOT MIRRORED. `NAV_BAR_H`/`NAV_BAR_INSET` come
// from the workspace `NavBar` itself, so the two bars are one statement and
// cannot drift: same height (INSET + the 40px disc, the disc's bottom edge
// flush with the band's invisible bottom — see NavBar.tsx for why the disc must
// NOT be centred in the band), same `left: 24` dock for the lockup (matching
// `ForallMenu anchor="row"`), same `--ah-bone` ground, same z-58. A member
// crossing from the workspace to a standalone page sees the mark stay exactly
// where it was. The bar's occupants centre on the LOCKUP's line — `paddingTop:
// NAV_BAR_INSET` then `alignItems: center` over the remaining 40px — the same
// discipline as the muster's paddingTop.
//
// The band pages reserve under it is published by `LayoutShell` as
// `--ah-bar-band` (NAV_BAR_H + GRID): the bar plus one GRID of clearance,
// which each page paints with its own ground (the bar's bottom edge is
// invisible — band and floor are the same bone — so the clearance must be
// painted by the page, exactly as the workspace floor's top buffer paints its
// GRID below the workspace bar).
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
// So the bar mounts for everyone off the workspace, and the RIGHT END is what
// changes (it was the left end in the bottom-row era; the lockup now owns the
// left):
//   • logged out — the two destinations the topbar carried (CLOSED-BETA-ADR
//     §IV: log in, and the waiting list; there is no public signup), and each
//     page shows the one it is NOT. Offering "Log in" on the login page was the
//     retired register's habit and read as a mistake.
//   • logged in — nothing. The member's destinations all live behind the ∀ in
//     the workspace, so duplicating any of them here would be dead chrome, and
//     showing "Log in" to a member would be simply wrong. The lockup alone is
//     the whole bar, exactly as the bare beam was.
//
// AND THE LOCKUP POINTS SOMEWHERE DIFFERENT depending on who and where:
//   • member — `/reader`. A member's home IS the workspace; sending them to the
//     landing page, which HomeRedirect immediately bounces, is a round trip
//     through a page that exists to argue them into signing up for something
//     they already have.
//   • visitor ON `/` — `/waitlist`. `/` is already home, so a link there is a
//     dead no-op; on the landing page the lockup doubles as the get-started
//     target (`/auth?mode=signup` only redirects to the waiting list anyway).
//     Carried over from LandingNavRow via PublicNavRow — the decision is older
//     than this component and shouldn't be lost with the file.
//   • visitor anywhere else — `/`.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO DIVIDER, for the same reason the workspace bar has none: the lockup docked
// at its end is indicator enough, a full-width rule is a heavier statement than
// the bar is making, and the sitewide no-single-pixel-lines invariant forbids a
// thin one in its place outright.
//
// NO LIGHT ISLAND. Unlike PublicVessel this sits on the plain `--ah-bone`
// floor and wants the neutral slugs as html.dark leaves them — it inverts with
// the global toggle, exactly as the workspace bar and the mobile bar do. (The
// lockup carries its OWN island — see ForallLockup for why that split is the
// fix for a real bug and not an inconsistency.)
//
// ─────────────────────────────────────────────────────────────────────────────
// AND BECAUSE THERE IS NO DIVIDER, THE GROUND IS THE WHOLE OF THE JOIN — so it
// is the PAGE's, not a constant (2026-09-02).
//
// The "no divider" clause above is only true while the bar and the floor under
// it are the same colour; the bar's bottom edge is invisible because there is
// nothing on either side of it to see. Painted a fixed `--ah-bone` it stops
// being a band merging into the page and becomes a slab sitting on top of one,
// which is exactly what a divider is, only fuzzier — the reader route showed it
// as an odd griege strip over the white reading paper.
//
// So the ground is `--ah-bar-ground`, published by whichever public chassis is
// rendering the page (PublicPage's `barGround`), with `--ah-bone` as the
// fallback — which is what every page that was already correct resolves to, so
// this is a no-op everywhere except where the floor genuinely differs.
//
// IT IS A VARIABLE AND NOT A ROUTE TEST ON PURPOSE. The page knows its own
// ground; a table here of "which paths paint white" is a hand-maintained list
// that goes wrong the first time a route is added and is silent when it does.
// The var has to travel through `:root` (see PublicPage) because this bar is a
// FIXED SIBLING of `main` — a ground declared on the page cannot be inherited
// upwards to it.
//
// KNOWN, NOT FIXED HERE: `/auth` and `/waitlist` are fitted `PublicShell`
// pages, whose floor is `palette.interior` — byte-identical to bone in light,
// but ink-925 (26 26 24) in dark against bone's 20 19 17. Their bar is a shade
// dark in dark mode for the same reason this one was, and the remedy is one
// `barGround` on PublicShell. Left alone deliberately: a different surface.
// ─────────────────────────────────────────────────────────────────────────────
// =============================================================================

export function PublicNavBar() {
  const pathname = usePathname()
  const user = useAuth((s) => s.user)

  const onAuth = pathname.startsWith('/auth')
  const onWaitlist = pathname.startsWith('/waitlist')
  const onLanding = pathname === '/'

  // The bar's Log in carries the piece the reader is on, so logging in returns
  // them to it. Carrier + its open-redirect defence: lib/auth-return.ts.
  const loginHref = useLoginHref()

  const lockupHref = user ? '/reader' : onLanding ? '/waitlist' : '/'

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        top: 0,
        height: NAV_BAR_H,
        // The page's ground, not a constant — see the note above. `--ah-bone`
        // is what every already-correct page resolves to.
        background: 'var(--ah-bar-ground, var(--ah-bone))',
        display: 'flex',
        alignItems: 'center',
        // Occupants align on the lockup's centre line, not the band's — the
        // disc's top sits one GRID down and its bottom IS the band's bottom
        // edge (NavBar.tsx has the full argument).
        paddingTop: NAV_BAR_INSET,
        // 24 at both ends on desktop — the workspace lockup's own dock inset,
        // mirrored. On a phone the bar holds the lockup AND up to two auth
        // actions in ~390px, so the end insets (and the action gap below)
        // yield via clamp() rather than a useIsMobile branch: these pages are
        // SSR'd, and a JS form-factor switch would paint the desktop inset
        // first and snap after hydration (globals.css §1c's reason).
        paddingLeft: 'clamp(12px, 2.5vw, 24px)',
        paddingRight: 'clamp(12px, 2.5vw, 24px)',
        // Guaranteed daylight between the lockup and the actions when the
        // auto margin has collapsed to nothing on a narrow screen.
        gap: 'clamp(8px, 2vw, 16px)',
        // Above the Glasshouse scrim (z-55) and pane (z-56), below the lockup's
        // own layer (z-60) and the lightbox (z-70) — the workspace bar's
        // z-order exactly.
        zIndex: 58,
      }}
      // Explain chrome: never dimmed, never annotatable. Mirrors the workspace bar.
      data-explain-chrome=""
    >
      <ForallLockup href={lockupHref} />

      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 'clamp(8px, 2vw, 20px)',
          // The actions never wrap or shrink — a two-line CTA overflows the
          // 40px content band, and "LOG IN" broken over two lines reads as
          // debris. The room comes from the yielding insets above.
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {!user && !onAuth && (
          // `.btn-text`, not `.label-ui`. The two actions are a PAIR and have
          // to be one system: an 11px mono uppercase micro-label next to a
          // 14px Jost sentence-case slab read as two registers docked at the
          // same end, and the mono was the outlier — `.btn-accent` is Jost by
          // definition and the lockup's wordmark beside it is Jost too. So the
          // text action takes the house's text-link face (13px Jost, ink) and
          // the accent keeps its own; black text link, crimson button, one
          // accent per screen.
          <Link href={loginHref} className="btn-text">
            Log in
          </Link>
        )}
        {!user && !onWaitlist && (
          // The register's ONLY accent button. No inline colour override: the
          // dark-mode bug this bar's predecessor surfaced (`.btn-accent` was
          // `color: var(--ah-white)`, and `white` is a DARK_SLUG that inverts
          // to 30 29 26 while crimson holds) is repaired at source in
          // globals.css, which now uses the non-inverting `--ah-on-crimson`.
          <Link
            href="/waitlist"
            // `title` only, not `aria-label` — the aside is a hover reward and
            // the accessible name stays the plain thing the link does. Shared
            // with the paywall gate's own waiting-list link so the two cannot
            // drift into different jokes.
            title={WAITLIST_HOVER}
            // `.btn-bar` states the 40px band height. Without it `.btn-sm`
            // computed to 42.4px — 2.4px taller than the band — and hung 1.2px
            // below the bar's own bottom edge into the page. globals.css has
            // the arithmetic and why the class exists rather than an inline
            // height.
            className="btn-accent btn-sm btn-bar"
            // The one size override, and it is padding, not colour: with the
            // lockup, "Log in" AND this CTA sharing ~360px, the button's own
            // horizontal padding is the only thing left that can yield. Past
            // ~344px even that has bottomed out, which is what the short
            // spelling below is for.
            style={{ paddingLeft: 'clamp(8px, 2vw, 16px)', paddingRight: 'clamp(8px, 2vw, 16px)' }}
          >
            {/* TWO SPELLINGS OF ONE CONTROL, switched by a media query in
                globals.css §1b-bis — which carries the measurements and why
                the label is what gives rather than the mark or a way in. Both
                are in the DOM; the inactive one is `display: none`, so the
                accessible name is whichever is on screen and never both. The
                class names are LITERALS, since Tailwind tree-shakes the
                components layer and an assembled one would ship the rules
                stripped and the control with both labels stacked. */}
            <span className="ah-cta-long">Join the waiting list</span>
            <span className="ah-cta-short">Sign up</span>
          </Link>
        )}
      </div>
    </div>
  )
}
