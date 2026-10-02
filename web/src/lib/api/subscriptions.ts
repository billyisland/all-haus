import { request } from './client'

// =============================================================================
// Subscriptions — the ONE web client for `/subscriptions/:writerId` (CA-J3).
//
// Every surface that checks, starts or cancels a subscription comes through
// here, so a refusal always arrives as an `ApiError` carrying the route's
// status and body — the exact shape `mapSubscribeError` (lib/subscribe-errors)
// reads. Surfaces that hand-rolled the fetch each re-implemented the ok-check,
// and one of them (the paywall's Subscribe) read only the status and told a
// declined card-holder to add a card (CA-E6).
// =============================================================================

/** `GET /subscriptions/check/:writerId`. `subscribed` covers a cancelled row
 *  still inside its paid-up period; `ownContent` is the viewer's own page. */
export interface SubscriptionCheck {
  subscribed: boolean
  ownContent?: boolean
  subscriptionId?: string
  status?: string
  currentPeriodEnd?: string
  pricePence?: number
}

/**
 * `restored` is true when a cancelled subscription still inside its paid-up
 * period was simply un-cancelled — nothing charged, the period and price as
 * they were (CA-A2). `period` and `currentPeriodEnd` describe the row that
 * stands, whatever the request asked for.
 */
export interface SubscribeResult {
  subscriptionId: string
  status: string
  restored: boolean
  pricePence: number
  isComp: boolean
  period: 'monthly' | 'annual'
  currentPeriodEnd: string
  writerName?: string
}

export function subscribe(writerId: string, opts?: { period?: string; offerCode?: string }) {
  return request<SubscribeResult>(`/subscriptions/${encodeURIComponent(writerId)}`, {
    method: 'POST',
    body: JSON.stringify({ period: opts?.period, offerCode: opts?.offerCode }),
  })
}

export const subscriptions = {
  check: (writerId: string) =>
    request<SubscriptionCheck>(`/subscriptions/check/${encodeURIComponent(writerId)}`),

  subscribe,

  /** Cancels at period end: access runs to `accessUntil`. 404 = nothing to cancel. */
  unsubscribe: (writerId: string) =>
    request<{ subscriptionId: string; status: 'cancelled'; accessUntil: string }>(
      `/subscriptions/${encodeURIComponent(writerId)}`,
      { method: 'DELETE' },
    ),
}
