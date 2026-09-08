'use client'

import { createContext, useContext } from 'react'
import { useLayoutMode, type LayoutMode } from '../../hooks/useLayoutMode'
import { PublicNavBar } from '../public/PublicNavBar'
import { NAV_BAR_BAND } from '../workspace/NavBar'

// The band the fixed nav bar reserves at the HEAD of the viewport: the bar plus
// one GRID of clearance, which each page paints with its own ground (the bar's
// bottom edge is invisible — band and floor are the same bone — so the
// clearance below it must be painted by the page, exactly as the workspace
// floor's top buffer paints its GRID under the workspace bar). `NAV_BAR_BAND`
// is the workspace bar's own constant (NavBar.tsx, the one home for the
// number): since the top bar became the sitewide rule (2026-08-31) the two
// bars share one geometry and cannot drift.
// Published as a CSS variable rather than applied as padding — see the note on
// `<main>` below for why one padding rule can't serve every page.
const BAR_BAND = NAV_BAR_BAND
// Code-split + open-gated (performance audit #4): these four ride in *every*
// page bundle, so deferring them shrinks initial JS sitewide. TipTap (editor)
// is the biggest single win.
import {
  LazyComposeOverlay as ComposeOverlay,
  LazyProfileOverlay as ProfileOverlay,
  LazySurfaceOverlay as SurfaceOverlay,
  LazyEditorOverlay as EditorOverlay,
} from '../workspace/LazyOverlays'
import { LightboxOverlay } from '../ui/LightboxOverlay'
import { PalettePanel } from '../devtools/PalettePanel'
import { PaletteHydrator } from '../devtools/PaletteHydrator'
import { TypeScaleHydrator } from '../TypeScaleHydrator'
import { ColorSchemeHydrator } from '../ColorSchemeHydrator'
import { TributeClaimResumer } from '../tribute/TributeClaimResumer'
import { useReader } from '../../stores/reader'
import { useProfile } from '../../stores/profileOverlay'
import { useSurfaceOverlay } from '../../stores/surfaceOverlay'
import { useEditorOverlay } from '../../stores/editorOverlay'
import { useWorkspaceSurface } from '../../stores/workspaceSurface'
import { useAuth } from '../../stores/auth'

const LayoutModeContext = createContext<LayoutMode>('platform')

export function useLayoutModeContext(): LayoutMode {
  return useContext(LayoutModeContext)
}

// =============================================================================
// THE BLACK TOPBAR IS GONE (2026-07-25). `Nav` and `LandingNavRow` are deleted.
//
// What it was: a 60px black beam carrying a bare crimson ∀ + white wordmark and,
// for a logged-out visitor, Log in / Join the waiting list plus a mobile sheet.
// It was the last carrier of the retired marketing/auth register.
//
// Why it went rather than being restyled: it had already lost `/`, `/about` and
// `/admin` to a `chromelessRoute` allow-list, so the site shipped two houses at
// once — a visitor landing on `/` met the bone floor, the ⊔ walls and the
// lockup docked in a bottom row; a visitor following a shared article link met
// a black beam. An allow-list that grows every time a page is redesigned is a
// migration in progress, not a design. This finishes it: NOTHING mounts a
// topbar, and the sole chrome a logged-out visitor sees is PublicNavBar — the
// same bar, in the same place, on every route.
//
// (2026-08-31: that chrome moved from the BOTTOM edge to the TOP, sharing the
// workspace bar's geometry — the top bar is now the sitewide rule, brand mark
// top-left on every page, no bottom chrome anywhere. This is not the black
// topbar back: one register, one bar, both audiences. See PublicNavBar.)
//
// CONSEQUENCES TO KNOW ABOUT:
//   • `main`'s `pt-[60px]` offset is gone with the beam it cleared. The bar's
//     reservation is NOT a padding on `main` either — see below.
//   • ComposeOverlay used to be gated on `!chromeless`, which was doing double
//     duty: "there is a topbar" happened to coincide with "this is a logged-in
//     platform page, and no overlay is open". With the topbar gone that
//     predicate is always false, so the gate is now spelled out directly —
//     platform mode, no overlay open. Do not collapse it back into a chrome
//     flag; there is no chrome left to hang it on.
//   • The bar's reserved band is published as `--ah-bar-band` (NAV_BAR_H +
//     GRID when mounted, 0 otherwise) rather than applied as padding on
//     `main`, because the pages fold it into their own arithmetic differently:
//     a SCROLLING page (the full-bleed share/SEO surfaces) adds the whole band
//     as top padding so its first line clears the bar, while a FITTED page
//     (PublicShell — the vessel is wholly on screen and its contents scroll)
//     takes the MAX of the band and its own headroom (`min(64px, 8vh)`), which
//     on a desktop is the headroom it always had — padding on `main` would
//     stack the two and double the clearance. So each page reads the var and
//     does its own arithmetic — `.ah-public-fit` for the fitted case,
//     `padding-top` for the other.
// =============================================================================

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const mode = useLayoutMode()
  // The workspace reader overlay pushes /article|/reader, flipping the URL-derived
  // mode to canvas — but the underlying page is still the workspace.
  const readerOpen = useReader((s) => s.isOpen)
  // The profile overlay pushes /<username> | /author/<id>, flipping the
  // URL-derived mode to canvas while the underlying surface is unchanged.
  const profileOpen = useProfile((s) => s.isOpen)
  // The article editor opens as a global Glasshouse over any surface.
  const editorOpen = useEditorOverlay((s) => s.isOpen)
  // The surface overlay (source / tag / publication) pushes /source|/tag|/pub,
  // flipping the URL-derived mode while the underlying surface is unchanged.
  const surfaceOpen = useSurfaceOverlay((s) => s.isOpen)
  const overlayOpen = readerOpen || profileOpen || editorOpen || surfaceOpen

  // The bar mounts for EVERYONE off the workspace — corrected in tranche 2.
  // The first cut gated it on `!authedUser`, on the reasoning that a member has
  // the workspace ∀. That was wrong: the retired topbar rendered a bare
  // wordmark beam for logged-in members precisely because standalone routes
  // (an invite link, a subscription offer, a shared article) sit outside the
  // workspace, and a member who lands on one would otherwise have no
  // navigation at all. PublicNavBar now varies its own right end by auth — the
  // two CTAs for a visitor, nothing but the lockup for a member — so the
  // mounting decision here is purely about the surface, not the viewer.
  //
  // It still waits for auth to RESOLVE. While `loading` is true we mount
  // nothing, so a member reloading a share link never flashes "Log in" at
  // themselves. (The bounce that used to follow is gone — PAYWALL-ARRIVAL D5.)
  // This replaces the `paneRedirectActive` suppression the retired shell needed.
  const authLoading = useAuth((s) => s.loading)

  // TWO FLAGS, NOT ONE, AND THE DIFFERENCE MATTERS. Whether the bar's BAND is
  // reserved is a question about the surface; whether the bar RENDERS is also a
  // question about the viewer, because its left end differs by auth. Deriving
  // both from `!authLoading` would mean every public page laid itself out at
  // band 0, then reflowed by 64px the moment `fetchMe` came back — a visible
  // jump on every cold load, on the page a first-time visitor is most likely to
  // be looking at. So the band is reserved from the first paint on any surface
  // that WILL carry a bar, and only the bar itself waits for auth. The gap in
  // between is 64px of empty floor, which is invisible.
  // AND A THIRD CONDITION THE URL CANNOT FAKE: the workspace surface itself is
  // not mounted. The URL-derived mode and the overlay flags between them still
  // leave a window — a URL-synced overlay's close() pops history and clears
  // `isOpen` synchronously in its popstate listener, while Next processes the
  // same popstate inside a TRANSITION, so for a few frames the pathname still
  // reads as the overlay's canvas URL with no overlay open. In that window the
  // two conditions above are both true over a live workspace, and this shell
  // mounted the public chrome on top of it: a phantom second nav bar (in the
  // bottom-row era, a phantom bottom row) that vanished on the next render,
  // plus the band's worth of layout shift. The mount flag is a positive fact
  // about what is on screen (`stores/workspaceSurface.ts`), so whatever the
  // URL says mid-transition, the workspace's own chrome rules while it is up.
  const workspaceMounted = useWorkspaceSurface((s) => s.mounted)
  const barSurface = mode !== 'workspace' && !overlayOpen && !workspaceMounted
  const showPublicBar = barSurface && !authLoading

  return (
    <LayoutModeContext.Provider value={mode}>
      <div
        data-layout-mode={mode}
        style={
          {
            '--ah-bar-band': `${barSurface ? BAR_BAND : 0}px`,
          } as React.CSSProperties
        }
      >
        {mode === 'platform' && !overlayOpen && <ComposeOverlay />}
        {/* `min-height: 100dvh` and nothing else. `dvh` not `vh`: on mobile
            Safari `100vh` is the tallest the viewport ever gets, so a fitted
            vessel measured against it hides its bottom wall behind the browser
            chrome. No bottom padding here — see the note above. */}
        <main style={{ minHeight: '100dvh' }}>{children}</main>
        {showPublicBar && <PublicNavBar />}
        {/* Mounted unconditionally — bylines anywhere (incl. the workspace) open it. */}
        <ProfileOverlay />
        {/* Mounted unconditionally — source/tag/publication links anywhere (e.g.
            the FeedComposer source rows) open it without escaping the workspace. */}
        <SurfaceOverlay />
        {/* Mounted unconditionally — "write an article" is reachable from the
            workspace, the dashboard overlay, and the note→article handoff. */}
        <EditorOverlay />
        {/* Mounted unconditionally — any surface (profile avatars, …) enlarges
            an image by calling useLightbox.open(); floats above everything. */}
        <LightboxOverlay />
        {/* Headless — applies persisted palette overrides on boot (the permanent
            hydration mechanism, CLAUDE.md). Always mounted; no UI. */}
        <PaletteHydrator />
        {/* Headless — applies the persisted per-device type-size preference on
            boot. Always mounted; no UI. */}
        <TypeScaleHydrator />
        {/* Headless — applies the persisted per-device light/dark/system
            appearance on boot + tracks the OS preference live. No UI. */}
        <ColorSchemeHydrator />
        {/* Headless — redeems a stashed external tribute-claim token once auth
            resolves (the claim survives signup). Dark behind TRIBUTES_ENABLED. */}
        <TributeClaimResumer />
        {/* Operator-only colour-tuning kit (not a Glasshouse — floats above all
            surfaces, page stays sharp). No shipped menu/settings entry; reach it
            via ?palette or the Ctrl+Alt+P chord (GLASSHOUSE-AND-PALETTE-ADR
            §III.5). Renders null until opened. */}
        <PalettePanel />
      </div>
    </LayoutModeContext.Provider>
  )
}
