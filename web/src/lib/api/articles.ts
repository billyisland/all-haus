import { request } from "./client";

export interface ArticleMetadata {
  id: string;
  nostrEventId: string;
  dTag: string;
  title: string;
  slug: string;
  summary: string | null;
  contentFree: string | null;
  wordCount: number | null;
  isPaywalled: boolean;
  pricePence: number | null;
  gatePositionPct: number | null;
  vaultEventId: string | null;
  coverImageUrl: string | null;
  publishedAt: string | null;
  writerSpendThisMonthPence: number | null;
  nudgeShownThisMonth: boolean;
  writer: {
    id: string;
    username: string;
    displayName: string | null;
    avatar: string | null;
    pubkey: string;
    subscriptionPricePence?: number;
  };
  publication: {
    id: string;
    slug: string;
    name: string;
    subscriptionPricePence: number | null;
  } | null;
}

interface GatePassResponse {
  readEventId: string;
  allowanceJustExhausted?: boolean;
  readState: string;
  encryptedKey: string;
  algorithm: string;
  isReissuance: boolean;
  ciphertext?: string; // base64-encoded encrypted body (from vault_keys)
}

export const articles = {
  getByDTag: (dTag: string) => request<ArticleMetadata>(`/articles/${dTag}`),

  gatePass: (nostrEventId: string) =>
    request<GatePassResponse>(`/articles/${nostrEventId}/gate-pass`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  index: (data: {
    nostrEventId: string;
    dTag: string;
    title: string;
    summary?: string;
    content: string;
    accessMode: "public" | "paywalled" | "invitation_only";
    pricePence: number;
    gatePositionPct: number;
    vaultEventId?: string;
    coverImageUrl?: string | null;
    commentsEnabled?: boolean;
    draftId?: string;
    sendEmail?: boolean;
    emailAsNew?: boolean;
  }) =>
    request<{ articleId: string; isNew: boolean }>("/articles", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  togglePin: (articleId: string) =>
    request<{ pinned: boolean }>(`/articles/${articleId}/pin`, {
      method: "POST",
    }),

  // Soft-delete (writer-owned). Used by the publish pipeline to compensate a
  // failed paywalled publish so no broken article stays live.
  remove: (articleId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}`, { method: "DELETE" }),
};

// =============================================================================
// Content Resolution
// =============================================================================

export interface ResolvedContent {
  type: "note" | "article";
  eventId: string;
  content?: string;
  title?: string;
  dTag?: string;
  accessMode?: string;
  isPaywalled?: boolean;
  publishedAt: number;
  author: {
    username: string;
    displayName: string | null;
    avatar: string | null;
  };
}

export const content = {
  resolve: (eventId: string) =>
    request<ResolvedContent>(
      `/content/resolve?eventId=${encodeURIComponent(eventId)}`,
    ),
};

// =============================================================================
// Article Management (editorial dashboard)
// =============================================================================

export interface MyArticle {
  id: string;
  title: string;
  slug: string;
  dTag: string;
  nostrEventId: string;
  isPaywalled: boolean;
  pricePence: number | null;
  wordCount: number | null;
  publishedAt: string | null;
  repliesEnabled: boolean;
  replyCount: number;
  readCount: number;
  netEarningsPence: number;
}

export const myArticles = {
  list: () => request<{ articles: MyArticle[] }>("/my/articles"),

  update: (articleId: string, data: { repliesEnabled?: boolean }) =>
    request<{ ok: boolean }>(`/articles/${articleId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  remove: (articleId: string) =>
    request<{
      ok: boolean;
      deletedArticleId: string;
      nostrEventId: string;
      dTag: string;
    }>(`/articles/${articleId}`, { method: "DELETE" }),

  unpublish: (articleId: string) =>
    request<{ ok: boolean }>(`/articles/${articleId}/unpublish`, {
      method: "POST",
    }),
};

// =============================================================================
// Bookmarks
// =============================================================================

export interface BookmarkedArticle {
  id: string;
  nostr_event_id: string;
  nostr_d_tag: string;
  title: string;
  slug: string;
  summary: string | null;
  word_count: number | null;
  access_mode: string;
  price_pence: number | null;
  published_at: string;
  author_username: string;
  author_display_name: string | null;
  author_pubkey: string;
  author_avatar: string | null;
  bookmarked_at: string;
}

export const bookmarks = {
  add: (nostrEventId: string) =>
    request<{ ok: boolean }>(`/bookmarks/${nostrEventId}`, { method: "POST" }),

  remove: (nostrEventId: string) =>
    request<{ ok: boolean }>(`/bookmarks/${nostrEventId}`, {
      method: "DELETE",
    }),

  list: (limit = 20, offset = 0) =>
    request<{ articles: BookmarkedArticle[]; hasMore: boolean }>(
      `/bookmarks?limit=${limit}&offset=${offset}`,
    ),

  ids: () => request<{ eventIds: string[] }>("/bookmarks/ids"),
};

// =============================================================================
// Tags
// =============================================================================

export interface TagSuggestion {
  name: string;
  count: number;
}

export const tags = {
  search: (q: string) =>
    request<{ tags: TagSuggestion[] }>(
      `/tags/search?q=${encodeURIComponent(q)}`,
    ),

  getByName: (name: string, limit = 20, offset = 0) =>
    request<{ tag: string; articles: any[]; total: number }>(
      `/tags/${encodeURIComponent(name)}?limit=${limit}&offset=${offset}`,
    ),

  getForArticle: (articleId: string) =>
    request<{ tags: string[] }>(`/articles/${articleId}/tags`),

  setForArticle: (articleId: string, tagNames: string[]) =>
    request<{ ok: boolean; tags: string[] }>(`/articles/${articleId}/tags`, {
      method: "PUT",
      body: JSON.stringify({ tags: tagNames }),
    }),
};

// =============================================================================
// Reading History
// =============================================================================

export interface ReadingHistoryItem {
  articleId: string;
  readAt: string;
  title: string | null;
  slug: string | null;
  dTag: string | null;
  wordCount: number | null;
  isPaywalled: boolean;
  writer: {
    username: string | null;
    displayName: string | null;
    avatar: string | null;
  };
}

export const readingHistory = {
  list: (limit = 50, offset = 0) =>
    request<{ items: ReadingHistoryItem[] }>(
      `/my/reading-history?limit=${limit}&offset=${offset}`,
    ),
};

// =============================================================================
// Reading positions (per-article scroll resumption)
// =============================================================================

export interface ReadingPosition {
  scrollRatio: number;
  updatedAt: string;
}

export const readingPositions = {
  get: (nostrEventId: string) =>
    request<{ position: ReadingPosition | null }>(
      `/reading-positions/${nostrEventId}`,
    ),

  upsert: (nostrEventId: string, scrollRatio: number) =>
    request<{ ok: boolean }>(`/reading-positions/${nostrEventId}`, {
      method: "PUT",
      body: JSON.stringify({ scrollRatio }),
    }),
};

export const readingPreferences = {
  get: () => request<{ alwaysOpenAtTop: boolean }>("/me/reading-preferences"),

  update: (alwaysOpenAtTop: boolean) =>
    request<{ ok: boolean; alwaysOpenAtTop: boolean }>(
      "/me/reading-preferences",
      {
        method: "PUT",
        body: JSON.stringify({ alwaysOpenAtTop }),
      },
    ),
};

export const privacyPreferences = {
  get: () =>
    request<{ discoveryEnabled: boolean; publishFollowGraph: boolean }>(
      "/me/privacy-preferences",
    ),

  update: (prefs: { discoveryEnabled?: boolean; publishFollowGraph?: boolean }) =>
    request<{
      ok: boolean;
      discoveryEnabled: boolean;
      publishFollowGraph: boolean;
    }>("/me/privacy-preferences", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),
};
