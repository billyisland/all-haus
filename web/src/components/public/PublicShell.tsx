'use client'

import type { ReactNode } from 'react'
import { usePublicPalette } from './palette'

// =============================================================================
// PublicShell — the bone floor and the measure, FITTED TO THE VIEWPORT.
//
// THE PAGE DOES NOT SCROLL. THE VESSEL DOES. (Amended 2026-07-25 after the
// landing-page build.) The first cut let the vessel grow to its content and let
// the page scroll to find its bottom wall. That reads badly for a reason worth
// stating: a ⊔ whose closing wall is below the fold isn't a vessel, it's a
// left-and-right pair of rules, and the visitor has to scroll to discover the
// shape they were supposed to meet on arrival. It also contradicts the
// workspace, where a feed vessel is always wholly on screen and its cards move
// inside it.
//
// So the shell is a fixed-height flex column, and the vessel may never be
// taller than it. See PublicVessel for the scroll body, which mirrors
// Vessel.tsx's (`minHeight: 0`, `overflowY: auto`, PAD on the scroll body so
// the interior padding scrolls with the cards rather than framing them).
//
// BUT THE VESSEL NO LONGER TAKES THE REMAINDER (amended 2026-07-27). It hugs
// its content and this shell CENTRES it, on both axes — `justify-content:
// center` in `.ah-public-fit` beside the `align-items: center` that was always
// there. The first cut stretched it, so `/auth`'s four fields sat in a ⊔ as
// tall as the screen: a frame around a great deal of nothing, worse the taller
// the monitor. A roughly square card should sit in a roughly square vessel, in
// the middle of the screen. The fitted height is what stops the vessel
// exceeding the viewport; the hug is what stops it exceeding its content. Both
// bounds are live at once, which is why `flex-shrink` and `minHeight: 0` stay
// on every link of the chain (this column → frame → scroll body).
//
// THE HEIGHT MATH LIVES IN CSS, in `.ah-public-fit` (globals.css), because the
// short-viewport fallback is a media query and belongs there rather than in a
// JS branch. Above 480px tall the box is `100dvh`; below it (landscape phones,
// split-screen) the fit is abandoned — the remainder would be too little to
// hold a card — and it becomes `min-height` so the page scrolls normally.
// Either way the nav row's band is PADDING INSIDE the box, not subtracted from
// its height, so this element's floor paints the whole way down to the row
// rather than leaving the band's GRID of clearance showing `body` through.
// `--ah-row-band` is set by LayoutShell when the row is mounted, 0 otherwise.
//
// `dvh`, NOT `vh`. On mobile Safari `100vh` is the tallest the viewport ever
// gets, so a `vh`-fitted vessel hides its bottom wall behind the browser chrome
// — which is the exact bug this amendment exists to fix.
//
// THE FLOOR IS `palette.interior`, NOT `var(--ah-bone)` — changed by the
// dark-mode audit, 2026-07-25, and this is the one substantive design change it
// forced. The whole register rests on floor and interior being the SAME colour:
// that is what makes the walls read as ink rules laid on a continuous ground
// rather than as a box drawn around content, and it is why content scrolling
// out of the open mouth simply vanishes rather than cutting against a seam.
//
// `var(--ah-bone)` delivers that in light (bone 240 239 235 == BASIC_LIGHT's
// interior, which is itself `var(--ah-bone)`). In DARK it does not:
// `html.dark` takes bone to 20 19 17, while BASIC_DARK's interior is
// `--ah-ink-925` (26 26 24), which is not a DARK_SLUG and doesn't move. Six
// points apart on a near-black ground is enough to read as a panel edge — so in
// dark the vessel became the box the design exists to avoid, with true-black
// walls barely visible around it.
//
// `palette.interior` is correct in BOTH modes without an island, because the
// variant selection has already done the work: BASIC_LIGHT.interior is
// `var(--ah-bone)` (240 out here, where html.dark isn't applied) and
// BASIC_DARK.interior is `var(--ah-ink-925)` (26). Floor == interior, exactly,
// in both.
//
// NOTE THE DIVERGENCE FROM THE WORKSPACE, which is deliberate and worth
// knowing: there the floor IS `--ah-bone` and the vessels' interiors are
// ink-925, so feeds read as islands ON a floor. That is right for a workspace
// holding many feeds. It is wrong for a page holding one vessel that is
// pretending not to be a feed.
//
// TWO MEASURES, NO MORE. `prose` (720) is `/` and `/about`. `form` (480) is
// everything that asks the visitor for something.
// =============================================================================

type Measure = 'prose' | 'form'

const WIDTH: Record<Measure, number> = {
  prose: 720,
  form: 480,
}

interface PublicShellProps {
  children: ReactNode
  measure?: Measure
}

export function PublicShell({ children, measure = 'form' }: PublicShellProps) {
  const palette = usePublicPalette()

  return (
    <div className="ah-public-fit" style={{ background: palette.interior }}>
      <div
        style={{
          width: '100%',
          maxWidth: WIDTH[measure],
          // The vessel is the only child, and this column is now sized BY it
          // rather than handing it the remainder: `0 1 auto` so a short page's
          // vessel keeps its own height and the shell's centring can act on it.
          // `minHeight: 0` is still load-bearing — without it this flex child
          // refuses to shrink below its content when there IS more content than
          // room, and the scroll body inside never gets a scrollbar.
          flex: '0 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  )
}
