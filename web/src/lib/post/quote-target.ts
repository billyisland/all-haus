import type { Post } from "./types";
import type { QuoteTarget } from "../note-compose";
import { originWebUrl } from "./origin-url";
import { quotePreviewContent } from "./quote-preview";

// =============================================================================
// What quoting a post quotes — one home.
//
// Lifted out of the workspace's card handler so the plain-HTML register's
// Quote builds the same target from the same Post (web-modernhaus.md: logic is
// lifted, never re-implemented). The name cache is an ARGUMENT, as in
// `replyTargetFromPost`: a native Post carries no display name, and the
// workspace reads a warm client cache for it that a server has no access to.
// =============================================================================

// Friendly origin label shown on the quoted-mini when quoting an external post
// (mirrors PostOriginTag / SourceAttribution). Falls back to the source name,
// then the upper-cased protocol.
export const EXTERNAL_QUOTE_LABEL: Record<string, string> = {
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  rss: "RSS",
  email: "EMAIL",
};

/**
 * The quote target for a post.
 *
 * External (no nostr pubkey): quoted as a native note that references the
 * origin by post_id + public URL, rendering the same rich quoted-mini
 * (migration 102). Native: a NIP-18 quote of the post's event id (`version`).
 */
export function quoteTargetFromPost(p: Post): QuoteTarget {
  if (!p.author.pubkey) {
    return {
      eventId: "",
      eventKind: 1,
      authorPubkey: "",
      isExternal: true,
      quotedPostId: p.id,
      ...(p.origin.nostrEvent && { nostrEvent: p.origin.nostrEvent }),
      quotedUrl: originWebUrl(p) ?? undefined,
      quotedSource:
        p.origin.sourceName ??
        EXTERNAL_QUOTE_LABEL[p.origin.protocol] ??
        p.origin.protocol.toUpperCase(),
      previewTitle: p.body.title ?? undefined,
      previewContent: quotePreviewContent(p),
      previewAuthorName: p.author.displayName ?? p.author.handle ?? undefined,
    };
  }
  return {
    eventId: p.version ?? p.id,
    eventKind: p.type === "article" ? 30023 : 1,
    authorPubkey: p.author.pubkey,
    previewTitle: p.body.title ?? undefined,
    previewContent: quotePreviewContent(p),
    previewAuthorName: p.author.displayName ?? p.author.handle ?? undefined,
  };
}
