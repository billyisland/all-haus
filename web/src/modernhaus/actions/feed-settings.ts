import type { WorkspaceFeedSource } from '../../lib/api/feeds'
import { throughputToStep } from '../../lib/volume-scale'
import { call, must, okBody, path } from '../gateway'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { ok, refused, str } from './shared'

// =============================================================================
// modernhaus — one feed's settings, written (MODERNHAUS-ADR §D2.4, E6): rename,
// a source's volume / sampling / replies, move, remove and add, merge, delete,
// and the share link. Each is the route the full site's composer calls.
//
// A SOURCE IS WRITTEN BY DIFFERENCE, as the composer writes it one control at
// a time: the action re-reads the row and sends only what changed. Mute is
// step 0 and rides `muted` alone — never a level (feeds.md: mute does not
// spend the level, nor the mode), and an absent field is never a default.
//
// A FOLLOW IS A CHOSEN SOURCE (feeds.md): adding an account source is the same
// act as following, and the ROUTE writes the graph row. Nothing here writes
// `follows`.
// =============================================================================

const settings = (feedId: string) => `/modernhaus/feed/${encodeURIComponent(feedId)}/settings`

async function sourceUpdate(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const feedId = str(input.feedId)
  const sourceId = str(input.sourceId)
  const { sources } = okBody(
    await call<{ sources: WorkspaceFeedSource[] }>(ctx.gw, 'GET', path`/workspace/feeds/${feedId}/sources`),
    'feed sources',
  )
  const s = sources.find((x) => x.id === sourceId)
  if (!s) return refused(404)

  const body: { step?: number; muted?: boolean; sampling?: 'random' | 'top'; excludeReplies?: boolean } = {}
  const current = s.mutedAt !== null ? 0 : throughputToStep(s.throughput)
  const step = typeof input.step === 'number' && Number.isInteger(input.step) && input.step >= 0 && input.step <= 5 ? input.step : current
  if (step !== current) {
    if (step === 0) body.muted = true
    else {
      body.step = step
      if (s.mutedAt !== null) body.muted = false
    }
  }
  const sampling = input.sampling === 'random' || input.sampling === 'top' ? input.sampling : s.samplingMode
  if (sampling !== s.samplingMode) body.sampling = sampling
  if (input.excludeReplies !== s.excludeReplies) body.excludeReplies = input.excludeReplies === true

  if (Object.keys(body).length === 0) return { kind: 'done', code: 'source_saved' }
  const a = must(await call(ctx.gw, 'PATCH', path`/workspace/feeds/${feedId}/sources/${sourceId}`, { json: body }), 'source update')
  return ok(a) ? { kind: 'done', code: 'source_saved' } : { kind: 'answer', answer: a }
}

async function sourceAdd(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const feedId = str(input.feedId)
  let add: unknown
  try {
    add = JSON.parse(str(input.add))
  } catch {
    return refused(400)
  }
  if (!add || typeof add !== 'object' || Array.isArray(add)) return refused(400)
  const a = must(await call(ctx.gw, 'POST', path`/workspace/feeds/${feedId}/sources`, { json: add }), 'add source')
  if (ok(a)) return { kind: 'done', code: 'source_added', back: settings(feedId) }
  return { kind: 'answer', answer: a }
}

async function formulaFreeze(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const a = must(await call(ctx.gw, 'POST', path`/workspace/feeds/${str(input.feedId)}/formula`), 'formula mint')
  return ok(a) ? { kind: 'done', code: 'formula_frozen' } : { kind: 'answer', answer: a }
}

async function formulaRedeem(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const token = str(input.token)
  const a = must(
    await call<{ feedId?: unknown; failed?: unknown[] }>(ctx.gw, 'POST', path`/formulas/${token}/redeem`),
    'formula redeem',
  )
  if (ok(a) && typeof a.body?.feedId === 'string') {
    const partly = Array.isArray(a.body.failed) && a.body.failed.length > 0
    return {
      kind: 'done',
      code: partly ? 'formula_redeemed_partly' : 'formula_redeemed',
      back: `/modernhaus/feed/${encodeURIComponent(a.body.feedId)}`,
    }
  }
  return { kind: 'answer', answer: ok(a) ? { ...a, status: 502 } : a }
}

const FEED = { feedId: 'string' } as const

export const FEED_SETTINGS_ACTIONS: Registry = {
  // A feed's name is OPTIONAL (feeds.md): an empty one is sent as it is.
  feed_rename: {
    kind: 'simple',
    method: 'PATCH',
    fields: { ...FEED, name: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}`,
    body: (i) => ({ name: str(i.name) }),
    done: 'feed_saved',
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  source_update: {
    kind: 'orchestrated',
    fields: { ...FEED, sourceId: 'string', step: 'number', sampling: 'string', excludeReplies: 'boolean' },
    run: sourceUpdate,
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  // The composer's × takes a source out at once; so does this.
  source_remove: {
    kind: 'simple',
    method: 'DELETE',
    fields: { ...FEED, sourceId: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}/sources/${str(i.sourceId)}`,
    done: 'source_removed',
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  source_move: {
    kind: 'simple',
    method: 'POST',
    fields: { ...FEED, sourceId: 'string', targetFeedId: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}/sources/${str(i.sourceId)}/move`,
    body: (i) => ({ targetFeedId: str(i.targetFeedId) }),
    done: 'source_moved',
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  source_add: {
    kind: 'orchestrated',
    fields: { ...FEED, add: 'string' },
    run: sourceAdd,
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  feed_merge: {
    kind: 'simple',
    method: 'POST',
    fields: { ...FEED, sourceFeedId: 'string' },
    path: (i) => path`/workspace/feeds/${str(i.feedId)}/merge`,
    body: (i) => ({ sourceFeedId: str(i.sourceFeedId) }),
    done: 'feeds_merged',
    defaultReturn: (i) => `/modernhaus/feed/${encodeURIComponent(str(i.feedId))}`,
  },
  feed_delete: {
    kind: 'simple',
    method: 'DELETE',
    fields: FEED,
    path: (i) => path`/workspace/feeds/${str(i.feedId)}`,
    done: 'feed_deleted',
    defaultReturn: () => '/modernhaus',
  },
  formula_freeze: {
    kind: 'orchestrated',
    fields: FEED,
    run: formulaFreeze,
    defaultReturn: (i) => settings(str(i.feedId)),
  },
  // Stopping cannot un-add, so, as on the full site, it does not confirm.
  formula_revoke: {
    kind: 'simple',
    method: 'DELETE',
    fields: { ...FEED, formulaId: 'string' },
    path: (i) => path`/formulas/${str(i.formulaId)}`,
    done: 'sharing_stopped',
    defaultReturn: () => '/modernhaus',
  },
  formula_redeem: {
    kind: 'orchestrated',
    fields: { token: 'string' },
    run: formulaRedeem,
    defaultReturn: (i) => `/modernhaus/f/${encodeURIComponent(str(i.token))}`,
  },
}
