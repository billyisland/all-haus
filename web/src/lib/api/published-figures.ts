// =============================================================================
// The published figures, for a client surface (the About overlay).
//
// The server page reads the same route with `revalidate`; this is the browser's
// half, through `request()`. A definitive answer is cached for the session and
// a failure is not, so one blip cannot strip the figures from every later open.
// =============================================================================

import { request } from './client'
import {
  PUBLISHED_FIGURES_PATH,
  parsePublishedFigures,
  type PublishedFigures,
} from '../published-figures'

let cached: PublishedFigures | null = null

/** The figures, or null when we could not find out (the copy then drops them). */
export async function publishedFigures(): Promise<PublishedFigures | null> {
  if (cached) return cached
  try {
    cached = parsePublishedFigures(await request<unknown>(PUBLISHED_FIGURES_PATH))
    return cached
  } catch (err) {
    console.warn('published-figures: could not read them; the copy drops its numbers', err)
    return null
  }
}
