'use client'

import Link from 'next/link'
import { useResolvedDark } from '../../stores/colorScheme'
import { LIGHT_ISLAND_STYLE } from '../../lib/palette/island'
import { ForallDisc } from './ForallDisc'

// =============================================================================
// ForallLockup — the STATIC lockup (wordmark + ∀ disc, adjacent) for surfaces
// that need the mark but not the menu.
//
// `ForallMenu anchor="row"` is the member lockup: it carries the workspace
// menu, the ∀↔X morph, the hover spin, the unread badge and the Explain
// chrome-swap. A logged-out visitor has no workspace to navigate, so mounting
// it on `/` would ship ~950 lines of menu for a mark. This component renders
// the same two things in the same relationship and nothing else. The disc
// itself is `ForallDisc` (the ADR-locked geometry lives there); this component
// owns only the wordmark + their pairing.
//
// The wordmark matches the disc's GROUND, not its glyph — ink on the light row,
// bone on the inverted one — so it reads `useResolvedDark` the same way the disc
// does. That single boolean is the only reason this is a client component.
//
// THE LOCKUP CARRIES THE LIGHT ISLAND, AND IT IS LOAD-BEARING, NOT DECORATION
// (fixed 2026-08-25). Both halves of the mark name their colours the way
// ForallMenu's locked-chrome disc does — `dark ? bone : ink-925` — and that
// idiom is only true where the slugs resolve CANONICAL, because `bone` is in
// DARK_SLUGS and `ink-925` is not. Inside an island (the landing coda, where
// ForallDisc is also mounted) the pair inverts as written. On a bare inverting
// ground it does not: `var(--ah-bone)` has already flipped to the dark end, so
// under `html.dark` the wordmark painted 20 19 17 on a row whose own bone
// background had flipped to exactly 20 19 17 — the mark, invisible, on every
// logged-out page and every chromeless tool surface at once. The disc went with
// it (dark ground, ink-925 glyph a shade off it: a faint outline).
//
// So the island belongs HERE rather than on PublicNavRow: the row is global
// chrome and must keep inverting, and it is the two-slug idiom inside the mark
// — not the row — that needs canonical ground to be read against. Islanded, the
// dark row gets a light disc with a dark glyph and a light wordmark, which is
// the photo-negative the workspace disc already renders.
//
// The bug is silent by construction: nothing errors, the element is in the DOM
// at full size with a real colour, and only a screenshot or a computed-style
// read says the colour equals its background. Any future mark that names a
// DARK_SLUG explicitly must sit in an island or be read the same way.
// =============================================================================

interface ForallLockupProps {
  /** Rendered disc diameter. 40 is the nav-row size; 40 + 2·GRID = NAV_ROW_H. */
  discSize?: number
  /** Wordmark size. 24 with a 40 disc holds §V's disc/cap-height ≈ 2.3. */
  wordmarkSize?: number
  href?: string
}

export function ForallLockup({
  discSize = 40,
  wordmarkSize = 24,
  href = '/',
}: ForallLockupProps) {
  const dark = useResolvedDark()
  const wordmarkColor = dark ? 'var(--ah-bone)' : 'var(--ah-ink-925)'

  return (
    <Link
      href={href}
      aria-label="all.haus home"
      style={{
        // Pins bone/ink-925 canonical for the subtree — see the header.
        ...LIGHT_ISLAND_STYLE,
        display: 'flex',
        alignItems: 'center',
        // §V's 14px wordmark↔disc gap. Drop to 12 only if the pair reads loose.
        gap: 14,
        flexShrink: 0,
      }}
    >
      {/* Wordmark set to the LEFT of the disc so the two read as one mark
          (text · glyph). */}
      <span
        className="font-sans font-medium leading-none"
        style={{
          fontSize: wordmarkSize,
          color: wordmarkColor,
          letterSpacing: '-0.01em',
        }}
      >
        all.haus
      </span>

      <ForallDisc size={discSize} />
    </Link>
  )
}
