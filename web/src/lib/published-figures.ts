// =============================================================================
// The dials public copy names — read from the gateway, never typed.
//
// `GET /published-figures` (gateway/src/routes/published-figures.ts) answers
// with the platform's cut and a new account's reading allowance, both
// `platform_config` dials. A sentence that states either one interpolates it
// from here. A literal "8%" or "£5" is a second, silent copy of the dial, right
// at the default and wrong the day it is retuned (walkthrough A24).
//
// Pure, with no fetch, store or `window`, so the full site's About and
// modernhaus's can both import it. Each register does its own fetch: the
// server page with `revalidate`, the overlay through `request()`, modernhaus
// through its one gateway client.
//
// NULL MEANS WE COULD NOT FIND OUT. The copy then drops the number rather than
// guess one. A body that does not parse is the same answer, and it says so in
// the log, because a fallback is for an absent value and never for a
// malformed one.
// =============================================================================

export const PUBLISHED_FIGURES_PATH = '/published-figures'

export interface PublishedFigures {
  platformFeeBps: number
  freeAllowancePence: number
}

function wholeNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** The route's body, or null. Never a default figure. */
export function parsePublishedFigures(body: unknown): PublishedFigures | null {
  if (body == null || typeof body !== 'object') return null
  const { platformFeeBps, freeAllowancePence } = body as Record<string, unknown>
  if (!wholeNonNegative(platformFeeBps) || !wholeNonNegative(freeAllowancePence)) {
    console.warn('published-figures: the gateway answered a body that does not parse', body)
    return null
  }
  return { platformFeeBps, freeAllowancePence }
}

/** 800 → "8%", 850 → "8.5%", 825 → "8.25%". */
export function feePercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`
}

/** Prose pounds: 500 → "£5", 250 → "£2.50". Whole pounds lose their pence. */
export function allowancePounds(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`
}
