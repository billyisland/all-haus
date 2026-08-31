// =============================================================================
// Light island — the inline style that re-pins the global-dark neutral slugs
// back to their canonical LIGHT values on a subtree. Under `html.dark`,
// globals.css inverts these slugs at the document root; any element carrying
// LIGHT_ISLAND_STYLE redeclares them inline (inline beats the stylesheet rule),
// so its whole subtree resolves canonical-light regardless of the global mode.
//
// Used to keep desktop feed vessels per-scheme (they must NOT follow the global
// light/dark toggle), the ForallMenu locked-chrome disc, and the FeedComposer
// scheme swatch (which must always preview true scheme colours).
//
// We MUST redeclare BOTH forms of each slug:
//   --ah-<slug>      (resolved colour)        AND   --ah-<slug>-rgb (the triple)
// The colour var is declared at :root as `--ah-<slug>: rgb(var(--ah-<slug>-rgb))`,
// so it is *resolved at :root* (where html.dark already set the dark triple) and
// the resolved value inherits down — re-pinning only the `-rgb` triple on a
// descendant does NOT retroactively change it (verified in-browser). So we set
// the plain `--ah-<slug>` directly (fixes `var(--ah-<slug>)` consumers) and also
// keep the `-rgb` triple (fixes `rgb(var(--ah-<slug>-rgb) / α)` alpha consumers).
//
// DARK_SLUGS must stay in sync with the `html.dark { … }` block in globals.css.
// =============================================================================

import type { CSSProperties } from 'react'
import { PALETTE_REGISTRY, rgbVarName, hexToTriple } from './registry'

/** The neutral chrome slugs the global dark mode inverts. */
export const DARK_SLUGS = [
  'ink',
  'nav-grey',
  'grey-600',
  'grey-400',
  'grey-300',
  'grey-200',
  'grey-100',
  'white',
  'glasshouse',
  'glasshouse-well',
  'bone',
  'bone-bright',
  'off-white',
  'cream',
  'cream-hover',
] as const

const REG = new Map(PALETTE_REGISTRY.map((e) => [e.slug, e.hex]))

/** Inline style re-pinning every DARK_SLUG to its canonical light value — both
 *  the resolved `--ah-<slug>` colour and the `--ah-<slug>-rgb` triple. */
export const LIGHT_ISLAND_STYLE: CSSProperties = Object.fromEntries(
  DARK_SLUGS.flatMap((slug) => {
    const triple = hexToTriple(REG.get(slug) as string)
    return [
      [rgbVarName(slug), triple],
      [`--ah-${slug}`, `rgb(${triple})`],
    ]
  }),
) as CSSProperties
