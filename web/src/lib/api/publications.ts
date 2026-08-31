import { request } from './client'

// The wire shape of GET /publications/:slug, which returns the raw row —
// snake_case, mirroring the route's SELECT list (publications/core.ts). This
// type drifted camelCase for years (plus a themeConfig no route has served
// since 2e7fcf63) and nothing noticed because .get() currently has no callers;
// keep it matching the SELECT, not what a consumer might wish the shape were.
interface Publication {
  id: string
  slug: string
  name: string
  tagline: string | null
  about: string | null
  logo_blossom_url: string | null
  cover_blossom_url: string | null
  nostr_pubkey: string
  subscription_price_pence: number
  annual_discount_pct: number
  default_article_price_pence: number
  homepage_layout: string
  status: string
  founded_at: string
}

export interface PublicationMembership {
  id: string
  slug: string
  name: string
  logo_blossom_url: string | null
  role: string
  is_owner: boolean
  can_publish: boolean
  can_edit_others: boolean
  can_manage_members: boolean
  can_manage_finances: boolean
  can_manage_settings: boolean
}

export interface PublicationMember {
  id: string
  account_id: string
  role: string
  contributor_type: string
  title: string | null
  is_owner: boolean
  revenue_share_bps: number | null
  can_publish: boolean
  can_edit_others: boolean
  can_manage_members: boolean
  can_manage_finances: boolean
  can_manage_settings: boolean
  username: string
  display_name: string | null
  avatar_blossom_url: string | null
  nostr_pubkey: string
}

export interface PublicationInvite {
  id: string
  role: string
  contributor_type: string
  message: string | null
  expires_at: string
  publication_name: string
  publication_slug: string
  publication_logo: string | null
  inviter_name: string
}

export const publications = {
  // Management
  create: (data: { slug: string; name: string; tagline?: string; about?: string }) =>
    request<{ id: string; slug: string }>('/publications', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (slug: string) =>
    request<Publication>(`/publications/${slug}`),

  update: (id: string, data: Partial<{
    name: string; tagline: string | null; about: string | null;
    logo_blossom_url: string | null; cover_blossom_url: string | null;
    subscription_price_pence: number; annual_discount_pct: number;
    default_article_price_pence: number; homepage_layout: string;
  }>) =>
    request<{ ok: boolean }>(`/publications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  archive: (id: string) =>
    request<{ ok: boolean }>(`/publications/${id}`, { method: 'DELETE' }),

  // Members
  getMembers: (id: string) =>
    request<{ members: PublicationMember[] }>(`/publications/${id}/members`),

  invite: (id: string, data: {
    email?: string; accountId?: string; role?: string;
    contributorType?: string; message?: string;
  }) =>
    request<{ inviteId: string; token: string }>(`/publications/${id}/members/invite`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  acceptInvite: (publicationId: string, token: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/accept`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  // No revenueShareBps: the members route stopped accepting it 2026-08-06
  // (CONSOLIDATED-TODO §1.15) — a standing share is finance, not membership, and
  // its one writer is updatePayroll below. Kept off this type so a call site
  // that tries fails to compile rather than posting a silent no-op.
  updateMember: (publicationId: string, memberId: string, data: Partial<{
    role: string; contributorType: string; title: string | null;
    canPublish: boolean; canEditOthers: boolean;
    canManageMembers: boolean; canManageFinances: boolean; canManageSettings: boolean;
  }>) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  removeMember: (publicationId: string, memberId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/members/${memberId}`, {
      method: 'DELETE',
    }),

  transferOwnership: (publicationId: string, newOwnerId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/transfer-ownership`, {
      method: 'POST',
      body: JSON.stringify({ newOwnerId }),
    }),

  leave: (publicationId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/leave`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // CMS
  listArticles: (id: string, opts?: { status?: string; limit?: number; offset?: number }) =>
    request<{ articles: any[] }>(`/publications/${id}/articles${opts?.status ? `?status=${opts.status}` : ''}`),

  submitArticle: (id: string, data: {
    title: string; summary?: string; content: string; fullContent: string;
    accessMode?: string; pricePence?: number; gatePositionPct?: number;
    showOnWriterProfile: boolean; existingDTag?: string;
    coverImageUrl?: string | null; commentsEnabled?: boolean;
  }) =>
    request<{ articleId: string; status: string; dTag: string; nostrEventId?: string }>(
      `/publications/${id}/articles`,
      { method: 'POST', body: JSON.stringify(data) }
    ),

  publishArticle: (publicationId: string, articleId: string) =>
    request<{ nostrEventId: string }>(`/publications/${publicationId}/articles/${articleId}/publish`, {
      method: 'POST',
    }),

  unpublishArticle: (publicationId: string, articleId: string) =>
    request<{ ok: boolean }>(`/publications/${publicationId}/articles/${articleId}/unpublish`, {
      method: 'POST',
    }),

  // Reader-facing
  getPublic: (slug: string) =>
    request<{
      id: string; slug: string; name: string; tagline: string | null; about: string | null;
      logo_blossom_url: string | null; cover_blossom_url: string | null;
      nostr_pubkey: string; subscription_price_pence: number; annual_discount_pct: number;
      homepage_layout: string;
      founded_at: string; follower_count: number; member_count: number; article_count: number;
      isFollowing: boolean; isSubscribed: boolean;
    }>(`/publications/${slug}/public`),

  getPublicArticles: (slug: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    const qs = params.toString()
    return request<{ articles: any[] }>(`/publications/by-slug/${slug}/articles${qs ? `?${qs}` : ''}`)
  },

  getMasthead: (slug: string) =>
    request<{ members: any[] }>(`/publications/${slug}/masthead`),

  follow: (id: string) =>
    request<{ ok: boolean }>(`/follows/publication/${id}`, { method: 'POST', body: JSON.stringify({}) }),

  unfollow: (id: string) =>
    request<{ ok: boolean }>(`/follows/publication/${id}`, { method: 'DELETE' }),

  subscribe: (id: string) =>
    request<{ subscriptionId: string }>(`/subscriptions/publication/${id}`, { method: 'POST', body: JSON.stringify({}) }),

  cancelSubscription: (id: string) =>
    request<{ ok: boolean }>(`/subscriptions/publication/${id}`, { method: 'DELETE' }),

  // Revenue (Phase 5)
  getRateCard: (id: string) =>
    request<{ subscriptionPricePence: number; annualDiscountPct: number; defaultArticlePricePence: number; articlePriceMode: string }>(
      `/publications/${id}/rate-card`
    ),

  updateRateCard: (id: string, data: {
    subscriptionPricePence?: number; annualDiscountPct?: number; defaultArticlePricePence?: number; articlePriceMode?: string;
  }) =>
    request<{ ok: boolean }>(`/publications/${id}/rate-card`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getPayroll: (id: string) =>
    request<{
      members: Array<{
        memberId: string; accountId: string; username: string; displayName: string;
        avatarBlossomUrl: string | null; role: string; contributorType: string;
        title: string | null; isOwner: boolean; revenueShareBps: number | null;
      }>;
      articleShares: Array<{
        id: string; articleId: string; accountId: string; username: string; displayName: string;
        articleTitle: string; articleSlug: string; shareType: string; shareValue: number; paidOut: boolean;
      }>;
      totalStandingBps: number;
    }>(`/publications/${id}/payroll`),

  updatePayroll: (id: string, shares: Array<{ memberId: string; revenueShareBps: number }>) =>
    request<{ ok: boolean; totalBps: number }>(`/publications/${id}/payroll`, {
      method: 'PATCH',
      body: JSON.stringify({ shares }),
    }),

  setArticleShare: (id: string, articleId: string, data: {
    accountId: string; shareType: 'revenue_bps' | 'flat_fee_pence'; shareValue: number;
  }) =>
    request<{ ok: boolean }>(`/publications/${id}/payroll/article/${articleId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getEarnings: (id: string) =>
    request<{
      summary: {
        grossPence: number; netPence: number; pendingPence: number; paidPence: number; readCount: number;
        subscriptionNetPence: number;
      };
      articles: Array<{
        articleId: string; title: string; slug: string; publishedAt: string | null;
        readCount: number; netPence: number;
      }>;
      payouts: Array<{
        id: string; totalPoolPence: number; subNetPence: number; platformFeePence: number; flatFeesPaidPence: number;
        remainingPoolPence: number; status: string; triggeredAt: string; completedAt: string | null;
        splits: Array<{
          accountId: string; username: string; displayName: string; amountPence: number;
          shareType: string; shareBps: number | null; status: string;
        }>;
      }>;
    }>(`/publications/${id}/earnings`),

  // Invites
  getInvite: (token: string) =>
    request<PublicationInvite>(`/publications/invites/${token}`),

  // Personal
  myMemberships: () =>
    request<{ publications: PublicationMembership[] }>('/my/publications'),
}
