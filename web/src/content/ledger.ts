// =============================================================================
// The Ledger — the words, in one home for both registers.
//
// The full site's Ledger is a set of client components (`BalanceHeader`,
// `CardActionRequired`, `SettleNowButton`, `AccountLedger`, `SettlementReceipt`,
// `SubscriptionsSection`); modernhaus's `/modernhaus/ledger` and its receipt
// page state the same money facts in bare HTML. A sentence about somebody's
// money said two ways is two claims, so the words live here and both read
// them. The reasoning behind each is in the component that renders it — above
// all `BalanceHeader.tsx`'s header on why the two figures are never netted.
// =============================================================================

export function pounds(pence: number): string {
  return `£${(Math.abs(pence) / 100).toFixed(2)}`
}

// ---- The two figures (BalanceHeader) --------------------------------------

export const LEDGER_OWE_LABEL = 'You owe'
export const LEDGER_TAB_CLEAR = 'Nothing owed on your reading tab.'
export const LEDGER_TAB_OWING = 'Your reading tab. It settles from your card once it reaches its threshold.'
export const LEDGER_OWED_LABEL = 'You are owed'
export const LEDGER_OWED_HELP =
  'Earned from your writing and not yet sent. It pays out to your bank, and never against your reading tab.'
export const LEDGER_REFUND_LABEL = 'Refund due'
export const LEDGER_REFUND_HELP =
  'We charged you more than you owed. We’ll return this to the card it came from — it isn’t a balance, and it isn’t spent against what you read.'
export const LEDGER_ALLOWANCE_LABEL = 'Free allowance'
export function ledgerAllowanceFigure(remainingPence: number, totalPence: number): string {
  return `£${(remainingPence / 100).toFixed(2)} of £${(totalPence / 100).toFixed(2)}`
}
export const LEDGER_READERS_PAID_LABEL = 'Readers paid'
export const LEDGER_FEE_LABEL = 'all.haus fee'
export const LEDGER_FEE_HELP =
  'What readers have paid for your writing, and what we kept for selling it on your behalf. Everything else is yours.'
export const LEDGER_ALLOWANCE_GIVEN_LABEL = 'Read on readers’ allowances'
export function ledgerAllowanceGivenSentence(readCount: number): string {
  return `${readCount === 1 ? 'One read was' : `${readCount} reads were`} covered by new readers’ free allowance. You waived the price on those, so nobody was charged and we took no fee.`
}

// ---- A declined card (CardActionRequired) ---------------------------------

export const CARD_DECLINED_LABEL = 'Card declined'
export const CARD_DECLINED_BODY =
  'Your reading tab is paused. The card on file was declined, so we could not collect what you owe the writers you’ve read. Nothing further will be charged until you add a working card.'
export const CARD_DECLINED_AFTER =
  'Anything you have already read stays on your tab and settles once a new card is added. Your free allowance is unaffected.'
export const CARD_DECLINED_ACTION = 'Add a card'

// ---- Settle now (SettleNowButton) -----------------------------------------

export function settleNowLabel(balancePence: number): string {
  return `Settle £${(balancePence / 100).toFixed(2)} now`
}
export const SETTLE_FAILED = 'We could not settle your tab just now. Try again in a moment.'

// ---- The statement (AccountLedger) ----------------------------------------

export const LEDGER_CATEGORY_LABELS: Record<string, string> = {
  free_allowance: 'Free allowance',
  article_read: 'Paywall',
  article_earning: 'Article read',
  free_read: 'Free',
  subscription_charge: 'Subscription',
  subscription_earning: 'Subscriber',
  vote_charge: 'Vote',
  vote_earning: 'Vote income',
  settlement: 'Settlement',
}
export const LEDGER_COLUMNS = { date: 'Date', type: 'Type', description: 'Description', amount: 'Amount' } as const
export const LEDGER_EMPTY = 'No transactions yet.'
/** The statement did not load. Never rendered as `LEDGER_EMPTY`: a ledger that
 *  could not be read is not a ledger with nothing in it (CA-E1). */
export const LEDGER_LOAD_FAILED = 'Couldn’t load your ledger.'
export const LEDGER_FREE_AMOUNT = 'Free'
export const LEDGER_RECEIPT = 'Receipt'
export const LEDGER_HIDE_RECEIPT = 'Hide receipt'
export const LEDGER_ALL_READS = 'All reads'
export const LEDGER_PAID_ONLY = 'Paid only'

/** The amount column: a credit is `+`, anything else `−`, and a free read says so. */
export function ledgerAmount(entry: { type: string; category: string; amount_pence: number }): string {
  if (entry.category === 'free_read') return LEDGER_FREE_AMOUNT
  return `${entry.type === 'credit' ? '+' : '−'}£${(Math.abs(entry.amount_pence) / 100).toFixed(2)}`
}

// ---- A receipt (SettlementReceipt) ----------------------------------------

export const RECEIPT_HEADING = 'What this charge covered'
export const RECEIPT_ITEMISED_ELSEWHERE = 'This charge collected reading that is itemised on another receipt.'
export const RECEIPT_UNAVAILABLE = 'We couldn’t load this receipt just now. Try again in a moment.'
export const RECEIPT_FREE_ALLOWANCE = 'free allowance'
export const RECEIPT_REVERSED = 'This charge was later reversed.'

/**
 * The gap between what was charged and what is itemised, BY SIGN (§0z item
 * 19b) — the same two sentences as the email, pinned by
 * `settlement-receipt-copy.test.ts`.
 */
export function receiptCarriedSentence(unitemisedPence: number): string {
  return `${pounds(unitemisedPence)} of this charge is balance carried on your tab from earlier activity — a charge restored after a reversal, or a credit that was released back to your tab — rather than the reading and subscriptions listed above.`
}
export function receiptShortfallSentence(unitemisedPence: number): string {
  return `The reading listed above comes to ${pounds(unitemisedPence)} more than this charge; the difference is still on your tab and is collected with your next charge.`
}

// Reader Terms 1.4, in the clause's own terms. ONE SPELLING ACROSS THE HOUSE:
// `shared/src/lib/email/templates/receipt.ts` carries the same sentence for the
// email, and `web/tests/settlement-receipt-copy.test.ts` reads it out of that
// file to pin this copy against it — there is no module path between the
// workspaces, so the pin reads the source.
export const DISCHARGE_SENTENCE =
  'Paying us settles what you owed each Writer in full. We collect it on their behalf, and once a charge has gone through, that debt is discharged.'

// ---- Subscriptions (SubscriptionsSection) ---------------------------------

export const SUBSCRIPTIONS_HEADING = 'Subscriptions'
export const SUBSCRIPTION_CANCEL_TITLE = 'Cancel this subscription?'
export const SUBSCRIPTION_CANCEL_BODY =
  'It will not renew. You keep access until the end of the period you have paid for.'
export const SUBSCRIPTION_CANCEL_CONFIRM = 'Cancel subscription'
export const SUBSCRIPTION_CANCEL_FAILED = 'Couldn’t cancel that subscription — nothing changed. Try again.'
export const SUBSCRIPTION_CANCELLED = 'Cancelled'
export const SUBSCRIPTION_CANCEL = 'Cancel'

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** When a subscription's period ends, and what happens then. */
export function subscriptionTerm(s: { status: string; autoRenew: boolean; currentPeriodEnd: string }): string {
  if (s.status === 'cancelled') return `Access until ${shortDate(s.currentPeriodEnd)}`
  return s.autoRenew ? `Renews ${shortDate(s.currentPeriodEnd)}` : `Expires ${shortDate(s.currentPeriodEnd)}`
}
export function subscriptionMonthly(pricePence: number): string {
  return `£${(pricePence / 100).toFixed(2)}/mo`
}
/** The email-on-publish toggle: its label, and what it means. */
export const SUBSCRIPTION_NOTIFY = { on: 'Notify', off: 'Muted' } as const
export const SUBSCRIPTION_NOTIFY_TITLE = { on: 'Email me when they publish', off: 'Email notifications muted' } as const
/** Whether the subscription shows on the reader's public profile. */
export const SUBSCRIPTION_VISIBILITY = { hidden: 'Hidden', public: 'Public' } as const
export const SUBSCRIPTION_VISIBILITY_TITLE = {
  hidden: 'Hidden from your public profile',
  public: 'Visible on your public profile',
} as const

// ---- The profile's subscribe row (NativeProfileBody) ----------------------

export function subscribeMonthlyLabel(monthlyPence: number): string {
  return `Subscribe £${(monthlyPence / 100).toFixed(2)}/mo`
}
export function subscribeAnnualLabel(annualPence: number): string {
  return `£${(annualPence / 100).toFixed(2)}/yr`
}
export const SUBSCRIBE_ACCEPT = 'Accept and subscribe'
export const SUBSCRIBED = 'Subscribed'
export const UNSUBSCRIBE_FAILED = "Couldn't cancel — you are still subscribed. Try again."
