import type { TabOverview, WriterEarnings, MySubscription, PayoutPreferences } from '../lib/api/account'
import type { OfferLookup } from '../lib/api/drives'
import { call, must, okBody, path, query, GatewayFault, type GatewayContext } from './gateway'
import type { Viewer } from './html'
import { secondary } from './member-loaders'

// =============================================================================
// modernhaus — the money pages' gateway reads (§D2.3 E5 rows).
//
// Every figure about somebody's money is COERCED at this edge: a `bigint`
// column crosses the wire as a string (money.md), and `=== 0` on "0" is how the
// full site once told a reader with a clear tab that it would settle from their
// card. A figure that is not a finite number after coercion is a FAULT of the
// primary read, and "unavailable" on a secondary one — never £0.00 (§D2.6: a
// figure the ledger could not produce is "unavailable").
// =============================================================================

const STATEMENT_PAGE = 50

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A full-site path the statement and the receipt carry, mapped onto this register. */
export function registerLink(link: string | null | undefined): string | null {
  if (!link) return null
  const article = link.match(/^\/article\/([^/?#]+)$/)
  if (article) return `/modernhaus/article/${article[1]}`
  const person = link.match(/^\/([^/?#]+)$/)
  if (person) return `/modernhaus/u/${person[1]}`
  return null
}

// ---------------------------------------------------------------------------
// The Ledger.
// ---------------------------------------------------------------------------

export interface Tab {
  tabBalancePence: number
  refundDuePence: number
  freeAllowanceRemainingPence: number
  freeAllowanceTotalPence: number
}

export interface Earnings {
  pendingTransferPence: number
  grossPence: number
  feePence: number
  allowanceCoveredPence: number
  allowanceReadCount: number
}

export interface StatementEntry {
  id: string
  date: string
  type: string
  category: string
  description: string
  amount_pence: number
  link: string | null
  ref_id: string | null
}

export interface Statement {
  entries: StatementEntry[]
  totalEntries: number
  hasMore: boolean
}

export interface LedgerData {
  tab: Tab
  earnings: Earnings | null
  statement: Statement | null
  subscriptions: MySubscription[] | null
  offset: number
  freeReads: boolean
}

function tabOf(body: TabOverview): Tab {
  const tab = {
    tabBalancePence: num(body.tabBalancePence),
    refundDuePence: num(body.refundDuePence),
    freeAllowanceRemainingPence: num(body.freeAllowanceRemainingPence),
    freeAllowanceTotalPence: num(body.freeAllowanceTotalPence),
  }
  for (const [k, v] of Object.entries(tab)) {
    if (v === null) throw new GatewayFault(`/my/tab carried no ${k}`)
  }
  return tab as Tab
}

function earningsOf(body: WriterEarnings | null): Earnings | null {
  if (!body) return null
  const e = {
    pendingTransferPence: num(body.pendingTransferPence),
    grossPence: num(body.grossPence),
    feePence: num(body.feePence),
    allowanceCoveredPence: num(body.allowanceCoveredPence),
    allowanceReadCount: num(body.allowanceReadCount),
  }
  return Object.values(e).some((v) => v === null) ? null : (e as Earnings)
}

function statementOf(body: { entries?: unknown; totalEntries?: unknown; hasMore?: unknown } | null): Statement | null {
  if (!body || !Array.isArray(body.entries) || num(body.totalEntries) === null) return null
  const entries: StatementEntry[] = []
  for (const raw of body.entries as Array<Record<string, unknown>>) {
    const amount = num(raw.amount_pence)
    if (amount === null || typeof raw.id !== 'string' || typeof raw.date !== 'string') return null
    entries.push({
      id: raw.id,
      date: raw.date,
      type: String(raw.type ?? ''),
      category: String(raw.category ?? ''),
      description: String(raw.description ?? ''),
      amount_pence: amount,
      link: typeof raw.link === 'string' ? raw.link : null,
      ref_id: typeof raw.ref_id === 'string' ? raw.ref_id : null,
    })
  }
  return { entries, totalEntries: num(body.totalEntries) as number, hasMore: body.hasMore === true }
}

export async function loadLedger(gw: GatewayContext, viewer: Viewer, offset: number, freeReads: boolean): Promise<LedgerData> {
  const [tabBody, earnings, statement, subs] = await Promise.all([
    call<TabOverview>(gw, 'GET', '/my/tab'),
    secondary<WriterEarnings>(gw, 'GET', path`/earnings/${viewer.id}`, 'earnings'),
    secondary<{ entries?: unknown; totalEntries?: unknown; hasMore?: unknown }>(
      gw,
      'GET',
      '/my/account-statement' +
        query({ filter: 'all', limit: STATEMENT_PAGE, offset: offset || null, include_free_reads: freeReads ? 'true' : null }),
      'statement',
    ),
    secondary<{ subscriptions?: unknown }>(gw, 'GET', '/subscriptions/mine', 'subscriptions'),
  ])
  const tab = tabOf(okBody(tabBody, 'tab'))
  return {
    tab,
    earnings: earningsOf(earnings),
    statement: statementOf(statement),
    subscriptions: subs && Array.isArray(subs.subscriptions) ? (subs.subscriptions as MySubscription[]) : null,
    offset,
    freeReads,
  }
}

// ---------------------------------------------------------------------------
// A receipt.
// ---------------------------------------------------------------------------

export interface ReceiptItem {
  kind: 'read' | 'subscription'
  description: string
  writerName: string
  writerUsername: string
  pricePence: number
  link: string | null
  at: string
}

export interface Receipt {
  settlementId: string
  settledAt: string
  amountPence: number
  reversedAt: string | null
  items: ReceiptItem[]
  unitemisedPence: number
}

/** Null is "no such receipt of yours" (the route answers 404 for both, never 403). */
export async function loadReceipt(gw: GatewayContext, settlementId: string): Promise<Receipt | null> {
  const a = must(await call<Record<string, unknown>>(gw, 'GET', path`/my/receipts/${settlementId}`), 'receipt')
  if (a.status === 404 || a.status === 400) return null
  const b = okBody(a, 'receipt')
  const amount = num(b.amountPence)
  const gap = num(b.unitemisedPence)
  if (amount === null || gap === null || !Array.isArray(b.items) || typeof b.settledAt !== 'string') {
    throw new GatewayFault('receipt carried an unexpected shape')
  }
  const items: ReceiptItem[] = (b.items as Array<Record<string, unknown>>).map((i) => {
    const price = num(i.pricePence)
    if (price === null) throw new GatewayFault('receipt item carried no price')
    return {
      kind: i.kind === 'subscription' ? 'subscription' : 'read',
      description: String(i.description ?? ''),
      writerName: String(i.writerName ?? ''),
      writerUsername: String(i.writerUsername ?? ''),
      pricePence: price,
      link: typeof i.link === 'string' ? i.link : null,
      at: String(i.at ?? ''),
    }
  })
  return {
    settlementId: String(b.settlementId ?? settlementId),
    settledAt: b.settledAt,
    amountPence: amount,
    reversedAt: typeof b.reversedAt === 'string' ? b.reversedAt : null,
    items,
    unitemisedPence: gap,
  }
}

// ---------------------------------------------------------------------------
// A subscription offer.
// ---------------------------------------------------------------------------

export type OfferResult =
  | { kind: 'offer'; offer: OfferLookup }
  /** A grant offer met signed out: the lookup answers 401 (§1.10). */
  | { kind: 'sign_in' }
  /** The route's own sentence ("This offer has expired"), shown as it came. */
  | { kind: 'unavailable'; sentence: string | null }

export async function loadOffer(gw: GatewayContext, code: string): Promise<OfferResult> {
  const a = must(await call<OfferLookup & { error?: unknown }>(gw, 'GET', path`/subscription-offers/redeem/${code}`), 'offer')
  if (a.status === 401) return { kind: 'sign_in' }
  if (a.status >= 400) {
    const e = a.body?.error
    return { kind: 'unavailable', sentence: typeof e === 'string' && /\s/.test(e) ? e : null }
  }
  const o = okBody(a, 'offer')
  const standard = num(o.standardPricePence)
  const discounted = num(o.discountedPricePence)
  if (standard === null || discounted === null || typeof o.writerId !== 'string') {
    throw new GatewayFault('offer carried an unexpected shape')
  }
  return { kind: 'offer', offer: { ...o, standardPricePence: standard, discountedPricePence: discounted } }
}

// ---------------------------------------------------------------------------
// Settings › Payment.
// ---------------------------------------------------------------------------

/** Null when the read failed: the section says so rather than guessing a cadence. */
export async function loadPayoutPrefs(gw: GatewayContext): Promise<PayoutPreferences | null> {
  const p = await secondary<PayoutPreferences>(gw, 'GET', '/my/payout-preferences', 'payout preferences')
  if (!p) return null
  const floor = num(p.platformThresholdPence)
  const threshold = p.thresholdPence === null ? null : num(p.thresholdPence)
  if (floor === null || (p.thresholdPence !== null && threshold === null)) return null
  return { ...p, platformThresholdPence: floor, thresholdPence: threshold }
}
