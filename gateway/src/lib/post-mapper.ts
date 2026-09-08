// =============================================================================
// Shared Post model — UNIVERSAL-POST-ADR §2.2
//
// The single Post shape every unified read endpoint emits (the /feed slice in
// routes/post-feed.ts, the /thread slice in routes/post-thread.ts, and Phase 2's
// PostCard consumer). Extracted here so both endpoints share one mapper and one
// type — no duplicated §2.2 projection.
//
// `feedItemToPost` maps a feed_items-sourced row (article / note / external THING).
// Comment-sourced nodes (native replies, which live in the `comments` table, not
// feed_items) are projected separately in post-thread.ts::commentToPost, but emit
// this same Post type.
//
// POST_SELECT / POST_JOINS are the Post-bearing columns + joins layered on top of
// feed-sql.ts's FEED_SELECT / FEED_JOINS. They carry NO feed-only scoring machinery
// (the §5 score_live expression + the repost_edges boost join stay in post-feed.ts);
// the mapper tolerates their absence (boost_count defaults to 0).
// =============================================================================

import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";

export interface PostAuthor {
  id: string | null; // identity record (native author_id / external_author_id). NULL = tier C/D plain-text byline
  accountId: string | null; // lazy link to a real all.haus account
  displayName: string | null;
  handle: string | null;
  handleUri: string | null; // link to profile on origin (external)
  // No avatar. A card body carries no pfp (web/CLAUDE.md › Feed card chassis:
  // left bar + pip + mono-caps name carry identity), and the hover card fetches
  // its own from /author-card — so the three avatar columns this used to select
  // (accounts, external_authors, external_items) reached no renderer at all.
  // Re-adding one here is not how a card gets a picture.
  pubkey: string | null; // native only
  pipStatus: "known" | "partial" | "unknown" | "contested";
}

export interface PostOrigin {
  protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email" | string;
  uri: string;
  sourceName: string | null;
  // The container the reader subscribed to where that is NOT the author
  // (BYLINE-AND-PROVENANCE-ADR D8): a native article's publication. NULL for
  // a native article outside a publication (the byline already is the
  // source), for every note and comment, and for external rows, whose
  // container is `sourceName`. The two are the same slot on the card.
  // `active` mirrors publications.status = 'active' — the only state in which
  // /pub/:slug resolves (publications/public.ts 404s otherwise). The card
  // renders the name either way ("published in X" stays true after X is
  // archived) and links it only while it is active.
  publication: { name: string; slug: string; active: boolean } | null;
}

export interface PostBody {
  text: string | null;
  html: string | null;
  title: string | null;
  summary: string | null;
  media: unknown[];
  contentWarning: string | null;
  poll: unknown | null;
}

export interface Post {
  id: string; // deterministic post_id (§2.3)
  version: string | null; // edit detector (§2.4)
  origin: PostOrigin;
  author: PostAuthor;
  type: "article" | "note";
  accessMode: "free" | "gated";
  // ARTICLE-HEADED-CONVERSATIONS-ADR D5. "The article this conversation hangs
  // off is paywalled AND THIS VIEWER cannot read it" — a different question
  // from `accessMode`, which carries no viewer term (see :201) and so says
  // `gated` on a paying reader's card too.
  //
  // OPTIONAL, and absent is not `false`. Only the two routes that already know
  // the viewer stamp it — the thread projector and the profile's Replies log —
  // so on every other surface an absent field reads as "nobody asked this
  // question about this post", which is the truth. `feedItemToPost` takes no
  // viewer and must not learn to; a required boolean here is exactly what would
  // force it to. Readers key on `=== true`, never on falsiness.
  rootLocked?: boolean;
  body: PostBody;
  inReplyTo: string | null; // parent post_id
  quotes: string | null; // quoted post_id (depth-1)
  // Inline preview of a native note's quoted post (title/excerpt/author), carried
  // from the notes.quoted_* columns so the thread renders the rich quote card
  // rather than a bare "Quoted a post →" stub. External quotes hydrate async via
  // the host item id, so they leave this undefined.
  quotedPreview?: { title?: string; excerpt?: string; author?: string; source?: string; url?: string };
  originCounts: { like: number; reply: number; repost: number } | null; // external only; null native (§6)
  scoresheet: { up: number; down: number; reposts: number };
  biddabilityTier: "A" | "B" | "C" | "D";
  publishedAt: number;
  score?: number; // §5 hotness (feed only); undefined in thread
  isContextOnly: boolean;
  isDeleted: boolean;
  isMuted: boolean;
  feedItemId: string | null; // legacy id, transitional
  externalItemId: string | null; // external_items uuid — the origin interact-back key (like/repost/reply); null native
  // Reader/workspace fields, sourced here (formerly client-transitional in the browser
  // Post adapter): a native article's d-tag (reader-pane open key /article/<dTag>), the
  // gated-article CTA price, and the all.haus external_sources id the workspace uses to
  // match a card to its feed_source. Optional — only the article/external branches set them.
  dTag?: string | null;
  pricePence?: number;
  externalSourceId?: string | null;
  // Slice 8 P1: cross-source provenance — the other linked sources' protocols
  // carrying the same content as this (winning) card. Only the source-filtered
  // workspace feed emits it (the dedup query); other read paths leave it undefined.
  alsoOn?: string[];
  // SOCIAL-PROOF-RESONANCE-ADR D7: 0-3 band driving the byline glyph, or null
  // for "no band computed" — NOT "quiet". Absence is the ADR's own semantics
  // (rss/email, dark nostr, and any row the crons haven't scored yet); the
  // client renders nothing for null AND for band 0, but they are not the same
  // claim, so don't collapse them in the mapper.
  resonanceBand?: number | null;
  // D5 platform axis, 0..1 — E's position in its OWN network's distribution.
  // Its two landmarks are the scorer's, not new ones: PCTL_EXPR is built so
  // 0.5 is exactly the network median (p50_e) and 0.9 exactly p90_e, which are
  // the same cuts the band's own ambient test uses. So the tooltip can name a
  // platform level without inventing a threshold to tune. Same null semantics
  // and the same brake as the band.
  ambientPctl?: number | null;
}

export interface RepostEdgeDTO {
  targetPostId: string;
  actorId: string | null;
  actorHandle: string | null;
  actorDisplayName: string | null;
  trustWeight: number;
  timestamp: number;
  originUri: string | null;
}

// ── Post-bearing columns layered on top of feed-sql.ts's FEED_SELECT ─────────
// post_id/version/biddability_tier/external_author_id are the Phase 0a/0b columns.
// The derive_post_id() calls resolve a reply/quote parent to ITS deterministic
// post_id (§2.3, the same SQL function migration 098 uses) so each Post carries
// real inReplyTo/quotes edges that GET /thread can resolve.
//
// Article-target resolution — THE ONE HOME for "a native event id, resolved to
// the post_id it actually names". Three questions turn out to be one: a kind-1
// note's `reply_to_event_id`, its `quoted_event_id`, and a comment's
// `target_event_id` on GET /author/:authorId/replies.
//
// THE PROBLEM. A native article's post_id is minted from its naddr COORDINATE
// ('30023:<pubkey>:<dtag>', migration 098), while everything that points AT an
// article stores its raw EVENT id. Deriving straight from the event id mints a
// post_id that matches no THING — a dangling edge, an orphaned thread node.
// A note target is the opposite: its post_id IS derived from its event id, so
// falling through is exactly right there.
//
// IT READS THE post_id; IT DOES NOT RE-DERIVE THE COORD. This used to rebuild
// '30023:' || pubkey || ':' || dtag itself, which is the thing
// `article_post_id`'s own comment forbids in as many words: post_id is minted
// ONCE and the mint's native branch has a fallback ('nostr_article' || id, for
// an article whose writer/d-tag the trigger could not see), so a re-derivation
// mints an id matching no row in precisely the case the fallback exists for.
// Re-deriving also has the wrong shape for the failure — it produced a
// *plausible* 64-hex string rather than nothing, so the gap was invisible.
// `article_post_id(uuid)` is the one home (READING-LOG-AND-LIBRARY-ADR D7): it
// READS feed_items.post_id and derives, with the full fallback, only where no
// row exists. Both legs are indexed — `articles_nostr_event_id_key` unique,
// then `idx_feed_items_article` unique.
//
// Read-side only — repairs existing rows with no migration / re-ingest.
export const nostrTargetPostId = (col: string) => `COALESCE(
    (SELECT article_post_id(art2.id)
       FROM articles art2
      WHERE art2.nostr_event_id = ${col}),
    feed_items_derive_post_id('nostr', ${col}))`;

// Leading comma: appended directly after FEED_SELECT in `SELECT ${FEED_SELECT}${POST_SELECT}`.
export const POST_SELECT = `,
  fi.post_id AS post_id, fi.version AS version,
  fi.biddability_tier AS biddability_tier_persisted,
  fi.external_author_id AS external_author_id,
  acc.display_name AS acc_display_name, acc.username AS acc_username,
  xa.account_id AS xa_account_id, xa.display_name AS xa_display_name,
  xa.handle AS xa_handle, xa.handle_uri AS xa_handle_uri,
  vt.upvote_count AS vt_up, vt.downvote_count AS vt_down,
  CASE
    WHEN n.reply_to_event_id IS NOT NULL THEN ${nostrTargetPostId("n.reply_to_event_id")}
    WHEN ei.source_reply_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_reply_uri)
  END AS in_reply_to_post_id,
  CASE
    WHEN n.quoted_event_id IS NOT NULL THEN ${nostrTargetPostId("n.quoted_event_id")}
    WHEN n.quoted_post_id IS NOT NULL THEN n.quoted_post_id
    WHEN ei.source_quote_uri IS NOT NULL THEN feed_items_derive_post_id(fi.source_protocol::text, ei.source_quote_uri)
  END AS quotes_post_id`;

// Joins that back POST_SELECT (external author identity + native vote tallies).
// The feed-only repost_edges boost join is NOT here — it lives in post-feed.ts.
export const POST_JOINS = `
  LEFT JOIN external_authors xa ON xa.id = fi.external_author_id
  LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = fi.nostr_event_id`;

// Operator brake for the D7 resonance glyph (step 4). Default ON since
// 2026-08-10 (docker-compose defaults RESONANCE_GLYPH_ENABLED=1): the closed
// beta inverted the old hold-dark gate — the operator browsing real posts IS
// the prod measurement, and the band gates are platform_config dials, so a
// wrong distribution is an UPDATE rather than a deploy. Revisit the default
// the day the beta opens (CONSOLIDATED-TODO §9.12). Gating HERE — the one
// mapper every read path shares — means the band never leaves the gateway
// while it is off, so there is no client-side flag to keep in sync. Set
// RESONANCE_GLYPH_ENABLED=0 in the root .env to douse it; the scoring crons
// are unaffected either way.
export function resonanceGlyphEnabled(): boolean {
  const v = process.env.RESONANCE_GLYPH_ENABLED;
  return v === "1" || v === "true";
}

// =============================================================================
// Post mapper (§2.2). Emits the unified Post shape Phase 2's PostCard consumes.
// Fields without a cheap source yet are nulled/zeroed with intent.
// =============================================================================
export function feedItemToPost(row: any): Post {
  const isNative = row.item_type === "article" || row.item_type === "note";
  const isExternal = row.item_type === "external";

  // type discriminator: external long-form (has a title) → article, else note.
  // Provisional — drives the §3.1 reader-pane routing built in Phase R/2.
  const type: "article" | "note" = isExternal
    ? row.ei_title
      ? "article"
      : "note"
    : (row.item_type as "article" | "note");

  const accessMode: "free" | "gated" =
    row.item_type === "article" && row.access_mode === "paywalled"
      ? "gated"
      : "free";

  const author: PostAuthor = isNative
    ? {
        id: row.author_id ?? null,
        accountId: row.author_id ?? null,
        displayName: row.acc_display_name ?? null,
        handle: row.acc_username ?? null,
        handleUri: null, // native profile is internal (/username); no origin link
        pubkey: row.nostr_pubkey ?? null,
        pipStatus: row.pip_status ?? "unknown",
      }
    : {
        id: row.external_author_id ?? null, // null for tier D (no byline row)
        accountId: row.xa_account_id ?? null,
        // `|| null`, not `??`: the email adapter (normaliseEmail) yields "" for
        // a sender with no display name (and "" for the handle when there is
        // no From at all), and `??` passes "" straight through — the trigger's
        // tier-C mint NULLIFs the same string and never mints for it, so the
        // card would carry no record, `namesSomeone` would still be true via
        // the handle, and ExternalByline's `displayName ?? handle` would render
        // an EMPTY name. An empty string is an absent name here, as in the DB.
        displayName: row.xa_display_name ?? (row.ei_author_name || null),
        handle: row.xa_handle ?? (row.ei_author_handle || null),
        handleUri: row.xa_handle_uri ?? row.ei_author_uri ?? null,
        pubkey: null,
        pipStatus: "unknown",
      };

  const origin: PostOrigin = isNative
    ? {
        protocol: "nostr",
        uri: row.nostr_event_id ?? "",
        sourceName: null,
        // pub_name/pub_slug come off FEED_JOINS' publications join, keyed on
        // articles.publication_id — so they are already NULL on every row
        // that is not an article in a publication. Darked with the publications
        // suspension HERE, the mapper every card path shares (same choke point
        // as resonanceBand below): while the flag is off every /pub route 404s,
        // so an embed that left the gateway would render a live VIA link into
        // a dead surface.
        publication:
          publicationsEnabled() && row.pub_slug && row.pub_name
            ? {
                name: row.pub_name,
                slug: row.pub_slug,
                active: row.pub_status === "active",
              }
            : null,
      }
    : {
        protocol: row.source_protocol,
        uri: row.source_item_uri ?? "",
        // The source name is a fact about the SUBSCRIPTION, not about this post,
        // and the two only coincide while the row's source_id is its author's own.
        // A context-only row is anchored on the hydrating focal's source, so a
        // thread parent/child would otherwise be tagged with the display name of
        // the account whose card was expanded ("VIA FEDIVERSE · Kaito · oli") —
        // a byline-shaped falsehood in the one slot that claims provenance.
        // (The byline used to fall back to this field for an author-less row —
        // the same misattribution one level up; BYLINE-AND-PROVENANCE-ADR D9
        // removed that arm, so a card with no author now has no byline at all
        // and the source's name appears only in the slot that is about it.)
        sourceName: row.ei_is_context_only
          ? null
          : row.source_display_name ?? null,
        publication: null,
      };

  const body: PostBody = isNative
    ? row.item_type === "article"
      ? {
          // LOAD-BEARING: `content_free` is what sits ABOVE the gate, so a
          // native article Post has never carried the paywalled body and a
          // thread containing a gated article is safe to render by
          // construction. ARTICLE-HEADED-CONVERSATIONS-ADR D4 rests entirely on
          // this line and adds no redaction step of its own — widen this to the
          // full body and a locked conversation silently leaks the piece.
          text: row.content_free ?? null,
          html: null,
          title: row.title ?? null,
          summary: row.a_summary ?? null,
          media: row.media ?? [],
          contentWarning: null,
          poll: null,
        }
      : {
          text: row.note_content ?? null,
          html: null,
          title: null,
          summary: null,
          media: row.media ?? [],
          contentWarning: null,
          poll: null,
        }
    : {
        text: row.ei_content_text ?? null,
        html: row.ei_content_html ?? null,
        title: row.ei_title ?? null,
        summary: row.ei_summary ?? null,
        media: row.media ?? [],
        contentWarning: row.ei_content_warning ?? null,
        poll: row.ei_interaction_data?.poll ?? null,
      };

  return {
    id: row.post_id,
    version: row.version ?? null,
    origin,
    author,
    type,
    accessMode,
    body,
    inReplyTo: row.in_reply_to_post_id ?? null,
    quotes: row.quotes_post_id ?? null,
    // Native note quote preview from the notes.quoted_* columns (FEED_SELECT
    // already carries them). Mirrors the workspace adapter's mapNote so the same
    // quoted note reads identically in the feed and in an expanded thread.
    quotedPreview:
      !isExternal && (row.quoted_event_id || row.quoted_post_id)
        ? {
            title: row.quoted_title ?? undefined,
            excerpt: row.quoted_excerpt ?? undefined,
            author: row.quoted_author ?? undefined,
            // External quote (migration 102): origin label + clickable permalink.
            source: row.quoted_source ?? undefined,
            url: row.quoted_url ?? undefined,
          }
        : undefined,
    // §6: native counts come from the canonical scoresheet (originCounts null);
    // external carry the origin platform's tallies.
    originCounts: isExternal
      ? {
          like: row.ei_like_count ?? 0,
          reply: row.ei_reply_count ?? 0,
          repost: row.ei_repost_count ?? 0,
        }
      : null,
    scoresheet: {
      up: row.vt_up ?? 0,
      down: row.vt_down ?? 0,
      reposts: Number(row.boost_count) || 0,
    },
    biddabilityTier: row.biddability_tier_persisted ?? "D",
    publishedAt: Number(row.published_at_epoch),
    score: row.score_live != null ? Number(row.score_live) : undefined,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    // legacy id retained transitionally for clients still keyed on feed_items.id
    feedItemId: row.fi_id ?? null,
    // external interact-back key: like/repost/reply dispatch to the origin via the
    // external_items row (FEED_SELECT carries fi.external_item_id). Null for native —
    // native engagement is the all.haus scoresheet, not an origin interact-back.
    externalItemId: isExternal ? (row.external_item_id ?? null) : null,
    // Native article reader-pane key + gated CTA price (FEED_SELECT carries a.nostr_d_tag,
    // a.price_pence). external_sources id for the workspace source-match (fi.source_id).
    dTag: row.item_type === "article" ? (row.nostr_d_tag ?? null) : null,
    pricePence: row.price_pence != null ? Number(row.price_pence) : undefined,
    externalSourceId: isExternal ? (row.source_id ?? null) : null,
    // Slice 8 P1: the dedup query's provenance lateral emits also_on (a protocol
    // array) only on survivors of a linked duplicate pair; absent elsewhere.
    alsoOn: row.also_on ?? undefined,
    // D7 band, withheld entirely while the brake is off (see resonanceGlyphEnabled).
    // `?? null` keeps absence explicit rather than dropping the key.
    resonanceBand: resonanceGlyphEnabled() ? (row.resonance_band ?? null) : null,
    // Same brake, same absence semantics. `ambient_pctl` is a Postgres NUMERIC,
    // which node-pg hands back as a STRING — pass it through untouched and the
    // client compares "0.95" < 0.9 lexically and silently mis-glosses. Number()
    // only past the null check, so absence survives as absence.
    ambientPctl:
      resonanceGlyphEnabled() && row.ambient_pctl != null
        ? Number(row.ambient_pctl)
        : null,
  };
}

// =============================================================================
// Native comment → Post (§2.2). Comments aren't in feed_items, so they're
// projected here (not by feedItemToPost), emitting the same Post type. Shared by
// the /thread projector (post-thread.ts) and the author replies log (author.ts).
// =============================================================================
export interface CommentRow {
  id: string; // comment uuid
  derived_post_id: string;
  nostr_event_id: string;
  parent_comment_id: string | null;
  parent_post_id: string | null; // parent comment's derived post_id, NULL for top-level
  content: string;
  published_at_epoch: number;
  deleted_at: Date | null;
  author_id: string;
  acc_display_name: string | null;
  acc_username: string | null;
  nostr_pubkey: string | null;
  pip_status: Post["author"]["pipStatus"] | null;
  vt_up: number | null;
  vt_down: number | null;
}

export function commentToPost(
  c: CommentRow,
  rootPostId: string,
  mutedIds: Set<string>,
  // The comment's ROOT is paywalled and this viewer cannot read it (D5). Passed
  // by the two callers that have resolved access — the thread projector and
  // GET /author/:authorId/replies — and left undefined by anyone who has not
  // asked the question. Never `false` by default: absent and false are
  // different facts here.
  rootLocked?: boolean,
): Post {
  return {
    id: c.derived_post_id,
    version: c.nostr_event_id, // native immutable event token (§2.4)
    origin: {
      protocol: "nostr",
      uri: c.nostr_event_id,
      sourceName: null,
      publication: null,
    },
    author: {
      id: c.author_id,
      accountId: c.author_id,
      displayName: c.acc_display_name,
      handle: c.acc_username,
      handleUri: null,
      pubkey: c.nostr_pubkey,
      pipStatus: c.pip_status ?? "unknown",
    },
    type: "note",
    // The comment ITSELF is free — this is a fact about the comment and stays
    // true however locked its root is. The locked-ness of the conversation it
    // sits in is `rootLocked` below, deliberately a separate field: overloading
    // `accessMode` would put two questions under one name, and one of them has
    // a viewer term while the other does not (D5).
    accessMode: "free",
    ...(rootLocked ? { rootLocked: true } : {}),
    body: {
      text: c.deleted_at ? "[deleted]" : c.content,
      html: null,
      title: null,
      summary: null,
      media: [],
      contentWarning: null, // comments carry no content warning
      poll: null,
    },
    // top-level comments hang off the root THING; nested off their parent comment.
    inReplyTo: c.parent_post_id ?? rootPostId,
    quotes: null,
    originCounts: null, // native (§6): all.haus scoresheet is canonical
    scoresheet: { up: c.vt_up ?? 0, down: c.vt_down ?? 0, reposts: 0 },
    biddabilityTier: "A",
    publishedAt: Number(c.published_at_epoch),
    isContextOnly: false,
    isDeleted: !!c.deleted_at,
    isMuted: mutedIds.has(c.author_id),
    feedItemId: null,
    externalItemId: null, // native comment — engagement is the all.haus scoresheet
    // Comments live in `comments`, not feed_items, so they are outside the
    // resonance corpus entirely — no band exists to render (D7 shows the glyph
    // at feed/focal levels anyway, and a comment is neither).
    resonanceBand: null,
    ambientPctl: null,
  };
}
