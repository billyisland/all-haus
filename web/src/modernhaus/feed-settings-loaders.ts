import type { WorkspaceFeed, WorkspaceFeedSource } from '../lib/api/feeds'
import type { FeedLinkStatus } from '../lib/api/formulas'
import type { ResolverResult } from '../lib/api/resolver'
import { call, okBody, path, GatewayFault, type GatewayContext } from './gateway'

// =============================================================================
// modernhaus — one feed's settings and the source lookup (MODERNHAUS-ADR
// §D2.3, E6).
//
// The share link is behind `FEED_FORMULAS_ENABLED`: the formula read answers
// 404 while that is dark, and then nothing about sharing is offered (a button
// that cannot do its job is not offered). A formula read that FAILED is said,
// never taken for "not shared".
// =============================================================================

export type FormulaState =
  | { kind: 'dark' }
  | { kind: 'unavailable' }
  | { kind: 'status'; status: FeedLinkStatus }

export interface FeedSettingsData {
  feed: WorkspaceFeed
  /** Every feed the member has, in their order — the merge targets and the moves. */
  feeds: WorkspaceFeed[]
  sources: WorkspaceFeedSource[]
  formula: FormulaState
}

export async function loadFeeds(gw: GatewayContext): Promise<WorkspaceFeed[]> {
  const b = okBody(await call<{ feeds: WorkspaceFeed[] }>(gw, 'GET', '/workspace/feeds'), 'feeds')
  if (!Array.isArray(b.feeds)) throw new GatewayFault('feeds: no list')
  return b.feeds
}

export async function loadFormulaState(gw: GatewayContext, feedId: string): Promise<FormulaState> {
  try {
    const a = await call<FeedLinkStatus>(gw, 'GET', path`/workspace/feeds/${feedId}/formula`)
    if (a.status === 404) return { kind: 'dark' }
    if (a.status === 200 && a.body && 'link' in a.body) return { kind: 'status', status: a.body }
    console.warn('[modernhaus] formula status refused', a.status)
    return { kind: 'unavailable' }
  } catch (err) {
    console.warn('[modernhaus] formula status failed', err instanceof GatewayFault ? err.message : err)
    return { kind: 'unavailable' }
  }
}

/** A feed of the member's own, or null when it is not theirs. */
export async function loadFeedSettings(gw: GatewayContext, feedId: string): Promise<FeedSettingsData | null> {
  const feeds = await loadFeeds(gw)
  const feed = feeds.find((f) => f.id === feedId)
  if (!feed) return null
  const [sourcesAnswer, formula] = await Promise.all([
    call<{ sources: WorkspaceFeedSource[] }>(gw, 'GET', path`/workspace/feeds/${feedId}/sources`),
    loadFormulaState(gw, feedId),
  ])
  const { sources } = okBody(sourcesAnswer, 'feed sources')
  if (!Array.isArray(sources)) throw new GatewayFault('feed sources: no list')
  return { feed, feeds, sources, formula }
}

// ---------------------------------------------------------------------------
// The source lookup: `POST /resolve` in the `subscribe` context, with the
// discovery fallback, as the feed composer asks on an explicit submit. It is
// a POST whose effect is a read (§D2.5.1); a slow chain answers `pending`
// with a request id, which a later GET reads.
// ---------------------------------------------------------------------------

export type SourceLookup =
  | { kind: 'result'; result: ResolverResult }
  | { kind: 'expired' }
  | { kind: 'refused'; status: number }

function lookupAnswer(status: number, body: ResolverResult | null, what: string): SourceLookup {
  if (status >= 500) throw new GatewayFault(`${what} ${status}`)
  if (status === 404) return { kind: 'expired' }
  if (status !== 200 || !body || !Array.isArray(body.matches)) return { kind: 'refused', status }
  return { kind: 'result', result: body }
}

/** `subscribe` for a feed's source; `import` for follow import (external-first, ADR §7.4). */
export async function lookupSource(gw: GatewayContext, q: string, context: 'subscribe' | 'import'): Promise<SourceLookup> {
  const a = await call<ResolverResult>(gw, 'POST', '/resolve', {
    json: { query: q, context, discover: true },
  })
  return lookupAnswer(a.status, a.body, 'resolve')
}

export async function pollSource(gw: GatewayContext, requestId: string): Promise<SourceLookup> {
  const a = await call<ResolverResult>(gw, 'GET', path`/resolve/${requestId}`)
  return lookupAnswer(a.status, a.body, 'resolve poll')
}
