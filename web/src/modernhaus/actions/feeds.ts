import type { WorkspaceFeed, WorkspaceFeedSource } from '../../lib/api/feeds'
import { feedFollowAddInput, matchFeedSource } from '../../lib/follow/feed-follow'
import { call, must, okBody, path, GatewayFault, type GatewayAnswer } from '../gateway'
import { loadViewer } from '../page'
import { followSubject, resolveFollow } from '../member-loaders'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'

// =============================================================================
// modernhaus — the feed writes of the reading step (MODERNHAUS-ADR §D2.4, E3):
// make, hide, show, reorder and mark-seen a feed; follow into one; unfollow
// everywhere.
//
// A FOLLOW IS A CHOSEN SOURCE (feeds.md): `follow` puts the target in a feed
// through `POST /workspace/feeds/:id/sources`, which writes the graph row in
// the same transaction. This file never writes `follows` — the one
// `DELETE /follows/:id` below is `unfollowEverywhere`'s closing step, for a
// legacy follow with no source for the route to drop, and is idempotent where
// the route got there first.
// =============================================================================

const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')

/** A refusal made here, shaped as the route would answer it. */
const refused = (status: number): ActionOutcome => ({
  kind: 'answer',
  answer: { status, body: null, setCookies: [] },
})

const ok = (a: GatewayAnswer) => a.status >= 200 && a.status < 300

/** One step up or down in the order AS RENDERED, or null for a move that is no move. */
export function movedOrder(order: string[], feedId: string, direction: string): string[] | null {
  const i = order.indexOf(feedId)
  const j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : -1
  if (i < 0 || j < 0 || j >= order.length || new Set(order).size !== order.length) return null
  const next = [...order]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

async function feedMove(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const order = Array.isArray(input.order) ? input.order : []
  const next = movedOrder(order, str(input.feedId), str(input.direction))
  if (!next) return refused(400)
  const answer = must(await call(ctx.gw, 'PUT', '/workspace/feeds/order', { json: { feedIds: next } }), 'feed order')
  if (ok(answer)) return { kind: 'done', code: 'feed_moved' }
  // The list changed elsewhere since the page was drawn: say so, and the page
  // the member lands on is the current order.
  if (answer.status === 409) return { kind: 'error', code: 'stale_order' }
  return { kind: 'answer', answer }
}

async function follow(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const subject = followSubject(input)
  if (!subject) return refused(400)
  const viewer = await loadViewer(ctx.gw)
  if (!viewer) return refused(401)
  const resolved = await resolveFollow(ctx.gw, viewer, subject)
  if (!resolved) return refused(404)
  const add = feedFollowAddInput(resolved.target)
  if (!add) return refused(422)

  let feedId = str(input.feedId)
  if (feedId === 'new') {
    const made = must(
      await call<{ feed: WorkspaceFeed }>(ctx.gw, 'POST', '/workspace/feeds', { json: { name: str(input.newFeedName) } }),
      'feed create',
    )
    if (!ok(made)) return { kind: 'answer', answer: made }
    feedId = okBody(made, 'feed create').feed.id
  }
  if (!feedId) return refused(400)

  const added = must(await call(ctx.gw, 'POST', path`/workspace/feeds/${feedId}/sources`, { json: add }), 'add source')
  if (ok(added)) return { kind: 'done', code: 'followed' }
  return { kind: 'answer', answer: added }
}

/**
 * `unfollowEverywhere`, on the server: every feed's source for the target
 * removed, then the graph row. A PARTIAL OUTCOME IS NOT A TOTAL ONE — one
 * feed's failure neither aborts the others nor vanishes: it is counted, and
 * the member is told (`unfollowed_partly`).
 */
async function unfollowEverywhere(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const subject = followSubject(input)
  if (!subject) return refused(400)
  const viewer = await loadViewer(ctx.gw)
  if (!viewer) return refused(401)
  const resolved = await resolveFollow(ctx.gw, viewer, subject)
  if (!resolved) return refused(404)
  const target = resolved.target

  let skipped = 0
  let feedsUnreadable = false
  try {
    const { feeds } = okBody(await call<{ feeds: WorkspaceFeed[] }>(ctx.gw, 'GET', '/workspace/feeds'), 'feeds')
    await Promise.all(
      feeds.map(async (f) => {
        try {
          const { sources } = okBody(
            await call<{ sources: WorkspaceFeedSource[] }>(ctx.gw, 'GET', path`/workspace/feeds/${f.id}/sources`),
            'feed sources',
          )
          const rowId = matchFeedSource(sources, target)
          if (!rowId) return
          const gone = await call(ctx.gw, 'DELETE', path`/workspace/feeds/${f.id}/sources/${rowId}`)
          if (!ok(gone)) skipped += 1
        } catch (err) {
          console.warn('[modernhaus] unfollow: one feed failed', err instanceof GatewayFault ? err.message : err)
          skipped += 1
        }
      }),
    )
  } catch (err) {
    console.warn('[modernhaus] unfollow: feeds unreadable', err instanceof GatewayFault ? err.message : err)
    feedsUnreadable = true
  }

  if (target.type === 'user') {
    const g = must(await call(ctx.gw, 'DELETE', path`/follows/${target.id}`), 'unfollow')
    // 404 is "no graph row" — the route already dropped it with the last source.
    if (!ok(g) && g.status !== 404) return { kind: 'answer', answer: g }
  }
  return { kind: 'done', code: feedsUnreadable || skipped > 0 ? 'unfollowed_partly' : 'unfollowed' }
}

const home = () => '/modernhaus'

const SUBJECT = { writer: 'string', author: 'string', source: 'string' } as const

export const FEED_ACTIONS: Registry = {
  feed_create: {
    kind: 'simple',
    method: 'POST',
    fields: { name: 'string' },
    path: () => path`/workspace/feeds`,
    // A feed's name is OPTIONAL (feeds.md): an empty one is sent as it is.
    body: (i) => ({ name: str(i.name) }),
    done: 'feed_created',
    defaultReturn: home,
  },
  feed_hide: {
    kind: 'simple',
    method: 'PATCH',
    fields: { feedId: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}`,
    body: () => ({ hidden: true }),
    done: 'feed_hidden',
    defaultReturn: home,
  },
  feed_show: {
    kind: 'simple',
    method: 'PATCH',
    fields: { feedId: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}`,
    body: () => ({ hidden: false }),
    done: 'feed_shown',
    defaultReturn: home,
  },
  feed_move: {
    kind: 'orchestrated',
    fields: { feedId: 'string', direction: 'string', order: 'list' },
    run: feedMove,
    defaultReturn: home,
  },
  feed_mark_seen: {
    kind: 'simple',
    method: 'POST',
    fields: { feedId: 'string', asOf: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}/seen`,
    // The server's own token, sent back verbatim — never parsed into a Date.
    body: (i) => ({ asOf: str(i.asOf) }),
    done: 'seen',
    defaultReturn: home,
  },
  follow: {
    kind: 'orchestrated',
    fields: { ...SUBJECT, feedId: 'string', newFeedName: 'string' },
    run: follow,
    defaultReturn: home,
  },
  unfollow_everywhere: {
    kind: 'orchestrated',
    fields: SUBJECT,
    run: unfollowEverywhere,
    defaultReturn: home,
  },
}
