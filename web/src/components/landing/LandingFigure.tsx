import type { ReactNode } from 'react'
import Link from 'next/link'
import type { VesselPalette } from '../workspace/tokens'

// =============================================================================
// LandingFigure — a demo plus its caption. Successor to LandingShot.
//
// WHAT IT INHERITS: the <figure>/<figcaption> pairing and the caption idiom.
// WHAT IT DROPS: the whole image apparatus — `next/image`, the fixed aspect
// ratio, the `failed` state and the disc placeholder for a missing file. A
// component cannot 404, so there is nothing to fall back to.
//
// THE DEMOS ARE `aria-hidden`. They are decorative reconstructions built from
// divs; announced, they would read to a screen reader as a wall of invented
// bylines and prices with no structure and no meaning. So the FIGURE carries the
// description — the same job the old `alt` did, and written to the same rule:
// describe what is actually shown, honestly. The caption stays visible and
// separate, because it makes the CLAIM the demo illustrates, which is not the
// same thing as describing it.
//
// `href` MAKES THE DEMO A POINTER AFFORDANCE, AND NOTHING MORE (2026-09-14, at
// the operator's request). A visitor who clicks a picture of the thing is asking
// for the thing, and on `/` the answer is the waiting list. The link is
// `aria-hidden` with `tabIndex={-1}` DELIBERATELY: it is a duplicate of the nav
// bar's one accent button, which is on screen for the whole page and is the
// accessible route. Four more identically-named links in the tab order would be
// noise, and an `aria-hidden` element that can still take focus is the worse
// half of that trade — so it takes neither. The CAPTION stays outside the link:
// it makes a claim, it is not a control.
// =============================================================================

export function LandingFigure({
  palette,
  caption,
  description,
  href,
  children,
}: {
  palette: VesselPalette
  /** The visible line under the demo — the claim. */
  caption: string
  /** The accessible equivalent — what a sighted visitor sees. */
  description: string
  /** Where clicking the demo goes. Omit and it is inert, as it always was. */
  href?: string
  children: ReactNode
}) {
  const demo = <div aria-hidden="true">{children}</div>

  return (
    <figure style={{ margin: 0 }} role="figure" aria-label={description}>
      {href ? (
        <Link
          href={href}
          aria-hidden="true"
          tabIndex={-1}
          style={{ display: 'block', cursor: 'pointer' }}
        >
          {demo}
        </Link>
      ) : (
        demo
      )}
      <figcaption
        className="label-ui"
        style={{ color: palette.cardStandfirst, marginTop: 10 }}
      >
        {caption}
      </figcaption>
    </figure>
  )
}
