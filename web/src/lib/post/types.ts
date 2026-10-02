// =============================================================================
// Client Post model — UNIVERSAL-POST-ADR §2.2
//
// The browser mirror of the gateway Post shape (gateway/src/lib/post-mapper.ts).
// Kept structurally identical so the same PostCard renders every feed payload with
// no re-mapping. All feed surfaces — sources, author, tags, thread, AND the
// workspace items endpoint (GET /workspace/feeds/:id/items) — now serve gateway
// Post[] directly; the client-side legacy-item adapter (map-feed-item.ts) was
// retired in FEED-RETIREMENT-PLAN Slice 6 item 4.
//
// A few fields are still marked "client transitional" (render-only ergonomics);
// the gateway now sources dTag/pricePence/externalSourceId too.
// =============================================================================

// The seven render levels (§3 / §4 matrix). The level governs size/indent/gap/
// affordance-set — never which fields exist; every Post always carries everything.
// `preview` is the queue's compact rows (WORKSPACE-QUEUE-ADR §VII.5) — named
// so it does not collide with `Density`'s unrelated 'compact' (D2).
export type Level =
  | "focal"
  | "feed"
  | "thread-parent"
  | "thread-reply"
  | "quoted"
  | "condensed"
  | "preview";

export type BiddabilityTier = "A" | "B" | "C" | "D";

export type PipStatus = "known" | "partial" | "unknown" | "contested";

// Media shape as served by feed_items.media (matches the ndk MediaItem the
// workspace MediaBlock already consumes without translation).
export interface MediaItem {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
  duration_in_seconds?: number;
  size_in_bytes?: number;
}

// Poll shape as carried by external items (PollDisplay-compatible).
export interface Poll {
  options: Array<{ title: string; votesCount: number }>;
  multiple: boolean;
  expiresAt: string | null;
  closed: boolean;
}

export interface PostOrigin {
  // "nostr" for native all.haus content; the source protocol otherwise.
  protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email" | string;
  uri: string; // permalink / at:// / status id / event id — the stable handle
  // The item's public web PERMALINK where the ingester knew one — a DIFFERENT
  // thing from `uri`, which is its stable identity. They coincide for
  // atproto/activitypub/nostr and for RSS feeds whose guid happens to be a
  // link; they do not for a feed whose guid is a `urn:uuid:`, a `tag:` or a
  // bare integer. Optional so historical payloads typecheck; read it through
  // `originWebUrl`, never directly.
  webUrl?: string | null;
  sourceName: string | null; // origin-site name shown in the tag
  // The container the reader subscribed to where that is not the author
  // (BYLINE-AND-PROVENANCE-ADR D8): a native article's publication, rendered
  // in the same provenance slot an external card gives `sourceName`. Null
  // for a native article outside a publication, every note, and external.
  // `active` is publications.status = 'active' — the only state /pub/:slug
  // resolves in; the name renders regardless, the link only while active.
  publication: { name: string; slug: string; active: boolean } | null;
  // Whether `/source/:id` will serve `externalSourceId`: the gateway's own two
  // conditions (a public protocol, an active row), so a private email
  // newsletter's card does not link to a 404. Read it through `sourcePageId`.
  sourceBrowsable?: boolean;
  // An external NOSTR item's own event id and author pubkey (hex), so a quote
  // of it can carry a real NIP-18 `q` tag to the relays it lives on (CA-I13).
  // Absent for every other protocol and for native content, whose quote uses
  // `version` and `author.pubkey`.
  nostrEvent?: { id: string; pubkey: string } | null;
}

export interface PostAuthor {
  // Identity record id (native author_id / external_author_id). NULL for tier
  // C/D — no stable handle ⇒ no profile ⇒ plain-text byline.
  id: string | null;
  // The all.haus member this identity belongs to. External: the member who
  // linked the account, present ONLY where they consented to showing it
  // (CROSS-NETWORK-ROUNDTRIP-ADR D1) — so its absence says nothing.
  accountId: string | null;
  // External only: that member's handle, the byline's link to them.
  memberUsername?: string | null;
  displayName: string | null; // native: accounts.display_name (NULL if the member set none)
  handle: string | null;
  handleUri: string | null; // link to profile on origin (external)
  // No avatar — a card body carries no pfp (CLAUDE.md › Feed card chassis);
  // the hover card (AuthorModal) fetches its own from /author-card.
  pubkey: string | null; // native only — the NIP-10 p tag + vote target
  pipStatus: PipStatus;
}

export interface PostBody {
  text: string | null;
  html: string | null;
  title: string | null; // articles
  summary: string | null;
  media: MediaItem[];
  contentWarning: string | null;
  poll: Poll | null;
}

export interface Post {
  id: string; // deterministic post_id (§2.3); client-side = origin handle until the unified endpoint lands
  version: string | null; // edit detector (§2.4); native = nostr event id (also the vote target)
  origin: PostOrigin;
  author: PostAuthor;
  type: "article" | "note";
  // Display discriminator only — gating economics stay in the gate-pass service (§3.1).
  // It carries NO VIEWER TERM (the gateway derives it from access_mode alone),
  // so a paying reader's article card says `gated` too. Never key an affordance
  // on it; that is what `rootLocked` below is for.
  accessMode: "free" | "gated" | "unlocked";
  // ARTICLE-HEADED-CONVERSATIONS-ADR D5. "The article this conversation hangs
  // off is paywalled AND THIS VIEWER cannot read it." Stamped only by the two
  // routes that already know the viewer — GET /thread/:postId and
  // GET /author/:authorId/replies — so it is OPTIONAL and absent is NOT false:
  // absent means nobody asked this question about this post, which is the truth
  // on every feed, source surface and Articles log. Read it as `=== true`.
  // Its one reader is PostActions (D6): reply, quote and vote are SUPPRESSED,
  // not disabled, on a conversation you may read but may not join.
  rootLocked?: boolean;
  // NATIVE COMMENT NODES ONLY (gateway `commentToPost`), and its ABSENCE is
  // what tells a THING from a remark inside one: a comment is projected as
  // `type: "note"` with its own event id in `version`, so nothing else here
  // distinguishes the two. `replyTargetFromPost` is its one reader — a reply
  // is addressed to the conversation's ROOT and nests via `parentCommentId`,
  // and without this the card addressed it to the comment, which the gateway
  // refuses (400 `target_is_reply`). Absent on every article, note and
  // external post; read it as "is this a comment", never default it.
  conversation?: { rootEventId: string; rootKind: number; commentId: string };
  body: PostBody;
  inReplyTo: string | null; // parent handle (origin id this phase; gateway resolves to post_id)
  quotes: string | null; // quoted handle (depth-1)
  originCounts: { like: number; reply: number; repost: number } | null; // external only; null native (§6)
  scoresheet: { up: number; down: number; reposts: number }; // all.haus reaction layer
  biddabilityTier: BiddabilityTier;
  publishedAt: number; // unix seconds
  score?: number; // §5 hotness (feed only); undefined in thread
  isContextOnly: boolean;
  isDeleted: boolean;
  isMuted: boolean;
  feedItemId: string | null; // client transitional: keys vote/quote/parent fetches
  // client transitional: the external_item id the interact-back endpoints key on
  // (externalItems.like/repost/reply/pollVote, engagement). Distinct from `id`
  // (the deterministic post_id) and `feedItemId`. NULL for native posts.
  externalItemId: string | null;
  // The all.haus external_sources id this card came from (external only; null
  // native). The workspace matches a card to its feed_source row for drag-to-move.
  externalSourceId?: string | null;
  pricePence?: number; // client transitional: gated-article CTA price
  // client transitional: native article d-tag — the reader-pane (§3.1 / Phase R)
  // opens native articles at /article/<dTag>. Null for notes + external.
  dTag?: string | null;
  // client transitional: native note quote preview (the gateway model resolves
  // `quotes` to a child Post via /thread; until that is wired, the workspace
  // payload carries an inline excerpt we render as the quoted-level mini).
  // `source` + `url` are set when the quoted post is external (migration 102):
  // the origin label (e.g. "BLUESKY") and the clickable public permalink.
  quotedPreview?: { title?: string; excerpt?: string; author?: string; source?: string; url?: string };
  // Slice 8 P1: cross-source provenance. The other linked sources' protocols
  // carrying the same content as this (winning) card — rendered as a quiet
  // "ALSO ON BLUESKY · MASTODON" line. Empty/undefined ⇒ nothing rendered.
  alsoOn?: string[];
  // SOCIAL-PROOF-RESONANCE-ADR D7, the AUTHOR-relative axis: 0-3 band → the
  // byline glyph (nothing / ▴ / ▲). null/undefined means NO BAND WAS COMPUTED —
  // an rss/email or dark-nostr item, or one the crons haven't reached — which
  // is deliberately distinct from band 0 "quiet" even though both render
  // nothing. The gateway withholds it unless RESONANCE_GLYPH_ENABLED is set.
  resonanceBand?: number | null;
  // D5, the PLATFORM-relative axis: E's position in its own network's
  // distribution, 0..1, where 0.5 is exactly that network's median and 0.9 its
  // p90 (PCTL_EXPR is built on those two landmarks). Only the gloss reads it —
  // it never decides whether the glyph shows, which stays the author axis's
  // job. Same null semantics and brake as the band.
  ambientPctl?: number | null;
}

// Bare reposts are edges, not Posts (§2.2). Mirror of gateway RepostEdgeDTO.
export interface RepostEdge {
  targetPostId: string;
  actorId: string | null;
  actorHandle: string | null;
  actorDisplayName: string | null;
  trustWeight: number;
  timestamp: number;
  originUri: string | null;
}
