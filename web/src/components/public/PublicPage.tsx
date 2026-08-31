'use client'

import type { ReactNode } from 'react'

// =============================================================================
// PublicPage — the SCROLLING counterpart of PublicShell, for the standalone
// share/SEO surfaces.
//
// THESE PAGES HAVE NO VESSEL, ON PURPOSE. Everything else in the public
// register is content inside a ⊔. These are not: they are the reading
// experience itself — a shared article, a writer's profile, a tag. Putting a
// frame around an article puts a box around the one thing the site exists to
// deliver, and the frame would then have to scroll internally, which is exactly
// the wrong behaviour for a long read. So: bone floor, the page's own body,
// ordinary page scroll.
//
// WHICH MEANS THE ROW BAND WORKS THE OPPOSITE WAY ROUND HERE. A fitted page
// (PublicShell) reserves `--ah-row-band` at the foot of a viewport-height box
// so the vessel sits clear of the nav row. A scrolling page adds it as bottom
// padding so its last line clears the row. Both read the same variable; neither
// could use the other's rule.
//
// THE GROUND IS A FULL `100dvh`, WITH THE BAND AS PADDING INSIDE IT — not
// `calc(100dvh - band)` with the padding on top. Both keep the CONTENT clear of
// the row, but only the first paints the ground the whole way down. The band is
// NAV_ROW_H + GRID while the row is only NAV_ROW_H tall, so the GRID of
// deliberate clearance above the row has to be painted by something: under the
// `calc` form it fell through to `body` (white in light, ink-900 in dark) and
// drew an 8px stripe between the page and the row. Here it is the page's own
// floor. `box-sizing: border-box` (preflight) means the padding is inside the
// 100dvh, so short content still comes to exactly one viewport and doesn't
// invent a scrollbar.
//
// `ground` IS OPTIONAL because some of these surfaces bring their own.
// ArticleReader's root is `min-h-screen bg-white` — it is a reading surface and
// owns its ground. Painting bone behind it would be a layer nobody sees.
//
// AND `ground={false}` DROPS THE `minHeight` TOO — a child that owns its ground
// owns its height, because in practice it says so with `min-h-screen`. Keeping
// both would stack a full viewport inside a full viewport and leave the band's
// worth of dead scroll at the foot of every short article. So the two cases are:
// ground -> a 100dvh box with the band as padding inside it; no ground -> the
// band alone, and the child decides how tall the page is.
//
// WHAT THIS COMPONENT MUST NOT DO IS TOUCH THE BODIES. Every one of these
// routes renders a component that is ALSO mounted inside a workspace overlay —
// ArticleReader in ReaderOverlay, TagBrowser and SourceSurface in
// SurfaceOverlay, AuthorProfileView and WriterActivity in ProfileOverlay. They
// are one component serving two registers, which is the right architecture (the
// share view and the overlay view should not drift), and it means any retired
// styling inside them is a WORKSPACE question, not a logged-out one. Restyling
// them from here would silently redesign the member surface. See §VII of the
// sweep doc for the audit.
// =============================================================================

interface PublicPageProps {
  children: ReactNode
  /** Paint the bone floor AND stand a full viewport tall. Pass false when the
   *  child supplies both (e.g. ArticleReader's `min-h-screen bg-white`). */
  ground?: boolean
  /** Centre the body at a pixel measure. Omit for full-bleed. */
  measure?: number
}

export function PublicPage({
  children,
  ground = true,
  measure,
}: PublicPageProps) {
  return (
    <div
      style={{
        background: ground ? 'var(--ah-bone)' : undefined,
        minHeight: ground ? '100dvh' : undefined,
        paddingBottom: 'var(--ah-row-band, 0px)',
      }}
    >
      {measure ? (
        <div style={{ maxWidth: measure, margin: '0 auto', width: '100%' }}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
