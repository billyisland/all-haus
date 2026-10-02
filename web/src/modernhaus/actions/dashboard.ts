import { createElement } from 'react'
import {
  PRICING_INVALID_PRICE,
  PRICING_INVALID_DISCOUNT,
  PRICING_INVALID_ARTICLE_PRICE,
  PRICING_UPDATE_FAILED,
  WELCOME_SAVE_FAILED,
  OFFER_CREATE_FAILED,
} from '../../content/dashboard'
import { call, must, path, type GatewayAnswer } from '../gateway'
import { documentResponse, loadViewer, loadUnreadCounts } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { loadAccountFacts } from '../settings-loaders'
import { loadOffers, loadWelcome } from '../dashboard-loaders'
import { requestOrigin } from '../csrf'
import { PricingPage, OffersPage, type PricingValues, type OfferValues } from '../pages/dashboard'
import { doorOwns, ok, refused, str } from './shared'

// =============================================================================
// modernhaus — the writer's dashboard writes (MODERNHAUS-ADR §D2.4, E6), each
// to the route the full site's dashboard calls: replies on/off, unpublish,
// delete, tags, gift links, pricing, the welcome message, offers and gifts.
//
// Pricing is checked on this side exactly as the full site's Pricing tab
// checks it, before it asks, with the tab's own sentences; the route stays the
// judge of everything else.
// =============================================================================

const D = '/modernhaus/dashboard'
const raw = (v: Input[string]): string => (typeof v === 'string' ? v : '')

function sentenceOr(answer: GatewayAnswer, fallback: string): string {
  const b = answer.body && typeof answer.body === 'object' ? (answer.body as { message?: unknown; error?: unknown }) : {}
  if (typeof b.message === 'string' && b.message.trim() !== '') return b.message
  if (typeof b.error === 'string' && /\s/.test(b.error)) return b.error
  return fallback
}

const refusalStatus = (s: number) => (s >= 400 && s < 500 ? s : 400)

async function page(ctx: ActionContext, title: string, body: ReturnType<typeof createElement>, status: number): Promise<ActionOutcome> {
  const [viewer, counts] = await Promise.all([loadViewer(ctx.gw), loadUnreadCounts(ctx.gw)])
  if (!viewer) return refused(401)
  return {
    kind: 'response',
    response: await documentResponse({
      title,
      viewer,
      csrf: ctx.csrf,
      twin: '/dashboard',
      outcome: null,
      body,
      status,
      cookies: ctx.gw.setCookies,
      counts,
    }),
  }
}

// ---------------------------------------------------------------------------
// A piece.
// ---------------------------------------------------------------------------

async function articleReplies(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  // `<articleId>:on|off`, one button per row.
  const [id, want] = str(input.toggle).split(':')
  if (!id || (want !== 'on' && want !== 'off')) return refused(400)
  const a = must(
    await call(ctx.gw, 'PATCH', path`/articles/${id}`, { json: { repliesEnabled: want === 'on' } }),
    'article replies',
  )
  if (ok(a)) return { kind: 'done', code: want === 'on' ? 'replies_on' : 'replies_off' }
  return { kind: 'answer', answer: a }
}

/** Comma-separated, as a member types them; the route normalises and caps. */
export function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim().replace(/^#/, ''))
    .filter((t) => t !== '')
}

async function giftLinkCreate(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const articleId = str(input.articleId)
  const max = typeof input.maxRedemptions === 'number' ? input.maxRedemptions : 5
  const a = must(
    await call(ctx.gw, 'POST', path`/articles/${articleId}/gift-link`, { json: { maxRedemptions: max } }),
    'gift link create',
  )
  if (ok(a)) return { kind: 'done', code: 'gift_link_created' }
  if (doorOwns(a) || a.status === 404) return { kind: 'answer', answer: a }
  // The full site's own sentence: nothing was made.
  return { kind: 'error', code: 'gift_link_not_created' }
}

// ---------------------------------------------------------------------------
// Pricing and the welcome message.
// ---------------------------------------------------------------------------

async function pricingAgain(ctx: ActionContext, extra: { values?: PricingValues; error?: string; welcomeValue?: string; welcomeError?: string }, status: number) {
  const [facts, welcome, viewer] = await Promise.all([loadAccountFacts(ctx.gw), loadWelcome(ctx.gw), loadViewer(ctx.gw)])
  return page(
    ctx,
    'Pricing',
    createElement(PricingPage, {
      facts,
      welcome,
      kycComplete: viewer?.money ? viewer.money.stripeConnectKycComplete : null,
      csrf: ctx.csrf,
      ...extra,
    }),
    status,
  )
}

async function priceSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const values: PricingValues = {
    price: raw(input.price),
    discount: raw(input.discount),
    mode: input.mode === 'fixed' ? 'fixed' : 'auto',
    fixed: raw(input.fixed),
  }
  // The Pricing tab's own checks, in its order, with its words.
  const pence = Math.round(parseFloat(values.price) * 100)
  const discount = parseInt(values.discount, 10)
  if (isNaN(pence) || pence < 0) return pricingAgain(ctx, { values, error: PRICING_INVALID_PRICE }, 400)
  if (isNaN(discount) || discount < 0 || discount > 30) return pricingAgain(ctx, { values, error: PRICING_INVALID_DISCOUNT }, 400)
  const fixed = values.mode === 'fixed' ? Math.round(parseFloat(values.fixed || '0') * 100) : null
  if (fixed !== null && (isNaN(fixed) || fixed < 0)) return pricingAgain(ctx, { values, error: PRICING_INVALID_ARTICLE_PRICE }, 400)

  const a = must(
    await call(ctx.gw, 'PATCH', '/settings/subscription-price', {
      json: { pricePence: pence, annualDiscountPct: discount, defaultArticlePricePence: fixed },
    }),
    'subscription price',
  )
  if (ok(a)) return { kind: 'done', code: 'price_saved' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return pricingAgain(ctx, { values, error: sentenceOr(a, PRICING_UPDATE_FAILED) }, refusalStatus(a.status))
}

async function welcomeSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const text = raw(input.message)
  const message = text.trim() === '' ? null : text
  const a = must(await call(ctx.gw, 'PATCH', '/settings/subscription-welcome', { json: { message } }), 'welcome save')
  if (ok(a)) return { kind: 'done', code: message === null ? 'welcome_cleared' : 'welcome_saved' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  return pricingAgain(ctx, { welcomeValue: text, welcomeError: sentenceOr(a, WELCOME_SAVE_FAILED) }, refusalStatus(a.status))
}

// ---------------------------------------------------------------------------
// Offers, and gifts of a subscription.
// ---------------------------------------------------------------------------

function optNumber(v: Input[string]): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

async function offerCreate(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const mode = input.mode === 'grant' ? 'grant' : 'code'
  const values: OfferValues = {
    mode,
    label: raw(input.label),
    discountPct: input.discountPct === null ? '' : String(input.discountPct ?? ''),
    durationMonths: input.durationMonths === null ? '' : String(input.durationMonths ?? ''),
    maxRedemptions: input.maxRedemptions === null ? '' : String(input.maxRedemptions ?? ''),
    recipientUsername: raw(input.recipientUsername),
  }
  const body: Record<string, unknown> = {
    label: values.label.trim(),
    mode,
    discountPct: optNumber(input.discountPct) ?? 0,
    durationMonths: optNumber(input.durationMonths),
  }
  if (mode === 'code') body.maxRedemptions = optNumber(input.maxRedemptions)
  if (mode === 'grant') body.recipientUsername = values.recipientUsername.trim().replace(/^@/, '')
  const a = must(await call(ctx.gw, 'POST', '/subscription-offers', { json: body }), 'offer create')
  if (ok(a)) return { kind: 'done', code: mode === 'grant' ? 'comp_granted' : 'offer_created' }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  const offers = await loadOffers(ctx.gw)
  return page(
    ctx,
    'Proposals',
    createElement(OffersPage, { offers, csrf: ctx.csrf, origin: requestOrigin(ctx.req), values, error: sentenceOr(a, OFFER_CREATE_FAILED) }),
    refusalStatus(a.status),
  )
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const DASHBOARD_ACTIONS: Registry = {
  article_replies: {
    kind: 'orchestrated',
    fields: { toggle: 'string' },
    run: articleReplies,
    defaultReturn: () => D,
  },
  article_unpublish: {
    kind: 'simple',
    method: 'POST',
    fields: { articleId: 'string' },
    path: (i) => path`/articles/${str(i.articleId)}/unpublish`,
    done: 'unpublished',
    defaultReturn: () => D,
  },
  article_delete: {
    kind: 'simple',
    method: 'DELETE',
    fields: { articleId: 'string' },
    path: (i) => path`/articles/${str(i.articleId)}`,
    done: 'deleted',
    defaultReturn: () => D,
  },
  // Sent whole: an empty list takes every tag off, which the editor's publish
  // cannot do (MODERNHAUS-ADR §E4.2.6).
  article_tags: {
    kind: 'simple',
    method: 'PUT',
    fields: { articleId: 'string', tags: 'string' },
    path: (i) => path`/articles/${str(i.articleId)}/tags`,
    body: (i) => ({ tags: parseTags(raw(i.tags)) }),
    done: 'tags_saved',
    defaultReturn: (i) => `${D}/article/${encodeURIComponent(str(i.articleId))}`,
  },
  gift_link_create: {
    kind: 'orchestrated',
    fields: { articleId: 'string', maxRedemptions: 'number' },
    run: giftLinkCreate,
    defaultReturn: (i) => `${D}/article/${encodeURIComponent(str(i.articleId))}`,
  },
  gift_link_revoke: {
    kind: 'simple',
    method: 'DELETE',
    fields: { articleId: 'string', linkId: 'string' },
    path: (i) => path`/articles/${str(i.articleId)}/gift-link/${str(i.linkId)}`,
    done: 'gift_link_revoked',
    defaultReturn: (i) => `${D}/article/${encodeURIComponent(str(i.articleId))}`,
  },
  price_save: {
    kind: 'orchestrated',
    fields: { price: 'string', discount: 'string', mode: 'string', fixed: 'string' },
    run: priceSave,
    defaultReturn: () => `${D}/pricing`,
  },
  welcome_save: {
    kind: 'orchestrated',
    fields: { message: 'string' },
    run: welcomeSave,
    defaultReturn: () => `${D}/pricing`,
  },
  offer_create: {
    kind: 'orchestrated',
    fields: {
      mode: 'string',
      label: 'string',
      discountPct: 'number',
      durationMonths: 'number',
      maxRedemptions: 'number',
      recipientUsername: 'string',
    },
    run: offerCreate,
    defaultReturn: () => `${D}/offers`,
  },
  offer_revoke: {
    kind: 'simple',
    method: 'DELETE',
    fields: { offerId: 'string' },
    path: (i) => path`/subscription-offers/${str(i.offerId)}`,
    done: 'offer_revoked',
    defaultReturn: () => `${D}/offers`,
  },
}
