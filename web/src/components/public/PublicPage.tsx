'use client'

import type { ReactNode } from 'react'
import { BarGround } from './BarGround'

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
// WHICH MEANS THE BAR BAND IS A PLAIN TOP PADDING HERE. A fitted page
// (PublicShell) folds `--ah-bar-band` into its own headroom arithmetic (a max,
// not a sum — `.ah-public-fit`); a scrolling page simply adds the whole band as
// top padding so its first line clears the fixed bar. Both read the same
// variable; neither could use the other's rule.
//
// THE GROUND IS A FULL `100dvh`, WITH THE BAND AS PADDING INSIDE IT — not
// `calc(100dvh - band)` with the box offset below the bar. Both keep the
// CONTENT clear of the bar, but only the first paints the ground the whole way
// up. The band is NAV_BAR_H + GRID while the bar is only NAV_BAR_H tall, so
// the GRID of deliberate clearance under the bar has to be painted by
// something: outside the box it falls through to `body` (white in light,
// ink-900 in dark) and draws an 8px stripe between the bar and the page. Here
// it is the page's own floor. `box-sizing: border-box` (preflight) means the
// padding is inside the 100dvh, so short content still comes to exactly one
// viewport and doesn't invent a scrollbar.
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
// (2026-08-31: the band moved from the foot to the head with the bar. All of
// the above holds with the edges swapped.)
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

// =============================================================================
// AND A PAGE THAT BRINGS ITS OWN GROUND HAS TO TELL THE BAR (2026-09-02).
//
// `barGround` is the ground the CHILD paints, declared to the fixed nav bar as
// `--ah-bar-ground`. `BarGround.tsx` carries the whole argument — why the bar
// cannot work it out for itself, and why it travels through `:root`.
//
// IT ALSO PAINTS THE BAND, WHICH IS THE HALF THIS COMPONENT'S OWN HEADER
// PREDICTED. `--ah-bar-band` is NAV_BAR_H + GRID while the bar is only
// NAV_BAR_H tall, so a GRID of deliberate clearance under the bar has to be
// painted by somebody. In the `ground` case this box paints it. In the
// `ground={false}` case nothing did: the padding is transparent, the child
// starts below it, and it fell through to `body` — white in light, ink-900 in
// dark. On the reader routes that was invisible (the article is white too);
// on the profile routes it drew an 8px stripe between a bone bar and the
// profile's own bone floor, in both modes. Painting this box `barGround` fixes
// both at once, and is free where the child covers it.
//
// So `barGround` is wanted whenever `ground={false}`, INCLUDING when the child
// paints plain bone — bone is the bar's fallback, but it is not the body's.
// =============================================================================

interface PublicPageProps {
  children: ReactNode
  /** Paint the bone floor AND stand a full viewport tall. Pass false when the
   *  child supplies both (e.g. ArticleReader's `min-h-screen bg-white`). */
  ground?: boolean
  /** The ground the CHILD paints, as a `var(--ah-*)` reference. Declared to the
   *  fixed nav bar so its bottom edge stays invisible, and painted behind the
   *  bar's clearance band so it isn't left showing `body`. Pass whenever
   *  `ground={false}` — bone included. */
  barGround?: string
  /** Centre the body at a pixel measure. Omit for full-bleed. */
  measure?: number
}

export function PublicPage({
  children,
  ground = true,
  barGround,
  measure,
}: PublicPageProps) {
  return (
    <div
      style={{
        // `barGround` when the child owns the floor: the child paints over
        // this, so all it is doing is putting the right colour behind the bar's
        // clearance band instead of leaving `body` to show through.
        background: ground ? 'var(--ah-bone)' : barGround,
        minHeight: ground ? '100dvh' : undefined,
        paddingTop: 'var(--ah-bar-band, 0px)',
      }}
    >
      {barGround && <BarGround value={barGround} />}
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
