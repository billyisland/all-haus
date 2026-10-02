// =============================================================================
// Nostr Types & Constants
//
// Plain TypeScript types and kind constants for Nostr events used across the
// web client. No relay connection or NDK dependency — all relay communication
// goes through the gateway API.
// =============================================================================

// Nostr event kind constants
export const KIND_ARTICLE = 30023;
export const KIND_NOTE = 1;
export const KIND_DELETION = 5;

// =============================================================================
// App-level event interfaces
// =============================================================================

export type PipStatus = "known" | "partial" | "unknown" | "contested";

export type SizeTier = "lead" | "standard" | "brief";

export interface ArticleEvent {
  type?: "article";
  id: string;
  feedItemId?: string;
  // UNIVERSAL-POST-ADR §2.3 deterministic post_id — the key GET /thread/:postId
  // resolves. Surfaced by the gateway workspace payload (feeds.ts rowToItem);
  // the PostCard adapter sets Post.id from it so the thread engine can fetch.
  postId?: string;
  authorId?: string;
  pubkey: string;
  dTag: string;
  title: string;
  summary: string;
  content: string;
  publishedAt: number;
  tags: string[][];
  topicTags?: string[];
  pricePence?: number;
  gatePositionPct?: number;
  isPaywalled?: boolean;
  encryptedPayload?: string;
  payloadAlgorithm?: string;
  pipStatus?: PipStatus;
  sizeTier?: SizeTier;
  isReply?: boolean;
  biddabilityTier?: "A" | "B" | "C" | "D";
  // Slice 20: present in the saved-items view, absent in the live view.
  savedAt?: number;
  // Slice 23b: cover image, served as feed_items.media shape so the
  // workspace MediaBlock consumes it without translation.
  media?: Array<{
    type: "image" | "video" | "audio" | "link";
    url: string;
    thumbnail?: string;
    alt?: string;
    width?: number;
    height?: number;
    title?: string;
    description?: string;
  }>;
}

export interface NoteEvent {
  type: "note";
  id: string;
  feedItemId?: string;
  postId?: string; // §2.3 post_id — see ArticleEvent

  authorId?: string;
  pubkey: string;
  content: string;
  publishedAt: number;
  quotedEventId?: string;
  quotedEventKind?: number;
  quotedExcerpt?: string;
  quotedTitle?: string;
  quotedAuthor?: string;
  quotedPostId?: string;
  quotedUrl?: string;
  quotedSource?: string;
  pipStatus?: PipStatus;
  isReply?: boolean;
  replyToAuthor?: string;
  biddabilityTier?: "A" | "B" | "C" | "D";
  savedAt?: number;
  externalParentId?: string;
  // Event kind of this item. Defaults to 1 (kind-1 note). Reply/comment cards
  // surfaced through NoteCard (e.g. the profile Replies section) pass 1111 so
  // vote/quote/delete use the correct comment semantics.
  kind?: number;
  // DB id for the comment-delete route (`DELETE /replies/:dbId`). Present only
  // when this NoteEvent represents a kind-1111 comment rather than a note.
  dbId?: string;
  // Native parent event id (article or note) — what a reply replies to.
  replyToEventId?: string;
}
