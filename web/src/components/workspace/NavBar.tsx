"use client";

import { GRID } from "../../lib/workspace/grid";

// =============================================================================
// NavBar — the fixed desktop workspace toolbar (WORKSPACE-COLUMN-LAYOUT-ADR
// §VI, as re-oriented 2026-08-25).
//
// IT RUNS ALONG THE TOP OF THE SCREEN. A full-width band pinned to the top
// edge, with the ∀ lockup docked at its LEFT end and the muster (the numbered
// feed roundels) docked at its RIGHT. It has now been all three: a full-width
// row along the BOTTOM, a full-height rail up the LEFT margin (2026-08-24, the
// "hinge"), and — since 2026-08-25 — this. The hinge is gone: nothing in the
// bar is turned, nothing reads bottom-to-top, and no occupant needs an
// exemption to stay legible. That is most of what the turn cost, handed back.
//
// THE ARRANGEMENT, WHICH IS THE THING TO CHECK A CHANGE AGAINST:
//
//   • the LOCKUP docks at the LEFT end — disc first, wordmark to its right,
//     reading ∀ · all.haus, the mark before its name;
//   • the MUSTER docks at the RIGHT end and runs left→right, 1 first, which is
//     also the floor's own order — so the muster is a scale model of the floor's
//     axis again, which it stopped being under the hinge;
//   • ALL TYPE IS HORIZONTAL. No writing modes, no rotations. The rail needed
//     `vertical-rl` for the wordmark and the About pill, and the muster had to
//     be granted an outright exemption because a lone "1" turned on its side
//     reads as a dash. None of that survives the move, and none of it should be
//     reintroduced;
//   • the ∀ menu, the search fly-out and the muster's hover labels all open
//     DOWNWARD, into the floor — the only direction with room.
//
// (`ForallMenu` `anchor="row"` owns the lockup; `Muster` owns the roundels.
// This component is the bar's chrome only — the band and its ground, nothing
// else. See NO DIVIDER.)
//
// GLOBAL CHROME, NOT A FEED ISLAND: the ground is `var(--ah-bone)`, a neutral
// slug, so the bar inverts with `html.dark` rather than carrying a per-feed
// colourway. Same treatment as the mobile bar.
//
// NO DIVIDER. Carried unchanged through both moves: no slab along the bar's
// bottom edge, and never a thinner rule in its place (the sitewide
// no-single-pixel-lines invariant forbids one outright). The bar is a silent
// reserved band; the lockup docked at its left end is indicator enough.
//
// Z-ORDER: z-58, the row's and the rail's before it — above the Glasshouse
// scrim (z-55) and pane (z-56) so navigation stays live over any open pane,
// below the ∀ disc (z-60) and the lightbox (z-70).
//
// THE FLOOR NEVER REACHES BEHIND IT, AND THE MECHANISM IS THE RAIL'S, TURNED —
// NOT THE BOTTOM ROW'S. The original row reserved its space inside the
// derivation (`deriveGeometry`'s old `navRowH`, which ended the available
// height one GRID above it). This bar does what the rail did instead: it insets
// the SCROLL VIEWPORT — `WorkspaceView` offsets the Floor by `NAV_BAR_H`
// and hands derivation a `vp.h` already shortened by it — so content clips at
// the bar's inner edge exactly as it clips at the window's, and there is one
// number doing the reserving rather than two that can disagree. `navRowH` stays
// deleted from `Viewport`; do not bring it back.
// =============================================================================

/** Clearance above the lockup: one GRID, the same inset the bottom row and the
 *  left rail each took from the edge they docked against. The lockup reads its
 *  `top` straight off this rather than centring itself in the band — see below
 *  for why it must not centre. */
export const NAV_BAR_INSET = 8;

/** Bar height in px. Fed to the Floor as its top offset and subtracted from the
 *  workspace viewport height before derivation.
 *
 *  THE DISC IS NOT CENTRED IN THE BAR, AND THE HEIGHT IS WHY. What a reader
 *  actually sees above the ∀ is the window edge, and what they see below it is
 *  the first vessel — never the bar's own bottom edge, which is invisible (the
 *  band's `bone` ground and the floor are the same colour). So the two gaps that
 *  must match are `disc.top` and `firstVessel.top − disc.bottom`, and the floor
 *  contributes a GRID of its own to the second: `deriveGeometry` starts its
 *  columns one GRID down (§III.2's top buffer). Centring the disc in the band
 *  makes those gaps 8 and 16 — which is what shipped on 2026-08-25 and reads as
 *  the bar sitting too heavily on the workspace.
 *
 *  Equalising them has exactly one solution, and it is not a centred disc: put
 *  the disc's top at one GRID and let its BOTTOM be the band's bottom edge, so
 *  the floor's own top buffer supplies the matching GRID below. Hence
 *  `INSET + disc` and nothing more. A centred disc cannot be made to work by
 *  choosing a different height — the floor's buffer adds its GRID to the lower
 *  gap whatever the band does, so the two differ by a GRID at every height.
 *
 *  It follows that the 40px disc is load-bearing on this number: change the disc
 *  and this must change with it. Every other occupant aligns on the LOCKUP's
 *  centre line (`NAV_BAR_INSET` down from the top), not the band's — see the
 *  muster's `paddingTop`. */
export const NAV_BAR_H = NAV_BAR_INSET + 40;

/** The band the EYE reads as the bar: `NAV_BAR_H` plus the floor's own GRID
 *  top buffer beneath it (`deriveGeometry` starts every column one GRID down).
 *  The bar's true bottom edge at `NAV_BAR_H` is invisible by construction —
 *  band and floor are both `bone` — and the whole of the geometry above is
 *  licensed by that invisibility, so NOTHING may draw an edge there: no dimming
 *  layer starts above this line (`.gh-scrim`, both Explain scrims,
 *  `--ah-bar-band`), and no pane's y may come above it (`Glasshouse.minYFor` —
 *  a pane flush at `NAV_BAR_H` traces the true edge with its own top). This is
 *  the ONE home for the number; every consumer imports it rather than adding
 *  `NAV_BAR_H + GRID` itself, so the two Explain modes and the frost cannot
 *  drift apart again (web/CLAUDE.md › *A dimming layer must not draw an
 *  edge*). */
export const NAV_BAR_BAND = NAV_BAR_H + GRID;

export function NavBar() {
  return (
    <div
      aria-hidden="true"
      // Explain chrome: the bar sits above the floor-mode Explain scrim (z-50),
      // so it is never dimmed and its pointer events never reach the scrim's
      // hit-test. Marking it chrome keeps the annotation walk and the focus
      // guard from treating it as an annotatable surface.
      data-explain-chrome=""
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        height: NAV_BAR_H,
        background: "var(--ah-bone)",
        zIndex: 58,
      }}
    />
  );
}
