import type { Post } from "./types";

// Public web permalink for an external post's origin, derived from its stable
// origin URI. atproto `at://` URIs are rewritten to their bsky.app web URL
// (mirrors PostOriginTag / VesselCard's atprotoWebUri); http(s) permalinks
// (activitypub status URLs, rss links) pass through; external-Nostr bech32
// entities resolve through njump.me; anything else (malformed) yields null.
// Used for the origin tag's link-out and to embed a clickable reference when
// quoting an external post (migration 102).
export function originWebUrl(post: Post): string | null {
  // The ingester's own answer wins where it has one. `origin.uri` is the
  // item's stable IDENTITY, and for RSS that is `guid ?? link` — a guid being
  // under no obligation to be a URL — so deriving from it can only ever be a
  // fallback. It is a good one: it is exactly right for atproto, nostr and
  // activitypub, and for the majority of RSS feeds whose guid IS the link,
  // which is what keeps every row ingested before the column was carried
  // working unchanged.
  const canonical = post.origin.webUrl;
  if (canonical && /^https?:\/\//.test(canonical)) return canonical;

  const uri = post.origin.uri;
  if (!uri) return null;
  const at = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (at) return `https://bsky.app/profile/${at[1]}/post/${at[2]}`;
  if (/^https?:\/\//.test(uri)) return uri;
  // External-Nostr items carry a bech32 nevent/naddr/note as their stable URI
  // (relay-free, per the identity invariant) — njump.me renders any of them.
  // Native posts hold a raw hex event id here and deliberately don't match:
  // all.haus content links to all.haus, never out.
  if (/^(nevent1|naddr1|note1)[02-9ac-hj-np-z]+$/.test(uri)) {
    return `https://njump.me/${uri}`;
  }
  return null;
}
