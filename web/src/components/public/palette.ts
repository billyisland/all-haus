'use client'

import { paletteFor, type VesselPalette } from '../workspace/tokens'
import { useResolvedDark } from '../../stores/colorScheme'

// =============================================================================
// usePublicPalette — the one colour source for the logged-out register.
//
// Every public surface resolves `basic` against the RESOLVED dark flag, exactly
// as LandingVessel does and for the same reason: `basic` is the neutral
// colourway, so unlike a seasonal scheme it has nothing to preserve against the
// global light/dark toggle — following the toggle is the whole point of
// choosing it. The flag is `useResolvedDark` (the DOM class the pre-paint
// script set), not the store's lagging `dark`, so a dark-mode visitor never
// paints the light chassis on the dark floor first.
//
// PAIRS WITH LIGHT_ISLAND_STYLE, WHICH PublicVessel APPLIES. Copy the pair or
// neither: the island alone would freeze the page light, the flag alone would
// let html.dark invert BASIC_DARK's explicit values a second time. Anything
// rendering public chrome OUTSIDE a PublicVessel (the nav row) sits on the
// plain `--ah-bone` floor and wants the un-islanded neutral slugs, so it does
// not carry the island — see PublicNavRow.
// =============================================================================

export function usePublicPalette(): VesselPalette {
  return paletteFor('basic', useResolvedDark())
}

/** Side-wall thickness. The workspace vessel's wall (Vessel.tsx). */
export const WALL = 8
/** The workspace lattice square. Equal to WALL by design (WORKSPACE-DESIGN-SPEC). */
export const GRID = 8
/** Vessel interior padding. */
export const PAD = 16
/** Inter-card gap inside a vessel. */
export const GAP = 12
/** The house's secondary slab weight (.slab-rule-4). Field underlines, outline
 *  buttons. Never thinner — the sitewide no-single-pixel-lines invariant. */
export const SLAB = 4

// =============================================================================
// DERIVED CONTROL TOKENS — added by the dark-mode audit, 2026-07-25.
//
// THE BUG THEY FIX. Every line in the register — field underlines, the outline
// button's border, the "or" divider, the indeterminate slab's track — was drawn
// in `palette.walls`. In LIGHT that is `--ah-ink` (17 17 17) against a white
// card: maximum contrast, and it looked right. In DARK `walls` is
// `--ah-true-black` (0 0 0) against `--ah-ink-900` (35 35 32). A 4px black line
// on a 35-value card is invisible. Every control in the register disappeared,
// including the Google button on `/auth`, whose entire visible form is its
// border.
//
// The mistake was using a STRUCTURAL token for a token that belongs to the
// CARD. `walls` is the vessel's frame; it is meant to recede in dark, and in
// the workspace it should. A line inside a card has to track the card.
//
// `controlLine` is `cardTitle`, which resolves to `--ah-ink` in light — BYTE-
// IDENTICAL to what `walls` gave there, so this is a no-op in light mode — and
// to islanded `--ah-bone` (240 239 235) in dark, where it reads as strongly as
// ink does on white. The symmetry is the point: 4px of ink on white and 4px of
// bone on ink-900 are the same gesture.
//
// If bone at 4px reads hot in dark once you see it, the fallback is
// `cardStandfirst` (stone-300, 180 178 169) — but that would also lighten the
// light mode, so change it here rather than at the call sites, and look at both.
//
// `scrollThumb` is separate because the scrollbar is chrome, not a control: it
// should be present without being an element. `cardMeta` (stone-400, 138 136
// 128) is outside DARK_SLUGS, so it is the same value in both modes and reads
// as a quiet grey against both the white and the ink-900 interior.
// =============================================================================

/** The line colour for anything inside a card: field underlines, outline
 *  borders, dividers, slab tracks. NEVER `palette.walls` — see above. */
export function controlLine(p: VesselPalette): string {
  return p.cardTitle
}

/** The vessel scrollbar thumb. Consumed as `--ah-scroll-thumb` by
 *  `.ah-vessel-scroll` in globals.css. */
export function scrollThumb(p: VesselPalette): string {
  return p.cardMeta
}
