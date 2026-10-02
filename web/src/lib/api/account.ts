import { request } from './client'

// =============================================================================
// Writer earnings (payment-side of revenue)
// =============================================================================

export interface WriterEarnings {
  writerId: string
  earningsTotalPence: number
  pendingTransferPence: number
  paidOutPence: number
  // Earnings reserved for in-flight tributes (held|released), shown as
  // "reserved, pending redirect". 0 when the tribute money flow is dark.
  reservedPence: number
  readCount: number
  // L5.4 / audit 3.11: gross and fee beside net. `feePence` is DERIVED by the
  // service from gross − the reads' own net at their stamped rate, never
  // recomputed from the dial — and never gross − the settled buckets, which
  // are net of any tribute carve (that is the author's money, not our fee).
  grossPence: number
  feePence: number
  // A2 / Writer 11.1: reading given away on readers' free allowances. Its own
  // figure — never added to earnings (nobody was charged) and never subtracted
  // from them (the reader would not have paid).
  allowanceCoveredPence: number
  allowanceReadCount: number
}

export const payment = {
  getEarnings: (writerId: string) =>
    request<WriterEarnings>(`/earnings/${writerId}`),
}

// =============================================================================
// Account & Settings
// =============================================================================

/**
 * `GET /my/tab` (gateway/src/routes/my-account.ts).
 *
 * The field names here are the ones the route actually sends. Three of the four
 * it previously declared did not exist on the wire — `balancePence`,
 * `freeAllowanceTotalPence` and `recentReads` were all silently `undefined`,
 * and because the API client is a raw pass-through with no key remapping,
 * nothing anywhere reported it. The live consequence was on the Ledger header,
 * which then netted `earnings − tabBalance`: with `tabBalance` permanently 0, a
 * reader who owed money saw a balance as though they owed none. (That netting
 * is itself gone — Reader Terms 11.1; `BalanceHeader` now renders the two
 * figures separately — but `tabBalancePence` is still the name on the wire.)
 *
 * `freeAllowanceTotalPence` is now genuinely on the wire (§0o.9a) — the reader's
 * OWN granted allowance (`accounts.free_allowance_granted_pence`, migration
 * 169), not the current `free_allowance_pence` dial, so a retune never restates
 * what an existing reader was gifted. It is declared here because it is SENT,
 * not to restore a name that was previously a fiction; the component that
 * consumed the fiction had fallen back to a hardcoded 500.
 *
 * `tabBalancePence` is the LEDGER balance (`ledger_reader_balance`), not
 * `reading_tabs.balance_pence` — see the route's own note on why display reads
 * the ledger while settlement locks the column.
 */
export interface TabOverview {
  tabBalancePence: number
  /** What the platform owes THIS reader back and has not yet refunded
   * (migration 206). POSITIVE pence, and its own figure: a reading tab can no
   * longer go into credit, so this is never subtracted from `tabBalancePence`
   * and never presented as a balance (Reader Terms 4.3). Both can be non-zero
   * at once — owing us for today's reading does not cancel a refund we owe
   * from a billing error last month. */
  refundDuePence: number
  freeAllowanceRemainingPence: number
  /** The `free_allowance_pence` dial — the gauge's denominator. See above. */
  freeAllowanceTotalPence: number
  lastSettledAt: string | null
  /**
   * Set when an off-session settlement charge terminally declined. The tab is
   * frozen — settlement backs off and stops retrying — until the reader
   * re-attaches a working card, so this is not a passive warning: nothing moves
   * again until it is cleared. Rendered by `CardActionRequired`.
   */
  cardActionRequiredAt: string | null
  reads: {
    readId: string
    articleTitle: string
    articleDTag: string
    writerDisplayName: string | null
    writerUsername: string | null
    chargePence: number
    readAt: string
    settledAt: string | null
    isSubscriptionRead: boolean
  }[]
}

export interface MySubscription {
  id: string
  writerId: string
  writerUsername: string
  writerDisplayName: string | null
  writerAvatar: string | null
  pricePence: number
  status: string
  autoRenew: boolean
  currentPeriodEnd: string
  startedAt: string
  cancelledAt: string | null
  hidden: boolean
  notifyOnPublish: boolean
}

export interface Subscriber {
  subscriptionId: string
  readerId: string
  readerUsername: string
  readerDisplayName: string | null
  readerAvatar: string | null
  pricePence: number
  status: string
  isComp: boolean
  autoRenew: boolean
  subscriptionPeriod: string
  startedAt: string
  currentPeriodEnd: string
  cancelledAt: string | null
  articlesRead: number
  totalArticleValuePence: number
  gettingMoneysworth: boolean
}

/**
 * The answer to "settle my tab now" (Reader Terms 5.3). A refusal is a 402/409/
 * 502 and arrives as an ApiError; a 200 means the request was understood, and
 * `settled` says whether a charge was actually made — a tab with nothing on it,
 * or too little for Stripe to charge, is not an error and must not be shown as
 * one.
 */
export interface SettleTabResult {
  ok: boolean
  settled: boolean
  reason?: 'nothing_due' | 'below_minimum'
  amountPence?: number
  balancePence?: number
  message: string
}

/**
 * The Writer's payout preferences (L5.3; Writer 6.3).
 *
 * The cadence vocabulary is a runtime array with the type derived from it,
 * never a bare union: it crosses the wire to a zod enum and a column CHECK, and
 * a type can be compared against nothing at test time.
 * `web/tests/payout-prefs-wire.test.ts` reads the gateway's own list and
 * `schema.sql`'s CHECK and asserts all three agree.
 */
export const PAYOUT_CADENCES = ['daily', 'weekly', 'monthly'] as const
export type PayoutCadence = (typeof PAYOUT_CADENCES)[number]

export interface PayoutPreferences {
  cadence: PayoutCadence
  /** NULL = use the platform's figure, which is not the same as naming it. */
  thresholdPence: number | null
  /** The floor. It ships with the answer rather than being a copy over here. */
  platformThresholdPence: number
  /** The anchor the cadence is measured from; null where nobody has been paid. */
  lastPaidAt: string | null
}

export const account = {
  getTab: () =>
    request<TabOverview>('/my/tab'),

  getPayoutPreferences: () =>
    request<PayoutPreferences>('/my/payout-preferences'),

  updatePayoutPreferences: (cadence: PayoutCadence, thresholdPence: number | null) =>
    request<{ cadence: PayoutCadence; thresholdPence: number | null }>(
      '/my/payout-preferences',
      { method: 'PATCH', body: JSON.stringify({ cadence, thresholdPence }) }
    ),

  settleTab: () =>
    request<SettleTabResult>('/my/tab/settle', { method: 'POST' }),

  getMySubscriptions: () =>
    request<{ subscriptions: MySubscription[] }>('/subscriptions/mine'),

  toggleSubscriptionNotifications: (subscriptionId: string, notifyOnPublish: boolean) =>
    request<{ ok: boolean; notifyOnPublish: boolean }>(`/subscriptions/${subscriptionId}/notifications`, {
      method: 'PATCH',
      body: JSON.stringify({ notifyOnPublish }),
    }),

  updateSubscriptionPrice: (pricePence: number, annualDiscountPct?: number, defaultArticlePricePence?: number | null) =>
    request<{ ok: boolean }>('/settings/subscription-price', {
      method: 'PATCH',
      body: JSON.stringify({
        pricePence,
        ...(annualDiscountPct !== undefined ? { annualDiscountPct } : {}),
        ...(defaultArticlePricePence !== undefined ? { defaultArticlePricePence } : {}),
      }),
    }),

  // The writer's welcome message, sent to a reader on subscribing.
  // `null` means "never set one" and reads as the default template; the PATCH
  // accepts null so the box can be cleared back to it.
  getSubscriptionWelcome: () =>
    request<{ message: string | null }>('/settings/subscription-welcome'),

  updateSubscriptionWelcome: (message: string | null) =>
    request<{ ok: boolean; message: string | null }>('/settings/subscription-welcome', {
      method: 'PATCH',
      body: JSON.stringify({ message }),
    }),

  toggleSubscriptionVisibility: (writerId: string, hidden: boolean) =>
    request<{ ok: boolean; hidden: boolean }>(`/subscriptions/${writerId}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden }),
    }),

  getSubscribers: () =>
    request<{ subscribers: Subscriber[] }>('/subscribers'),
}
