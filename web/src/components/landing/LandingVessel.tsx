'use client'

import type { CSSProperties } from 'react'
import { paletteFor } from '../workspace/tokens'
import { LIGHT_ISLAND_STYLE } from '../../lib/palette/island'
import { useResolvedDark } from '../../stores/colorScheme'
import { ForallDisc } from '../brand/ForallDisc'
import { LandingFigure } from './LandingFigure'
import { CanvasDemo } from './demos/CanvasDemo'
import { OmnivoreDemo } from './demos/OmnivoreDemo'
import { ReaderDemo } from './demos/ReaderDemo'

// =============================================================================
// LandingVessel — `/`'s chassis. An ABSTRACTION of the workspace vessel, not a
// picture of one.
//
// IT FILLS THE SCREEN AND SCROLLS INSIDE, like a workspace feed. The vessel is
// sized to the app-shell column (page.tsx: a `100dvh` flex column, vessel area
// above, nav row below) via `flex: 1; minHeight: 0`, so it is always fully
// visible on screen — walls, mouth and bottom all in frame — and the CARD
// COLUMN scrolls within it (the innermost `overflowY: auto` region, the same
// `flex:1 / minHeight:0 / overflowY:auto` body Vessel.tsx scrolls). There is no
// document scroll on `/` at all, which is what killed the mobile rubber-band:
// the shell is pinned to the viewport and only the card column moves.
//
// WHAT IT DELIBERATELY OMITS. A feed vessel carries a numeral in the reserved
// bottom-left square, a descriptive-name roundel, and a 32px VesselBar that
// REPLACES the bottom wall. All three are gone here, on purpose: they say "feed
// n of m", which is a claim the landing page cannot make — there are no feeds
// on it and the visitor has no account to hold any. What survives is the part
// that is actually the house style: the ⊔ stance, the 8px wall, the 8px
// lattice, square corners, cards on a continuous ground that scroll as a column.
//
// SO THE BOTTOM IS A PLAIN WALL. The live workspace never shows that shape —
// there the bar always occupies the bottom edge. This is the abstraction, not a
// stale render: do NOT "fix" it by reinstating VesselBar. If the landing page
// ever needs a control down there, it wants a new thing, not the feed's.
//
// THE DOUBLED WALL (the one addition), ON DESKTOP. Wall, one GRID of interior,
// wall — so the lattice reads as even stripes at the page's own edge, which is
// the reading WORKSPACE-DESIGN-SPEC asks the grid square to have (grid square ≈
// wall thickness, so wall/buffer/wall stripes evenly). A visitor meets the
// measure before they ever meet a feed. Both frames open at the top: the mouth
// is the arrival end, and closing it would make this a box rather than a vessel.
// Both frames clip (`overflow: hidden`) so the scrolling column reads as feed
// cards passing behind a fixed mouth, exactly as a workspace vessel does.
//
// ON MOBILE THERE IS NO VESSEL. It goes full-bleed, the doubled wall collapses
// to a single one, and (2026-07-27) that one goes too: the column runs on the
// bare floor with 8px of pad and no ⊔ anywhere. The ⊔ says "one object among
// several", which is true of a feed on a workspace floor and false of the only
// column on a phone screen — the same conclusion the mobile workspace reached
// when it dropped the vessel chassis outright. THE GEOMETRY FOR BOTH FORM
// FACTORS LIVES IN globals.css §1c
// (`.ah-landing-area`, `.ah-landing-frame*`), not in this file: `/` is SSR'd, so
// a JS breakpoint would paint the desktop chassis on a phone and snap after
// hydration. Change wall thickness or padding THERE. What stays here is the
// palette-derived wall colour, handed to the CSS as `--ah-landing-wall`.
//
// NO CALL TO ACTION IN HERE. The waiting-list button lives once, in the nav row,
// where it is on screen for the whole page rather than only at the foot of it.
//
// THE SCROLL EARNS ITS KEEP: sell text, then a SHOWCASE of three DEMOS, then a
// closing CODA (the ∀ disc + the motto 'FOR ALL', centred) that ends the column.
//
// -----------------------------------------------------------------------------
// THE DEMOS ARE LIVE MARKUP, NOT SCREENGRABS. This replaced three `.webp` files
// under web/public/landing (and the `Shot` type, `SHOT_RATIO`, `LandingShot` and
// its missing-image fallback, all now deleted). The reason was not file size:
//
//   · EVERY SHOT WAS A FULL 1848×1056 VIEWPORT CAPTURE shown ~640px wide inside
//     a card at the prose measure. That is a 2.9× reduction, which put the app's
//     15px body type at about 5px. The pictures became grey texture and the
//     CAPTIONS carried the whole argument — which is the definition of a
//     decorative image, and these were meant to be evidence.
//   · THE FRAME TOOK ITS RATIO FROM THE CAPTURES ("cut to fit them rather than
//     the other way round"), which sounded principled and was in fact the trap:
//     it locked all three figures to 16:9 landscape, the worst possible shape
//     for showing interface detail in a narrow column.
//   · SCREENSHOTS ROT. Every colour retune, copy fix and card-grammar change
//     silently dated them, with nothing in CI to notice.
//
// Rebuilt as components, each demo is legible at the measure it is actually
// shown at, inverts with the global toggle for free, re-proportions itself for
// mobile, and cannot drift from the palette because it reads the same tokens.
//
// THEY ARE SIZED AS A SET, AND DELIBERATELY UNEQUALLY. Each demo's root sets one
// `fontSize` in px and everything inside it is `em`, so a demo has a single
// register knob. The three are tuned against the page's own 17px prose:
//
//   · OmnivoreDemo  14.5px  — the LARGEST, and a fixed px. It carries content a
//                             visitor is meant to read; the four VIA lines are
//                             the argument, and a single column has the width to
//                             hold them at any sane viewport.
//   · ReaderDemo    12px    — a specimen. The article text inside the pane is
//                             filler, so it must not invite reading; the pane
//                             and scrim now carry the "this is a demo" signal
//                             structurally, which is why it no longer needs the
//                             inset the bare gate did.
//   · CanvasDemo    FLUID   — `clamp(8.5px, 1.95cqw, 12px)` off a container
//                             query, because its ARRANGEMENT is its argument and
//                             must not reflow. See the long note in CanvasDemo:
//                             it scales rather than rearranges, and sheds card
//                             detail rather than shrinking into illegibility.
//
// Each is sized to its job rather than to the shape of a source capture, which
// is the substantive difference from what was here before.
// -----------------------------------------------------------------------------
//
// THE PROPOSITIONS ARE A REAL <ol>. They are literally three numbered
// propositions, so the list is the ordered list, not div-soup with a decorative
// numeral — a screen reader announces "list, 3 items" and the count. The <ol>
// is one flex child of the scroll column with the same GAP as its siblings; the
// crimson numeral is presentational (the <li> position already carries order).
//
// COLOUR. `basic` follows the global light/dark toggle — that is the whole
// point of the neutral colourway. The palette is resolved with the resolved dark
// flag exactly as Vessel.tsx resolves its own, and LIGHT_ISLAND_STYLE then pins
// the derived neutral slugs so BASIC_DARK's explicit values aren't inverted a
// second time by html.dark. Copy the pair or neither. The flag is
// useResolvedDark (the DOM class the pre-paint script set), not the store's
// lagging `dark`, so a dark-mode visitor never paints the light vessel on the
// dark floor first.
//
// THE SAME FLAG GOES TO CanvasDemo and ReaderDemo, which resolve four seasonal
// colourways apiece for their feeds. Both take the flag as a prop rather than
// calling the hook themselves, so the demos stay hook-free and inert.
// =============================================================================

const GAP = 12 // inter-card gap

/** Which demo a figure mounts. Copy for each lives in page.tsx. */
export type FigureKey = 'canvas' | 'omnivore' | 'reader'

export interface Figure {
  key: FigureKey
  /** The visible claim under the demo. */
  caption: string
  /** The accessible equivalent of seeing it. */
  description: string
}

interface LandingVesselProps {
  headline: string
  propositions: string[]
  prose: string[]
  figures: Figure[]
}

export function LandingVessel({
  headline,
  propositions,
  prose,
  figures,
}: LandingVesselProps) {
  const globalDark = useResolvedDark()
  const palette = paletteFor('basic', globalDark)

  // A ⊔ frame that fills its flex parent and clips its overflow. Both frames use
  // it — outer and inner. The WALL THICKNESS AND PADDING ARE NOT HERE: they are
  // `.ah-landing-frame*` in globals.css (see the CSS comment). What stays inline
  // is what CSS cannot know: the palette-derived wall colour, handed over as
  // `--ah-landing-wall`, and the interior.
  const frame = {
    background: palette.interior,
    flex: 1,
    minHeight: 0,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    overflow: 'hidden' as const,
  }

  const card = {
    background: palette.cardBg,
    padding: '18px 20px',
  }

  const demoFor = (key: FigureKey) => {
    switch (key) {
      case 'canvas':
        return <CanvasDemo dark={globalDark} />
      case 'omnivore':
        return <OmnivoreDemo palette={palette} />
      case 'reader':
        return <ReaderDemo palette={palette} dark={globalDark} />
    }
  }

  return (
    <div
      className="ah-landing-frame ah-landing-frame-outer"
      style={
        {
          ...LIGHT_ISLAND_STYLE,
          ...frame,
          '--ah-landing-wall': palette.walls,
        } as CSSProperties
      }
    >
      <div className="ah-landing-frame ah-landing-frame-inner" style={frame}>
        {/* The scrolling card column — the one moving part. `.scroll-silent`
            hides the native scrollbar (whose track would draw a banned vertical
            rule); wheel / touch / keyboard scroll are unaffected. */}
        <div
          className="scroll-silent"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: GAP,
          }}
        >
          <div style={card}>
            <h1
              className="font-serif font-medium tracking-tight"
              style={{
                fontSize: 30,
                lineHeight: 1.2,
                color: palette.cardTitle,
                margin: 0,
              }}
            >
              {headline}
            </h1>
          </div>

          <ol
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: GAP,
              listStyle: 'none',
              margin: 0,
              padding: 0,
            }}
          >
            {propositions.map((proposition, i) => (
              <li key={i} style={card}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <span
                    aria-hidden="true"
                    className="font-mono text-mono-sm"
                    style={{ color: palette.crimson, paddingTop: 3 }}
                  >
                    {i + 1}
                  </span>
                  <span
                    className="font-serif"
                    style={{
                      fontSize: 22,
                      lineHeight: 1.4,
                      color: palette.cardTitle,
                    }}
                  >
                    {proposition}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          <div style={card}>
            <div
              className="font-serif"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                fontSize: 17,
                lineHeight: 1.6,
                color: palette.cardStandfirst,
              }}
            >
              {prose.map((para, i) => (
                <p key={i} style={{ margin: 0 }}>
                  {para}
                </p>
              ))}
            </div>
          </div>

          {figures.map((figure) => (
            <div key={figure.key} style={card}>
              <LandingFigure
                palette={palette}
                caption={figure.caption}
                description={figure.description}
              >
                {demoFor(figure.key)}
              </LandingFigure>
            </div>
          ))}

          {/* Closing coda — the mark, then the motto. Ends the scroll. Its own
              padding (not the shared `card` spread) so it can breathe as a
              finale. */}
          <div
            style={{
              background: palette.cardBg,
              padding: '40px 20px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 18,
            }}
          >
            <ForallDisc size={64} />
            <span
              className="font-mono"
              style={{
                color: palette.cardStandfirst,
                fontSize: 13,
                letterSpacing: '0.2em',
              }}
            >
              &lsquo;FOR ALL&rsquo;
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
