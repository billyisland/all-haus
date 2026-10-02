import { createElement } from 'react'
import type { ArticleMetadata } from '../../lib/api/articles'
import type { PayoutCadence } from '../../lib/api/account'
import { mapUnlockError } from '../../lib/unlock-errors'
import { safeHttpUrl } from '../../lib/external-links'
import { PAYOUT_CADENCE_LABEL, PAYOUT_MALFORMED, payoutBelowFloor } from '../../content/money-settings'
import { call, must, okBody, path, GatewayFault, type GatewayAnswer } from '../gateway'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { safeReturn, outcomeFromQuery, GENERIC_FAULT, SUBSCRIBE_REFUSALS, ROUTE_SENTENCES } from '../outcomes'
import { redirectResponse, baseHeaders } from '../respond'
import { documentResponse, loadViewer, loadUnreadCounts, ageStepLocation } from '../page'
import { loadArticleView, ArticleViewPage, type PaidState } from '../article-view'
import { deliverPaidHalf, type GatePassBody } from '../unlock'
import { loadPayoutPrefs } from '../money-loaders'
import { MoneySettingsPage, type PayoutFormValues } from '../pages/money'
import { ACCEPT_TERMS_FIELD } from '../consent'
import { acceptCarriedTerms, errorCode } from './terms'
import { poundsToPence } from './writing'

// =============================================================================
// modernhaus — E5, money (§D2.4 E5 rows). Every entry re-orchestrates the
// routes the full site presses, over the same gateway, and moves no money the
// full site would not move for the same press.
//
//   unlock        gate pass → unwrap → decrypt → render. RENDERS (200,
//                 no-store), never redirects (§D1.3). Refusals are said in
//                 place through `mapUnlockError`.
//   subscribe     POST /subscriptions/:writerId, refusals through
//                 `mapSubscribeError`'s sentences.
//   …and cancel, the two subscription toggles, settle now, card removal,
//   payout preferences and the Stripe Connect hand-off.
//
// THE CONSENT RESUMES THE PRESS. `unlock`, `subscribe` and (in writing.ts)
// `publish_now` each run `acceptCarriedTerms` FIRST when the form carries the
// ticked box, then the act — so accepting is continuing, as on the full site
// (web-foundations.md, *A consent is ONE construction*). The version sent is
// the one the page was drawn with; a stale one is refused by the gateway and
// said, never coerced.
// =============================================================================

const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')

/** A path with one more query value, for a refusal that must remember the press. */
function withQuery(back: string, key: string, value: string): string {
  const u = new URL(back, 'http://modernhaus.invalid')
  u.searchParams.set(key, value)
  return u.pathname + u.search
}

// ---------------------------------------------------------------------------
// The unlock.
// ---------------------------------------------------------------------------

async function unlock(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const dTag = str(input.dTag)
  if (!dTag) return { kind: 'error', code: 'invalid', back: '/modernhaus' }
  const self = `/modernhaus/article/${encodeURIComponent(dTag)}`

  // The page this press renders needs the viewer, as every page does; the
  // shell's two refusals are the door's, here, before anything is pressed.
  const viewer = await loadViewer(ctx.gw)
  if (!viewer) {
    return { kind: 'response', response: redirectResponse(`/modernhaus/signin?return=${encodeURIComponent(self)}`, ctx.gw.setCookies) }
  }
  if (viewer.ageDeclaredAt === null) {
    return { kind: 'response', response: redirectResponse(ageStepLocation(new URL(self, 'http://modernhaus.invalid')), ctx.gw.setCookies) }
  }

  // THE EVENT ID IS RE-READ, never taken from the form: the gate pass is keyed
  // on it, and the form names only the piece the reader is looking at.
  const a = must(await call<ArticleMetadata>(ctx.gw, 'GET', path`/articles/${dTag}`), 'article')
  if (a.status === 404 || a.status === 400) return { kind: 'error', code: 'not_found', back: '/modernhaus' }
  const article = okBody(a, 'article')
  if (!article.isPaywalled) return { kind: 'response', response: redirectResponse(self, ctx.gw.setCookies) }

  let press: PaidState
  const terms = await acceptCarriedTerms(ctx.gw, 'reader', input)
  if (terms.kind === 'answer') return { kind: 'answer', answer: terms.answer, back: self }
  if (terms.kind === 'refused') {
    press = { kind: 'terms_refused', sentence: sentenceFor(terms.code) }
  } else {
    let pass: GatewayAnswer<GatePassBody> | null = null
    try {
      pass = await call<GatePassBody>(ctx.gw, 'POST', path`/articles/${article.nostrEventId}/gate-pass`, { json: {} })
    } catch (err) {
      // The request may have reached the gateway. What is safe to say is the
      // full site's sentence for an unreachable reading service — and a retry
      // is safe too: a repeat gate pass re-issues, it never charges twice.
      console.error('[modernhaus] gate pass unreachable', err instanceof GatewayFault ? err.message : err)
    }
    if (pass === null) {
      press = { kind: 'refused', view: mapUnlockError(502, {}) }
    } else if (pass.status === 401 || (pass.status === 403 && errorCode(pass.body) === 'age_required')) {
      return { kind: 'answer', answer: pass, back: self }
    } else if (pass.status === 200 && pass.body) {
      const delivered = await deliverPaidHalf(ctx.gw, pass.body)
      press =
        delivered.kind === 'open'
          ? { kind: 'open', html: delivered.html, allowanceSpent: pass.body.allowanceJustExhausted === true }
          : delivered
    } else {
      press = { kind: 'refused', view: mapUnlockError(pass.status, pass.body) }
    }
  }

  const [view, counts] = await Promise.all([
    loadArticleView(ctx.gw, viewer, dTag, { offset: 0, focus: null, press, log: false }),
    loadUnreadCounts(ctx.gw),
  ])
  if (!view) return { kind: 'error', code: 'not_found', back: '/modernhaus' }
  return {
    kind: 'response',
    response: await documentResponse({
      title: article.title,
      heading: false,
      viewer,
      csrf: ctx.csrf,
      twin: `/article/${encodeURIComponent(article.dTag)}`,
      outcome: null,
      counts,
      body: createElement(ArticleViewPage, { view, viewer, csrf: ctx.csrf, self, askSubscribeTerms: false }),
      status: 200,
      cookies: ctx.gw.setCookies,
    }),
  }
}

/** A refusal said IN PLACE, from the same table a redirect's `?error=` reads,
 *  so the two cannot say different things. */
function sentenceFor(code: string): string {
  return outcomeFromQuery(new URLSearchParams({ error: code }))?.sentence ?? GENERIC_FAULT
}

// ---------------------------------------------------------------------------
// Subscribing.
// ---------------------------------------------------------------------------

/** The route's answer as one of this register's codes, or null for the door's generic mapping. */
export function subscribeRefusalCode(status: number, body: unknown): string | null {
  const code = errorCode(body)
  for (const [ours, r] of Object.entries(SUBSCRIBE_REFUSALS)) {
    if (r.status === status && r.error === code) return ours
  }
  // A 402 with no code we know is still "a card is the fix" (mapSubscribeError's rule).
  if (status === 402) return 'subscribe_card_required'
  for (const [ours, r] of Object.entries(ROUTE_SENTENCES)) {
    if (r.kind === 'error' && r.sentBy.endsWith('subscriptions/writer.ts') && code === r.sentence) return ours
  }
  return null
}

async function subscribe(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const writerId = str(input.writerId)
  const period = str(input.period) === 'annual' ? 'annual' : 'monthly'
  const offerCode = str(input.offerCode)
  const back = safeReturn(str(input.return) || null) ?? '/modernhaus/ledger'
  const after = safeReturn(str(input.after) || null) ?? undefined

  const terms = await acceptCarriedTerms(ctx.gw, 'reader', input)
  if (terms.kind === 'answer') return { kind: 'answer', answer: terms.answer }
  if (terms.kind === 'refused') return { kind: 'error', code: terms.code, back: withQuery(back, 'period', period) }

  const a = must(
    await call(ctx.gw, 'POST', path`/subscriptions/${writerId}`, {
      json: { period, ...(offerCode ? { offerCode } : {}) },
    }),
    'subscribe',
  )
  if (a.status >= 200 && a.status < 300) return { kind: 'done', code: 'subscribed', back: after }
  const code = subscribeRefusalCode(a.status, a.body)
  if (code === null) return { kind: 'answer', answer: a }
  // The Reader Terms refusal comes back to the same page with the period the
  // press asked for, so the consent that replaces the buttons resumes it.
  return { kind: 'error', code, back: code === 'subscribe_terms' ? withQuery(back, 'period', period) : undefined }
}

// ---------------------------------------------------------------------------
// Settle now: every outcome has its own answer, and the ambiguous one is never
// a fault page claiming nothing changed.
// ---------------------------------------------------------------------------

async function tabSettle(ctx: ActionContext): Promise<ActionOutcome> {
  let a: GatewayAnswer<{ settled?: unknown; reason?: unknown; error?: unknown }>
  try {
    a = await call(ctx.gw, 'POST', '/my/tab/settle')
  } catch (err) {
    // The charge may have been created before the answer was lost.
    console.error('[modernhaus] settle unconfirmed', err instanceof GatewayFault ? err.message : err)
    return { kind: 'error', code: 'settlement_unconfirmed' }
  }
  const code = errorCode(a.body)
  if (a.status === 200) {
    if (a.body?.settled === true) return { kind: 'done', code: 'settled' }
    if (a.body?.reason === 'below_minimum') return { kind: 'done', code: 'settle_below_minimum' }
    return { kind: 'done', code: 'settle_nothing_due' }
  }
  if (a.status === 409) return { kind: 'error', code: 'settlement_in_flight' }
  if (a.status === 402) return { kind: 'error', code: code === 'card_required' ? 'settle_card_required' : 'settle_card_declined' }
  if (a.status === 502) return { kind: 'error', code: 'settlement_unconfirmed' }
  return { kind: 'answer', answer: must(a, 'settle') }
}

// ---------------------------------------------------------------------------
// The card, Stripe Connect and payout preferences.
// ---------------------------------------------------------------------------

async function cardRemove(ctx: ActionContext): Promise<ActionOutcome> {
  const a = await call(ctx.gw, 'DELETE', '/auth/payment-method')
  if (a.status >= 200 && a.status < 300) return { kind: 'done', code: 'card_removed' }
  // Every card still attached at Stripe: the route changed nothing, and says so.
  if (a.status === 502) return { kind: 'error', code: 'card_remove_failed' }
  return { kind: 'answer', answer: must(a, 'card remove') }
}

async function writerUpgrade(ctx: ActionContext): Promise<ActionOutcome> {
  const a = await call<{ stripeConnectUrl?: unknown }>(ctx.gw, 'POST', '/auth/upgrade-writer')
  if (a.status === 401) return { kind: 'answer', answer: a }
  const url = a.status === 200 && typeof a.body?.stripeConnectUrl === 'string' ? safeHttpUrl(a.body.stripeConnectUrl) : undefined
  // The ONE off-site 303 this step makes (§D2.5.2): a URL out of the
  // gateway's own answer, https only, never off the form.
  if (url && url.startsWith('https://')) {
    const h = baseHeaders()
    for (const c of ctx.gw.setCookies) h.append('Set-Cookie', c)
    h.set('Location', url)
    return { kind: 'response', response: new Response(null, { status: 303, headers: h }) }
  }
  if (a.status >= 500 || a.status === 409 || a.status === 200) {
    if (a.status >= 500) console.error('[modernhaus] stripe connect refused', a.status)
    return { kind: 'error', code: 'connect_failed' }
  }
  return { kind: 'answer', answer: a }
}

const CADENCES = Object.keys(PAYOUT_CADENCE_LABEL) as PayoutCadence[]

async function payoutPrefsSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const cadence = str(input.cadence) as PayoutCadence
  if (!CADENCES.includes(cadence)) return { kind: 'error', code: 'invalid' }
  const threshold = str(input.threshold)
  const pence = threshold === '' ? null : poundsToPence(threshold)
  const values: PayoutFormValues = { cadence, threshold }

  const refuse = async (sentence: string, status: number): Promise<ActionOutcome> => {
    const [viewer, prefs] = await Promise.all([loadViewer(ctx.gw), loadPayoutPrefs(ctx.gw)])
    if (!viewer) return { kind: 'answer', answer: { status: 401, body: null, setCookies: [] } }
    return {
      kind: 'response',
      response: await documentResponse({
        title: 'Card and payouts',
        viewer,
        csrf: ctx.csrf,
        twin: '/settings',
        outcome: null,
        body: createElement(MoneySettingsPage, { viewer, csrf: ctx.csrf, prefs, payoutValues: values, payoutError: sentence }),
        status,
        cookies: ctx.gw.setCookies,
      }),
    }
  }

  // The full site refuses a malformed amount before it asks; so does this.
  if (threshold !== '' && pence === null) return refuse(PAYOUT_MALFORMED, 400)

  const a = must(
    await call<{ platformThresholdPence?: unknown }>(ctx.gw, 'PATCH', '/my/payout-preferences', {
      json: { cadence, thresholdPence: pence },
    }),
    'payout preferences',
  )
  if (a.status >= 200 && a.status < 300) return { kind: 'done', code: 'payouts_saved' }
  if (a.status === 400 && errorCode(a.body) === 'threshold_below_platform_minimum') {
    const floor = Number(a.body?.platformThresholdPence)
    return refuse(Number.isFinite(floor) ? payoutBelowFloor(floor) : GENERIC_FAULT, 400)
  }
  return { kind: 'answer', answer: a }
}

// ---------------------------------------------------------------------------

const ledger = () => '/modernhaus/ledger'
const moneySettings = () => '/modernhaus/settings/money'

export const MONEY_ACTIONS: Registry = {
  unlock: {
    kind: 'orchestrated',
    fields: { dTag: 'string', [ACCEPT_TERMS_FIELD]: 'string' },
    run: unlock,
    defaultReturn: (i) => (str(i.dTag) ? `/modernhaus/article/${encodeURIComponent(str(i.dTag))}` : '/modernhaus'),
  },
  subscribe: {
    kind: 'orchestrated',
    fields: { writerId: 'string', period: 'string', offerCode: 'string', return: 'string', after: 'string', [ACCEPT_TERMS_FIELD]: 'string' },
    run: subscribe,
    defaultReturn: ledger,
  },
  subscription_cancel: {
    kind: 'simple',
    method: 'DELETE',
    fields: { writerId: 'string' },
    path: (i) => path`/subscriptions/${str(i.writerId)}`,
    done: 'subscription_cancelled',
    defaultReturn: ledger,
  },
  subscription_notify: {
    kind: 'simple',
    method: 'PATCH',
    fields: { subscriptionId: 'string', notify: 'string' },
    path: (i) => path`/subscriptions/${str(i.subscriptionId)}/notifications`,
    body: (i) => ({ notifyOnPublish: str(i.notify) === 'on' }),
    done: 'subscription_saved',
    defaultReturn: ledger,
  },
  subscription_visibility: {
    kind: 'simple',
    method: 'PATCH',
    fields: { writerId: 'string', hidden: 'string' },
    path: (i) => path`/subscriptions/${str(i.writerId)}/visibility`,
    body: (i) => ({ hidden: str(i.hidden) === 'yes' }),
    done: 'subscription_saved',
    defaultReturn: ledger,
  },
  tab_settle: { kind: 'orchestrated', fields: {}, run: (ctx) => tabSettle(ctx), defaultReturn: ledger },
  card_remove: { kind: 'orchestrated', fields: {}, run: (ctx) => cardRemove(ctx), defaultReturn: moneySettings },
  payout_prefs_save: {
    kind: 'orchestrated',
    fields: { cadence: 'string', threshold: 'string' },
    run: payoutPrefsSave,
    defaultReturn: moneySettings,
  },
  writer_upgrade: { kind: 'orchestrated', fields: {}, run: (ctx) => writerUpgrade(ctx), defaultReturn: moneySettings },
  // A reader asks to write (READER-WRITER-SPLIT-ADR §8): the full site's one
  // press, over the same route. A writer is refused `already_writer`.
  writer_apply: {
    kind: 'simple',
    method: 'POST',
    fields: {},
    path: () => '/writer-applications',
    done: 'writer_applied',
    defaultReturn: () => '/modernhaus/write',
  },
}
