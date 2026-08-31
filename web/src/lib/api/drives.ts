import { request } from './client'

export interface PledgeDrive {
  id: string
  origin: 'crowdfund' | 'commission'
  creatorId: string
  targetWriterId: string
  title: string
  description: string | null
  fundingTargetPence: number | null
  currentTotalPence: number
  pledgeCount: number
  status: 'open' | 'funded' | 'published' | 'fulfilled' | 'expired' | 'cancelled'
  pinned: boolean
  acceptedAt: string | null
  deadline: string | null
  createdAt: string
}

export interface Pledge {
  id: string
  driveId: string
  driveTitle: string
  driveStatus: string
  writer: { username: string; displayName: string | null }
  amountPence: number
  status: string
  createdAt: string
}

export interface Commission {
  id: string
  origin: 'commission'
  title: string
  description: string | null
  fundingTargetPence: number | null
  currentTotalPence: number
  status: string
  acceptedAt: string | null
  deadline: string | null
  createdAt: string
  pledgeCount: number
  commissioner: { username: string; displayName: string | null }
}

export const drives = {
  create: (data: {
    origin: 'crowdfund' | 'commission'
    title: string
    description?: string
    fundingTargetPence?: number
    suggestedPricePence?: number
    targetWriterId?: string
    parentNoteEventId?: string
    parentConversationId?: string
  }) =>
    request<{ driveId: string }>('/drives', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) =>
    request<PledgeDrive>(`/drives/${id}`),

  update: (id: string, data: { title?: string; description?: string; fundingTargetPence?: number }) =>
    request<{ ok: boolean }>(`/drives/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  cancel: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}`, { method: 'DELETE' }),

  pledge: (id: string, amountPence: number) =>
    request<{ pledgeId: string }>(`/drives/${id}/pledge`, {
      method: 'POST',
      body: JSON.stringify({ amountPence }),
    }),

  withdrawPledge: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/pledge`, { method: 'DELETE' }),

  accept: (id: string, terms?: { acceptanceTerms?: string; backerAccessMode?: 'free' | 'paywalled'; deadline?: string }) =>
    request<{ ok: boolean }>(`/drives/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify(terms ?? {}),
    }),

  decline: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/decline`, { method: 'POST' }),

  togglePin: (id: string) =>
    request<{ ok: boolean }>(`/drives/${id}/pin`, { method: 'POST' }),

  listByUser: (userId: string) =>
    request<{ drives: PledgeDrive[] }>(`/drives/by-user/${userId}`),

  myPledges: () =>
    request<{ pledges: Pledge[] }>('/my/pledges'),

  myCommissions: () =>
    request<{ commissions: Commission[] }>('/my/commissions'),
}

// =============================================================================
// Subscription Offers
// =============================================================================

export interface SubscriptionOffer {
  id: string
  label: string
  mode: 'code' | 'grant'
  discountPct: number
  durationMonths: number | null
  code: string | null
  recipientId: string | null
  recipientUsername: string | null
  maxRedemptions: number | null
  redemptionCount: number
  expiresAt: string | null
  revoked: boolean
  createdAt: string
}

export interface OfferLookup {
  id: string
  label: string
  /**
   * 'grant' only ever reaches the account the offer names — the lookup 404s
   * for anyone else and 401s for a logged-out visitor (§1.10). So the page can
   * treat it as "a gift for you" without re-checking anything.
   */
  mode: 'code' | 'grant'
  discountPct: number
  durationMonths: number | null
  writerId: string
  writerUsername: string
  writerDisplayName: string | null
  standardPricePence: number
  discountedPricePence: number
}

export const subscriptionOffers = {
  create: (data: {
    label: string
    mode: 'code' | 'grant'
    discountPct: number
    durationMonths?: number | null
    maxRedemptions?: number | null
    expiresAt?: string | null
    recipientUsername?: string
  }) =>
    // Both modes now carry a code and therefore a /subscribe/:code URL — a
    // grant used to be created with neither, which is what made it dead (§1.10).
    request<{ id: string; code: string; url: string }>('/subscription-offers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  list: () =>
    request<{ offers: SubscriptionOffer[] }>('/subscription-offers'),

  revoke: (offerId: string) =>
    request<{ ok: boolean }>(`/subscription-offers/${offerId}`, {
      method: 'DELETE',
    }),

  lookup: (code: string) =>
    request<OfferLookup>(`/subscription-offers/redeem/${code}`),
}

export function subscribe(writerId: string, opts?: { period?: string; offerCode?: string }) {
  return request<{ subscriptionId: string; status: string; pricePence: number; currentPeriodEnd?: string; writerName?: string }>(
    `/subscriptions/${writerId}`,
    {
      method: 'POST',
      body: JSON.stringify({ period: opts?.period, offerCode: opts?.offerCode }),
    }
  )
}

// =============================================================================
// Gift Links
// =============================================================================

export interface GiftLink {
  id: string
  token: string
  maxRedemptions: number
  redemptionCount: number
  revoked: boolean
  createdAt: string
}

export const giftLinks = {
  create: (articleId: string, maxRedemptions = 5) =>
    request<{ id: string; token: string; url: string; maxRedemptions: number }>(`/articles/${articleId}/gift-link`, {
      method: 'POST',
      body: JSON.stringify({ maxRedemptions }),
    }),

  list: (articleId: string) =>
    request<{ giftLinks: GiftLink[] }>(`/articles/${articleId}/gift-links`),

  revoke: (articleId: string, linkId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/gift-link/${linkId}`, {
      method: 'DELETE',
    }),

  redeem: (articleId: string, token: string) =>
    request<{ ok: boolean; unlocked: boolean }>(`/articles/${articleId}/redeem-gift`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
}
