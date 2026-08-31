// Shared helpers, constants and row/interface types for the external-items
// route modules (engagement / parent / quote / thread / interactions) and the
// background thread-hydration lib (external-hydration.ts). Anything used across
// that route/lib boundary — or by ≥2 route modules — lives here so the
// external-items split stays a pure move with no behaviour change.

export const APPVIEW = "https://public.api.bsky.app";

// All four route caches (engagement/parent/quote/thread) use a TTL but never
// sweep, so over a long-lived process their keyspace grows monotonically: the
// thread cache key embeds the attacker-controlled `focus` param (a distinct
// entry per value), and the id-keyed caches accumulate one permanent entry per
// external item ever viewed. `setCapped` bounds every cache to
// CACHE_MAX_ENTRIES, sweeping expired entries first and then evicting oldest
// insertions (Map iterates insertion order).
export const CACHE_MAX_ENTRIES = 1000;

export function setCapped<V extends { expiresAt: number }>(
  cache: Map<string, V>,
  key: string,
  value: V,
): void {
  cache.set(key, value);
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES) break;
    if (v.expiresAt <= now) cache.delete(k);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Outbound source fetches for the essential neighbourhood data (parent, quote,
// thread) cap at 8s per CARD-BEHAVIOUR-ADR §VII.3 — tighter than the shared
// client's 10s default so a slow source platform can't hold a hydration request
// open, but with enough headroom for a cold fetch (every call builds a fresh
// SSRF-pinned agent, so each pays a full DNS+TLS handshake with no pooling).
export const NEIGHBOURHOOD_FETCH_TIMEOUT_MS = 8_000;

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

export interface ExternalItemRow {
  id: string;
  source_id: string;
  protocol: string;
  source_item_uri: string;
  source_reply_uri: string | null;
  source_quote_uri?: string | null;
  like_count: number;
  reply_count: number;
  repost_count: number;
  interaction_data: Record<string, unknown>;
}

export interface QuoteMedia {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

export interface BlueskyThreadViewPost {
  $type?: string;
  post: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record: {
      text?: string;
      createdAt?: string;
      reply?: { parent: { uri: string }; root: { uri: string } };
    };
    // Hydrated view embed (#view) — carries full CDN media URLs. Only read when
    // building the rich focus node (extractBlueskyViewMedia).
    embed?: unknown;
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
  };
  parent?: BlueskyThreadViewPost | { $type: string };
  replies?: Array<BlueskyThreadViewPost | { $type: string }>;
}

export function isThreadViewPost(
  node: BlueskyThreadViewPost | { $type: string },
): node is BlueskyThreadViewPost {
  return (
    !("$type" in node) || node.$type === "app.bsky.feed.defs#threadViewPost"
  );
}

export interface MastodonStatus {
  id: string;
  url: string;
  uri: string;
  content: string;
  created_at: string;
  account: {
    acct: string;
    display_name: string;
    url: string;
    uri?: string; // ActivityPub actor id — the canonical author_uri
  };
  favourites_count?: number;
  replies_count?: number;
  reblogs_count?: number;
  in_reply_to_id: string | null;
}

// Bluesky hydrated (#view) embeds carry full CDN URLs already. Extract media
// from the quoted post's own embed; recordWithMedia carries media alongside the
// nested record, which we deliberately do not recurse into (no quote-of-quote).
export function extractBlueskyViewMedia(embed: unknown): QuoteMedia[] {
  const out: QuoteMedia[] = [];
  const handle = (v: any) => {
    const t: string | undefined = v?.$type;
    if (!t) return;
    if (t.startsWith("app.bsky.embed.images") && Array.isArray(v.images)) {
      for (const img of v.images) {
        if (img.fullsize)
          out.push({
            type: "image",
            url: img.fullsize,
            thumbnail: img.thumb,
            alt: img.alt || undefined,
          });
      }
    } else if (t.startsWith("app.bsky.embed.external") && v.external?.uri) {
      out.push({
        type: "link",
        url: v.external.uri,
        thumbnail: v.external.thumb,
        title: v.external.title || undefined,
        description: v.external.description || undefined,
      });
    } else if (t.startsWith("app.bsky.embed.video") && v.playlist) {
      out.push({ type: "video", url: v.playlist, thumbnail: v.thumbnail });
    }
  };
  const e = embed as any;
  if (e?.$type?.startsWith("app.bsky.embed.recordWithMedia") && e.media) {
    handle(e.media);
  } else {
    handle(e);
  }
  return out;
}

// Pull the quoted post's at:// URI out of a Bluesky hydrated (#view) embed.
// record#view nests the quoted post at e.record.uri; recordWithMedia#view wraps
// a record#view at e.record.record.uri. (recordWithMedia is checked first — its
// $type also starts with "app.bsky.embed.record".) Mirrors the adapter's
// ingest-time extraction so a quote learned via thread hydration keys the same
// source_quote_uri the quote tile resolves from. Detached/blocked/not-found
// quoted records still carry a uri; the quote endpoint resolves it best-effort.
export function extractBlueskyViewQuoteUri(embed: unknown): string | null {
  const e = embed as any;
  const t: string | undefined = e?.$type;
  if (!t) return null;
  if (t.startsWith("app.bsky.embed.recordWithMedia")) {
    const uri = e.record?.record?.uri;
    return typeof uri === "string" ? uri : null;
  }
  if (t.startsWith("app.bsky.embed.record")) {
    const uri = e.record?.uri;
    return typeof uri === "string" ? uri : null;
  }
  return null;
}

export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

export function rowToParentItem(row: any): ParentItem {
  return {
    id: row.id,
    sourceProtocol: row.protocol,
    sourceItemUri: row.source_item_uri,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    authorAvatarUrl: row.author_avatar_url,
    authorUri: row.author_uri,
    contentText: row.content_text,
    contentHtml: row.content_html,
    title: row.title,
    summary: row.summary,
    likeCount: row.like_count ?? 0,
    replyCount: row.reply_count ?? 0,
    repostCount: row.repost_count ?? 0,
    media: row.media ?? [],
    publishedAt: Number(row.published_at_epoch),
    sourceReplyUri: row.source_reply_uri,
  };
}

export function extractMastodonStatusId(uri: string): string | null {
  try {
    const parts = new URL(uri).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}
