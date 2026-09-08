import { request } from "./client";
import type { Post } from "../post/types";
import type { AuthorProfile } from "./post";

// Workspace feeds — owner-private feed objects, one per ⊔ vessel. Slice 4
// adds source CRUD; the items endpoint now honours source rows.

export interface WorkspaceFeed {
  id: string;
  name: string;
  // Per-feed appearance (migration 112). `scheme` is a curated colour-scheme
  // id and `density` a card-density id from components/workspace/tokens.ts;
  // absent means "never picked" (client falls back to the legacy per-device
  // value, then the default). Server-side because a feed's appearance is feed
  // character — it travels with the feed, not the device
  // (MOBILE-LAYOUT-ADR §VI).
  appearance?: { scheme?: string; density?: string };
  // Persisted order (migration 113, MOBILE-LAYOUT-ADR §VII). The numeral is
  // derived 1..N client-side over *visible* feeds in this order; resume and
  // deep-links key off `id`, never the numeral.
  sortRank: number;
  // Feed character, not layout state (§V): hidden feeds are excluded from
  // the mobile rotation and skipped by the numbering on both surfaces.
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  // Computed provenance (EXPLAIN-ADR D7): true iff this feed is a clone of the
  // starter template. Drives the first-run / Explain copy fork off the anchored
  // vessel (`vessel.feed.fromStarter`). A hand-created feed is always false.
  fromStarter: boolean;
}

// The items endpoint emits the unified Post[] (gateway feedItemToPost) —
// the same shape every other feed surface returns — so the workspace renders them
// through the one Post-model card path with no client-side legacy-item adapter
// (FEED-RETIREMENT-PLAN Slice 6 item 4). Ranking stays the per-vessel
// effective_score (weight × sampling_mode), carried only in `nextCursor`.
export interface WorkspaceFeedItemsResponse {
  feed: WorkspaceFeed;
  items: Post[];
  nextCursor?: string;
  placeholder: boolean;
}

export type WorkspaceFeedSourceKind =
  | "account"
  | "publication"
  | "external_source"
  | "tag";

// Origin binding of an import-minted feed (FOLLOW-GRAPH-IMPORT-ADR §6.3):
// which network graph it came from, for the FeedComposer's "Sync now".
export interface FeedImportBinding {
  protocol: string;
  originIdentity: string;
  lastSyncedAt: string | null;
}

export interface WorkspaceFeedSource {
  id: string;
  sourceType: WorkspaceFeedSourceKind;
  accountId?: string;
  externalSourceId?: string;
  weight: number;
  samplingMode: "random" | "top";
  excludeReplies: boolean;
  mutedAt: string | null;
  createdAt: string;
  display: {
    kind: WorkspaceFeedSourceKind;
    label: string;
    sublabel: string | null;
    // In-app destination for the source name — the surface a byline links to on
    // a feed card (account → /:username, publication → /pub/:slug, external →
    // /source/:id, tag → /tag/:name). null when the target is deleted.
    href: string | null;
  };
}

export type AddWorkspaceFeedSourceInput =
  | { sourceType: "account"; accountId: string }
  | { sourceType: "publication"; publicationId: string }
  | { sourceType: "tag"; tagName: string }
  | { sourceType: "external_source"; externalSourceId: string }
  | {
      sourceType: "external_source";
      protocol: "rss" | "atproto" | "activitypub" | "nostr_external";
      sourceUri: string;
      displayName?: string;
      description?: string;
      avatarUrl?: string;
      relayUrls?: string[];
    };

// One-shot workspace hydration (performance audit #3): the feed list plus, per
// feed, its sources and first page of items — collapsing the old
// list()+listSources()+items() fan-out into a single round trip. `vessels` is
// keyed by feed id; a feed may be absent (server-side hydration hiccup) and the
// client then loads that vessel lazily via items()/listSources().
export interface WorkspaceBootstrapResponse {
  feeds: WorkspaceFeed[];
  vessels: Record<
    string,
    {
      sources: WorkspaceFeedSource[];
      items: Post[];
      nextCursor?: string;
      placeholder: boolean;
    }
  >;
}

export const workspaceFeeds = {
  list: () => request<{ feeds: WorkspaceFeed[] }>("/workspace/feeds"),

  bootstrap: () =>
    request<WorkspaceBootstrapResponse>("/workspace/bootstrap"),

  create: (name: string) =>
    request<{ feed: WorkspaceFeed }>("/workspace/feeds", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  rename: (id: string, name: string) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  // Server-side merge: other appearance keys on the row survive a
  // single-key update.
  setAppearance: (id: string, appearance: { scheme?: string; density?: string }) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ appearance }),
    }),

  // Hide is feed character (MOBILE-LAYOUT-ADR §V): persisted on the feed row,
  // not in per-device layout state.
  setHidden: (id: string, hidden: boolean) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ hidden }),
    }),

  // Bulk re-rank (MOBILE-LAYOUT-ADR §VII.3): the complete feed set in the
  // desired order; ranks rewritten in full server-side. 409 means the list
  // is stale (feed created/deleted elsewhere) — refetch and retry.
  reorder: (feedIds: string[]) =>
    request<{ feeds: WorkspaceFeed[] }>("/workspace/feeds/order", {
      method: "PUT",
      body: JSON.stringify({ feedIds }),
    }),

  remove: (id: string) =>
    request<void>(`/workspace/feeds/${id}`, { method: "DELETE" }),

  merge: (targetFeedId: string, sourceFeedId: string) =>
    request<{ feed: WorkspaceFeed }>(`/workspace/feeds/${targetFeedId}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceFeedId }),
    }),

  items: (id: string, opts?: { cursor?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set("cursor", opts.cursor);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<WorkspaceFeedItemsResponse>(
      `/workspace/feeds/${id}/items${suffix}`,
    );
  },

  // Slice 4: source authoring
  listSources: (id: string) =>
    request<{
      sources: WorkspaceFeedSource[];
      // Present iff the feed was minted by a follow-graph import
      // (FOLLOW-GRAPH-IMPORT-ADR §6.3) — the composer's "Sync now" hook.
      importBinding?: FeedImportBinding | null;
    }>(`/workspace/feeds/${id}/sources`),

  addSource: (id: string, input: AddWorkspaceFeedSourceInput) =>
    request<{ source: WorkspaceFeedSource }>(`/workspace/feeds/${id}/sources`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  removeSource: (id: string, sourceId: string) =>
    request<void>(`/workspace/feeds/${id}/sources/${sourceId}`, {
      method: "DELETE",
    }),

  moveSource: (sourceFeedId: string, sourceId: string, targetFeedId: string) =>
    request<{ ok: true }>(
      `/workspace/feeds/${sourceFeedId}/sources/${sourceId}/move`,
      {
        method: "POST",
        body: JSON.stringify({ targetFeedId }),
      },
    ),

  patchSource: (
    id: string,
    sourceId: string,
    body: {
      step?: number;
      sampling?: "random" | "top";
      muted?: boolean;
      excludeReplies?: boolean;
    },
  ) =>
    request<{ source: WorkspaceFeedSource }>(
      `/workspace/feeds/${id}/sources/${sourceId}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),

  // Slice 14: per-feed-per-author volume + sampling commitment surfaced from
  // the pip panel. step=null means "passive" (no row), step=0 mutes, 1..5 are
  // the committed levels mapped to feed_sources.weight server-side.
  getAuthorVolume: (feedId: string, pubkey: string) =>
    request<AuthorVolume>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`),

  setAuthorVolume: (
    feedId: string,
    pubkey: string,
    body: { step: number; sampling: "random" | "top" },
  ) =>
    request<AuthorVolume>(
      `/workspace/feeds/${feedId}/author-volume/${pubkey}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    ),

  clearAuthorVolume: (feedId: string, pubkey: string) =>
    request<void>(`/workspace/feeds/${feedId}/author-volume/${pubkey}`, {
      method: "DELETE",
    }),

};

// The four `saves` methods and their response type stood here until 2026-09-04.
// They and their routes are gone with `feed_saves` (migration 189).
//
// THE COMMENT THAT WENT WITH THEM IS THE PART WORTH RECORDING, because it
// declared a plan this decision reverses: "the BookmarkButton retires with the
// deprecated chassis on merge, so the workspace's save story is solely this
// surface." Both save mechanisms were fully built and neither was ever placed —
// `bookmarks` shipped a table, route, client and button with the button mounted
// nowhere, and `feed_saves` shipped live routes with no caller, 0 rows on every
// database. Two unmounted mechanisms are not evidence of two wants; they are
// one want, built twice and placed never, and the second was built *because*
// the first was never placed. Two automatic logs supersede both: Recent reading
// (attention) and the library (possession) — READING-LOG-AND-LIBRARY-ADR D10.
//
// If "save a piece I have not bought" turns out to be a real want, it comes
// back as its own decision with its own surface, not as a third empty tab.

export interface AuthorVolume {
  authorPubkey: string;
  accountId: string | null;
  step: number | null;
  sampling: "random" | "top";
  muted: boolean;
}

// ---------------------------------------------------------------------------
// External item interactions (Phase 2 — live engagement + parent context)
// ---------------------------------------------------------------------------

export interface EngagementResponse {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  protocol: string;
  fetchedAt: string;
}

export interface ParentContextResponse {
  parent: ParentItem | null;
  grandparentTag: { authorName: string; authorHandle: string } | null;
  // Server-signalled: a parent was expected but the source fetch failed/timed out.
  partial: boolean;
}

export interface ParentItem {
  id: string;
  sourceProtocol: string;
  sourceItemUri: string;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  authorUri: string | null;
  contentText: string | null;
  contentHtml: string | null;
  title: string | null;
  summary: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  media: unknown[];
  publishedAt: number;
  sourceReplyUri: string | null;
}

export interface QuoteResponse {
  // The quoted post, rendered as a nested mini-card (reuses ParentItem's shape,
  // which carries the post's own media). null when nothing is quoted or the
  // source fetch failed.
  quote: ParentItem | null;
  // Server-signalled: a quote was expected but the source fetch failed/timed out.
  partial: boolean;
}

export interface ExternalThreadEntry {
  id: string;
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null;
  protocol: string;
}

export interface ThreadResponse {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  // The re-rooted focal node as a full card (author + content + own media +
  // engagement counts), carrying a real all.haus id so it can be liked/reposted/
  // replied to. Present only when the request re-roots (`?focus=`); null if the
  // focus node's source fetch failed (client falls back to the lightweight focal).
  focus?: ParentItem | null;
  // Server-signalled: the source thread could not be reached/completed.
  partial: boolean;
}

export const externalItems = {
  engagement: (id: string) =>
    request<EngagementResponse>(`/external-items/${id}/engagement`),

  parent: (id: string) =>
    request<ParentContextResponse>(`/external-items/${id}/parent`),

  quote: (id: string) => request<QuoteResponse>(`/external-items/${id}/quote`),

  // `focus` re-roots the returned thread on a source-platform node (an
  // ExternalThreadEntry.id — an at:// URI for Bluesky, a numeric status id for
  // Mastodon); the gateway derives a synthetic item on the same source.
  thread: (id: string, focus?: string) =>
    request<ThreadResponse>(
      `/external-items/${id}/thread${
        focus ? `?focus=${encodeURIComponent(focus)}` : ""
      }`,
    ),
};

// External source surface (CARD-BEHAVIOUR-ADR §VI.2, BYLINE-AND-PROVENANCE-ADR
// D7) — the provenance-line destination.
export interface SourceMeta {
  id: string;
  protocol: string;
  sourceUri: string;
  displayName: string | null;
  description: string | null;
  // Same shape as AuthorProfile.followTarget (type "source"), so the surface
  // mounts the same feed-derived ProfileFollowControl (ADR D6/D7 ⟂).
  followTarget?: AuthorProfile["followTarget"];
}

export interface SourceSurfaceResponse {
  source: SourceMeta;
  // Unified Post model (UNIVERSAL-POST-ADR §9), rendered through PostCard —
  // same shape GET /author/:id/posts returns.
  items: Post[];
  nextCursor?: string;
}

export const sources = {
  get: (id: string, cursor?: string) =>
    request<SourceSurfaceResponse>(
      `/sources/${id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
};
