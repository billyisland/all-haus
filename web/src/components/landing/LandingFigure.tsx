import type { ReactNode } from 'react'
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
// =============================================================================

export function LandingFigure({
  palette,
  caption,
  description,
  children,
}: {
  palette: VesselPalette
  /** The visible line under the demo — the claim. */
  caption: string
  /** The accessible equivalent — what a sighted visitor sees. */
  description: string
  children: ReactNode
}) {
  return (
    <figure style={{ margin: 0 }} role="figure" aria-label={description}>
      <div aria-hidden="true">{children}</div>
      <figcaption
        className="label-ui"
        style={{ color: palette.cardStandfirst, marginTop: 10 }}
      >
        {caption}
      </figcaption>
    </figure>
  )
}
