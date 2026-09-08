import { request } from "./client";
import type { Post } from "../post/types";

export interface ArticleMetadata {
  id: string;
  /**
   * The unified key (READING-LOG-AND-LIBRARY-ADR D8) — `feed_items.post_id`,
   * resolved server-side by the article-metadata query. It is what names this
   * piece to `/reading-log` and `/reading-positions`, both of which take a
   * post_id and nothing else so that native and external readers speak one key.
   * Never derive one client-side: post_id is minted once and its native branch
   * has a fallback, so a derivation can name no row at all.
   */
  postId: string;
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

// The paywall arrival landing (PAYWALL-ARRIVAL-ADR §3, D4, §11.4).
//
// `arrival: false` is the answer for everyone who did not create their account
// from THIS piece — which is every member signing in at the same gate, and
// every ordinary reload by anyone else. There is no client-side test that could
// stand in for it: the discriminator is `accounts.arrival_article_id`, stamped
// at account creation, and a page view knows nothing about how its viewer's
// account came to exist.
//
// `unlocked` is the server saying it performed the gate pass, which it does
// only when the read costs nothing (at or below the cap, deliverable, no card).
// When it is false the piece is simply still gated and the reader meets the
// ordinary button — so the modal must not promise otherwise.
export interface ArrivalResponse {
  arrival: boolean;
  unlocked?: boolean;
  /** The ordinary welcome gift as it stood FOR THIS READER — the dial at the
   *  moment they were granted it, not the live one, which is a different number
   *  the day an operator retunes (migration 169's rule, migration 188's twin). */
  welcomeGiftPence?: number;
  arrivalGiftPence?: number;
  pricePence?: number | null;
  gatePass?: GatePassResponse;
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

  // Keyed on the D-TAG, not the nostr event id, because the thing being tested
  // is "is this the URL this account was created from" and the d-tag is what
  // that URL contains.
  arrival: (dTag: string) =>
    request<ArrivalResponse>(`/articles/${dTag}/arrival`, {
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
// The all.haus library — what the reader ACQUIRED (D2)
//
// Every piece a `read_event` exists for, gifted and subscription reads
// included: the test is *acquired*, not *charged*. Its twin is the reading log
// below, which records attention rather than possession — neither is a filter
// of the other.
//
// Replaces `readingHistory`, whose route (`/my/reading-history`) answered 500
// for every caller from the day it was written and so had never returned a row.
// =============================================================================

export interface LibraryItem {
  articleId: string;
  acquiredAt: string;
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

export const library = {
  list: (limit = 50, offset = 0) =>
    request<{ items: LibraryItem[] }>(
      `/my/library?limit=${limit}&offset=${offset}`,
    ),
};

// =============================================================================
// Recent reading — what the reader OPENED (D1/D3/D5)
//
// Every piece opened in a reader, all.haus or not, paid or not, on a rolling
// window. One row per piece at its latest open, so returning to something moves
// it up the list rather than filling the list with it.
//
// `record` is FIRE-AND-FORGET by contract and swallows its own failure here as
// well as at the call site: a failed write loses a row, and a write that could
// fail an open would cost the reader the piece. It is called on reader MOUNT,
// never on unlock — see hooks/useReadingLog.ts, the log's one writer.
// =============================================================================

export const readingLog = {
  record: (postId: string) =>
    request<{ ok: boolean; logged: boolean }>("/reading-log", {
      method: "POST",
      body: JSON.stringify({ postId }),
    }).catch(() => ({ ok: false, logged: false })),

  // `hasMore` comes from the SERVER, off the log itself. The page's own length
  // cannot answer it: a row whose piece no longer resolves is skipped by the
  // join, so a full page can arrive short and "shorter than asked for" does not
  // mean "the end".
  list: (limit = 50, offset = 0) =>
    request<{ items: ReadingLogEntry[]; hasMore: boolean }>(
      `/reading-log?limit=${limit}&offset=${offset}`,
    ),

  clear: () =>
    request<{ ok: boolean; deleted: number }>("/reading-log", {
      method: "DELETE",
    }),
};

// =============================================================================
// Reading positions (per-piece scroll resumption)
//
// Keyed on post_id since migration 189 (D8): an external post has no `articles`
// row, so the old nostr-event key meant resume worked on native pieces and not
// external ones.
// =============================================================================

/** One row of Recent reading: when it was opened, and the card it renders as. */
export interface ReadingLogEntry {
  openedAt: string;
  post: Post;
}

export interface ReadingPosition {
  scrollRatio: number;
  updatedAt: string;
}

export const readingPositions = {
  get: (postId: string) =>
    request<{ position: ReadingPosition | null }>(
      `/reading-positions/${postId}`,
    ),

  upsert: (postId: string, scrollRatio: number) =>
    request<{ ok: boolean }>(`/reading-positions/${postId}`, {
      method: "PUT",
      body: JSON.stringify({ scrollRatio }),
    }),
};

export interface ReadingPrefs {
  alwaysOpenAtTop: boolean;
  /** D1's stop-logging switch for Recent reading. */
  readingLogEnabled: boolean;
}

export const readingPreferences = {
  get: () => request<ReadingPrefs>("/me/reading-preferences"),

  // Both dials go in one call because they share a settings section and a row.
  // `readingLogEnabled` is optional at the route: omitting it leaves the column
  // alone, so a caller that knows only about resume cannot switch a member's
  // logging back on by touching the other toggle.
  update: (prefs: { alwaysOpenAtTop: boolean; readingLogEnabled?: boolean }) =>
    request<{ ok: true } & ReadingPrefs>("/me/reading-preferences", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),
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
