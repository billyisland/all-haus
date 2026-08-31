'use client'

import type { CSSProperties, ReactNode } from 'react'
import { LIGHT_ISLAND_STYLE } from '../../lib/palette/island'
import { usePublicPalette, scrollThumb, PAD, GAP } from './palette'

// =============================================================================
// PublicVessel — the SINGLE-WALL ⊔. Chassis for every logged-out page except
// `/`.
//
// WHY SINGLE, WHEN `/` IS DOUBLED. The doubled wall on the landing page is an
// argument: wall / 8px buffer / wall makes the lattice read as even stripes, so
// a visitor meets the measure before they ever meet a feed. That is worth a
// frame's weight on the one page whose whole job is to state the house's terms.
// It is not worth it around a login form — there the vessel is holding four
// fields, and a doubled frame would make the page look like it is announcing
// something when it is only asking for an email. One wall, same 8px, same
// stance. (On a PHONE even one wall is too much, and there are none: the same
// argument, applied to a screen where the form is the only thing on it.)
//
// THE VESSEL IS ALWAYS WHOLLY ON SCREEN; ITS CONTENTS SCROLL (amended
// 2026-07-25 after the landing-page build). The interior is a scroll body —
// `minHeight: 0`, `overflowY: auto`, with PAD on the scroll body itself. That
// last detail is deliberate and is copied from Vessel.tsx: putting the padding
// on the scrolling element means the interior padding TRAVELS WITH THE CARDS
// rather than framing them, so the first card starts at the mouth and the last
// one ends at the wall. Padding on the frame instead would leave a dead band at
// top and bottom that content slides under, which looks like a bug.
//
// AND IT IS NO TALLER THAN WHAT IT HOLDS (2026-07-27). Both the frame and the
// scroll body are `flex: 0 1 auto`, so a page with four fields gets a ⊔ four
// fields tall, centred in the viewport by PublicShell, instead of one stretched
// to the full fitted remainder — which on a tall monitor was a frame drawn
// around a great deal of nothing. Read the two amendments together: the 2026-07-25
// one says the vessel must never be TALLER than the viewport (its bottom wall
// has to be on screen, or it isn't a vessel), and this one says it must never be
// taller than its CONTENT either. Both are the same instinct — the ⊔ is a
// container, and a container should fit what is in it.
//
// ON MOBILE THERE ARE NO WALLS AT ALL — see `.ah-public-vessel` in globals.css
// §1a-bis, which is also where the wall widths live, because an SSR'd page
// cannot pick its form factor in JS.
//
// `data-vessel-scroll` is carried for parity with the workspace's scroll bodies
// — anything that queries for a scrollable vessel region finds this one too.
//
// WHAT HAPPENS AT THE MOUTH. The top is OPEN (⊔), so scrolled content is
// clipped at a line where there is no wall. Under `basic` the interior and the
// floor are the same colour, so a card passing the mouth doesn't cut against an
// edge — it slides out of the vessel and onto the page, which is what a vessel
// with a mouth should look like. If that ever reads as broken rather than as
// open, the fix is a top wall on the fitted variant (making it a box, and
// losing the ⊔) — NOT a fade, which would be a gradient, which the house
// doesn't have.
//
// WHAT IT INHERITS FROM LandingVessel, DELIBERATELY. Square corners. Cards on a
// continuous interior ground. No numeral, no descriptive-name roundel, no 32px
// VesselBar: all three say "feed n of m", which no public page can claim. So
// the bottom is a plain wall — the live workspace never shows that shape. This
// is the abstraction, not a stale render: do NOT "fix" it by reinstating
// VesselBar.
//
// COLOUR. LIGHT_ISLAND_STYLE pins the derived neutral slugs so BASIC_DARK's
// explicit values aren't inverted a second time by html.dark; the palette
// itself is resolved against the resolved dark flag in usePublicPalette. See
// the note there — the two travel together.
// =============================================================================

interface PublicVesselProps {
  children: ReactNode
  /** Extra style on the vessel frame (rarely needed; prefer the shell's measure). */
  style?: CSSProperties
}

export function PublicVessel({ children, style }: PublicVesselProps) {
  const palette = usePublicPalette()

  return (
    <div
      className="ah-public-vessel"
      style={
        {
          ...LIGHT_ISLAND_STYLE,
          // The walls are `.ah-public-vessel` in globals.css §1a-bis, not here:
          // they have to disappear on mobile, and an SSR'd page cannot pick that
          // in JS. What stays inline is what CSS cannot know — the palette-
          // derived wall colour, handed over as a custom property.
          '--ah-public-wall': palette.walls,
          background: palette.interior,
          // HUGS ITS CONTENT, then shrinks if there is more of it than room.
          // `0 1 auto` (not `1 1 0`): no growing, so a short page's ⊔ is exactly
          // as tall as what it holds and the shell centres it; shrink stays on,
          // with `minHeight: 0`, so a long page still gives its scroll body a
          // scrollbar rather than pushing the bottom wall off screen.
          flex: '0 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          ...style,
        } as CSSProperties
      }
    >
      <div
        data-vessel-scroll=""
        className="ah-vessel-scroll"
        style={{
          // The scrollbar thumb, handed to CSS as a variable. It was originally
          // `currentColor` in the stylesheet on the claim that the scroll body
          // inherits the walls colour from the frame — it does not; nothing sets
          // `color` on the frame, so it picked up whatever text colour was
          // ambient. Passing it explicitly also lets the thumb use a card-
          // relative grey rather than the wall colour, which is invisible in
          // dark (see the note in palette.ts).
          ['--ah-scroll-thumb' as string]: scrollThumb(palette),
          padding: PAD,
          // Matches the frame: hug the cards, shrink and scroll when there are
          // more of them than fit. `1 1 0` here would have re-stretched the
          // vessel the frame just stopped stretching.
          flex: '0 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: GAP,
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ─── Card ───────────────────────────────────────────────────────────────────
//
// The vessel's only content primitive. Cards sit in the scroll body at a
// uniform GAP; nothing else does. `flexShrink: 0` so a tall stack scrolls
// rather than compressing every card to fit — a squashed card is never the
// right answer to "there is more here than fits".

interface PublicCardProps {
  children: ReactNode
  style?: CSSProperties
}

export function PublicCard({ children, style }: PublicCardProps) {
  const palette = usePublicPalette()

  return (
    <div
      style={{
        background: palette.cardBg,
        padding: '18px 20px',
        flexShrink: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ─── Title / body ───────────────────────────────────────────────────────────
//
// The public register's two type roles, matching LandingVessel exactly: serif
// for anything that makes a claim, mono for prose. There is no third. The
// retired register had a `font-sans text-xl font-bold` heading on /auth/verify
// that belonged to neither — that is what these exist to stop recurring.

export function PublicTitle({
  children,
  size = 28,
  as: Tag = 'h1',
}: {
  children: ReactNode
  size?: number
  as?: 'h1' | 'h2'
}) {
  const palette = usePublicPalette()

  return (
    <Tag
      className="font-serif font-medium tracking-tight"
      style={{
        fontSize: size,
        lineHeight: 1.2,
        color: palette.cardTitle,
        margin: 0,
      }}
    >
      {children}
    </Tag>
  )
}

export function PublicBody({
  children,
  muted = true,
}: {
  children: ReactNode
  muted?: boolean
}) {
  const palette = usePublicPalette()

  return (
    <p
      className="font-mono"
      style={{
        fontSize: '1.0625rem',
        lineHeight: 1.65,
        letterSpacing: '0.01em',
        color: muted ? palette.cardStandfirst : palette.cardTitle,
        margin: 0,
      }}
    >
      {children}
    </p>
  )
}
