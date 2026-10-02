// =============================================================================
// Shared Post model — UNIVERSAL-POST-ADR §2.2
//
// The single Post shape every unified read endpoint emits — the workspace feed
// (routes/feeds/items.ts), the thread projector (routes/post-thread.ts), the
// author / source / tag surfaces and the reading log. Extracted here so they
// share one mapper and one type — no duplicated §2.2 projection. (The list used
// to name `routes/post-feed.ts`, the legacy reach-dial `GET /feed/:feedId`,
// which was deleted with the feed-derived-subscriptions change.)
//
// `feedItemToPost` maps a feed_items-sourced row (article / note / external THING
// — and, since migration 232, a native reply). The comment -> Post projection is
// `commentToPost` below and stays the ONE home for that shape: a comment now has
// a feed_items row (so it can reach a feed at all), but the row is only a
// CARRIER — `feedItemToPost` builds a CommentRow out of the joined columns and
// hands it straight over, so the thread projector, the profile's Replies log and
// the workspace feed all emit the same Post for the same reply. A second
// projection written inline here is how two surfaces come to disagree about
// which conversation a remark belongs to.
//
// POST_SELECT / POST_JOINS are the Post-bearing columns + joins layered on top of
// feed-sql.ts's FEED_SELECT / FEED_JOINS. They carry NO feed-only scoring
// machinery — the §5 `score_live` expression and the `repost_edges` boost join
// went with the legacy feed route — and the mapper tolerates their absence
// (boost_count defaults to 0).
// =============================================================================

import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
import { isPublicSourceProtocol } from "./public-source-protocols.js";
import {
  disclosedClaimantSql,
  disclosedClaimantUsernameSql,
} from "@platform-pub/shared/lib/presence-claim.js";

export interface PostAuthor {
  id: string | null; // identity record (native author_id / external_author_id). NULL = tier C/D plain-text byline
  // The all.haus member this identity belongs to — native: the author;
  // external: the member who linked the account, and ONLY where they have
  // consented to showing it (network_presences.show_on_profile; rung D).
  accountId: string | null;
  // External only: that member's handle, so the byline can link to them.
  memberUsername: string | null;
  displayName: string | null;
  handle: string | null;
  handleUri: string | null; // link to profile on origin (external)
  // No avatar. A card body carries no pfp — `.claude/rules/web-cards-and-threads.md`
  // › Feed card chassis: left bar + pip + mono-caps name carry identity — and
  // the hover card fetches its own from /author-card — so the three avatar
  // columns this used to select (accounts, external_authors, external_items)
  // reached no renderer at all.
  // Re-adding one here is not how a card gets a picture.
  pubkey: string | null; // native only
  pipStatus: "known" | "partial" | "unknown" | "contested";
}

export interface PostOrigin {
  protocol: "nostr" | "atproto" | "activitypub" | "rss" | "email" | string;
  uri: string;
  /**
   * The item's public web PERMALINK where the ingester knew one, distinct from
   * `uri`, which is its stable IDENTITY.
   *
   * They coincide for atproto/activitypub/nostr, and for the RSS feeds whose
   * guid happens to be a link. They do NOT for an RSS feed whose guid is a
   * `urn:uuid:`, a `tag:` or a bare integer — perfectly conformant, and the
   * reason the reader used to answer "Could not extract" for such a feed while
   * the card's own `→` correctly showed nothing. The client prefers this field
   * and falls back to deriving one from `uri` (web `lib/post/origin-url.ts`),
   * so historical rows are unchanged and the two surfaces finally agree.
   *
   * NULL is "we do not know one", never "there is none to know".
   */
  webUrl: string | null;
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
  /**
   * Whether the source surface (`/source/:id`, `GET /sources/:id`) will serve
   * `externalSourceId` — the route's own two conditions, a public protocol
   * (`lib/public-source-protocols.ts`) and an active row — so the card links
   * the source only where the page exists. A private email newsletter's posts
   * linked to a 404 on both registers (MODERNHAUS-ADR §E7.3). Set on the
   * external branch only; absent means there is no page to link.
   */
  sourceBrowsable?: boolean;
  /**
   * An external NOSTR item's own event id and author pubkey (both 64-hex, off
   * `interaction_data`), so a quote of it can carry a NIP-18 `q` tag and be
   * replayed onto the relays it lives on (CA-I13). Absent everywhere else.
   */
  nostrEvent?: { id: string; pubkey: string } | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The quotable Nostr event behind an external row, or null. */
function externalNostrEvent(
  protocol: string | null,
  data: { id?: unknown; pubkey?: unknown } | null | undefined,
): { id: string; pubkey: string } | null {
  if (protocol !== "nostr_external" || !data) return null;
  const { id, pubkey } = data;
  return typeof id === "string" && HEX64.test(id) && typeof pubkey === "string" && HEX64.test(pubkey)
    ? { id, pubkey }
    : null;
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
  // NATIVE COMMENT NODES ONLY, and its ABSENCE is what tells a THING from a
  // remark inside one. A comment is projected as `type: "note"` (the union has
  // no third value) and its `version` is its own event id, so nothing else on
  // this shape distinguishes it from a top-level note — which is precisely how
  // every card offered `Reply` on a reply and every one of those replies was
  // refused (`POST /replies` 400 `target_is_reply`: a comment is not a reply
  // TARGET, the conversation's root is, and nesting is `parentCommentId`).
  // The two facts a reply to this comment needs and cannot derive: the root's
  // event id + kind (the route's target, read off `comments.target_kind`, the
  // RESOLVED kind the insert persisted) and this comment's own row id.
  // Stamped by `commentToPost` alone; a THING never carries it.
  conversation?: { rootEventId: string; rootKind: number; commentId: string };
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

// The post_id of an external_items row named by id — READ from its
// feed_items row, derived only where it has none (a context row whose card
// was never written). The posts rule: read the stored post_id, derive only as
// a fallback. One home because the thread projector asks the same question.
export const externalParentPostId = (col: string) => `COALESCE(
    (SELECT fip.post_id FROM feed_items fip
      WHERE fip.external_item_id = ${col}),
    (SELECT feed_items_derive_post_id(eip.protocol::text, eip.source_item_uri)
       FROM external_items eip
      WHERE eip.id = ${col}))`;

// Leading comma: appended directly after FEED_SELECT in `SELECT ${FEED_SELECT}${POST_SELECT}`.
export const POST_SELECT = `,
  fi.post_id AS post_id, fi.version AS version,
  fi.biddability_tier AS biddability_tier_persisted,
  fi.external_author_id AS external_author_id,
  acc.display_name AS acc_display_name, acc.username AS acc_username,
  -- The member who claims this external identity, ONLY where they have
  -- consented to showing it (CROSS-NETWORK-ROUNDTRIP-ADR D1/D-Q1): the raw
  -- xa.account_id is a fact about an undisclosed link as often as a disclosed
  -- one, and this column leaves the gateway on every card. The CASE keeps the
  -- lookup off the (overwhelming) unclaimed rows.
  CASE WHEN xa.account_id IS NOT NULL THEN ${disclosedClaimantSql("xa")} END AS xa_account_id,
  CASE WHEN xa.account_id IS NOT NULL THEN ${disclosedClaimantUsernameSql("xa")} END AS xa_member_username,
  xa.display_name AS xa_display_name,
  xa.handle AS xa_handle, xa.handle_uri AS xa_handle_uri,
  vt.upvote_count AS vt_up, vt.downvote_count AS vt_down,
  -- A COMMENT ROW TAKES NO ARM HERE, DELIBERATELY. Its inReplyTo is the
  -- parent comment's post_id, else the conversation root's, and that is
  -- commentToPost's to compute — feedItemToPost hands a comment row straight
  -- to it rather than reimplementing the projection (see the branch at the top
  -- of the mapper), so the two columns below are what that function needs and
  -- in_reply_to_post_id is left NULL on those rows rather than being a second,
  -- drifting answer.
  ${nostrTargetPostId("cm.target_event_id")} AS cm_root_post_id,
  CASE WHEN cmp.nostr_event_id IS NOT NULL
       THEN feed_items_derive_post_id('nostr', cmp.nostr_event_id)
  END AS cm_parent_post_id,
  -- A native note answering an EXTERNAL post (POST /external-items/:id/reply,
  -- every protocol including external nostr) carries its parent only in
  -- notes.external_parent_id — CROSS-NETWORK-ROUNDTRIP-ADR F1/A1. The parent's
  -- STORED post_id first (idx_feed_items_external, unique), derivation from
  -- the parent row only where it has no feed_items row.
  CASE
    WHEN n.reply_to_event_id IS NOT NULL THEN ${nostrTargetPostId("n.reply_to_event_id")}
    WHEN n.external_parent_id IS NOT NULL THEN ${externalParentPostId("n.external_parent_id")}
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

// A read-only empty set for the comment branch below — `feedItemToPost` has no
// viewer, so there is no mute set to consult. Module-level so a feed page does
// not allocate one per card.
const EMPTY_MUTES: ReadonlySet<string> = new Set<string>();

// =============================================================================
// Post mapper (§2.2). Emits the unified Post shape Phase 2's PostCard consumes.
// Fields without a cheap source yet are nulled/zeroed with intent.
// =============================================================================
export function feedItemToPost(row: any): Post {
  // A NATIVE REPLY IS PROJECTED BY `commentToPost`, NOT HERE (migration 232).
  // The row is a feed_items carrier for a `comments` row, and everything that
  // makes a remark a remark — `conversation`, the root-or-parent `inReplyTo`,
  // the "[deleted]" body — is that function's. Branching first also keeps the
  // whole of the mapper below honest: `isNative` would otherwise be false for a
  // comment and the external author branch would read `ei_*` columns that are
  // NULL on every one of these rows.
  //
  // `rootLocked` is NOT stamped here and cannot be: it is the one viewer-
  // dependent fact on a Post and this function takes no viewer (see the field's
  // header). The routes that have resolved access stamp it after mapping —
  // `feeds/items.ts` does it for a feed page exactly as `author.ts` does for
  // the Replies log.
  if (row.item_type === "comment") {
    return commentToPost(
      {
        id: row.cm_id,
        derived_post_id: row.post_id,
        nostr_event_id: row.nostr_event_id,
        parent_comment_id: row.cm_parent_comment_id ?? null,
        parent_post_id: row.cm_parent_post_id ?? null,
        target_event_id: row.cm_target_event_id,
        target_kind: row.cm_target_kind,
        content: row.cm_content,
        published_at_epoch: Number(row.published_at_epoch),
        deleted_at: row.cm_deleted_at ?? null,
        author_id: row.author_id,
        acc_display_name: row.acc_display_name ?? null,
        acc_username: row.acc_username ?? null,
        nostr_pubkey: row.nostr_pubkey ?? null,
        pip_status: row.pip_status ?? null,
        vt_up: row.vt_up ?? null,
        vt_down: row.vt_down ?? null,
      },
      // The conversation's root THING, resolved through the one home
      // (`nostrTargetPostId` -> `article_post_id`) in POST_SELECT, never
      // re-derived here. It is `inReplyTo`'s fallback for a top-level reply.
      row.cm_root_post_id,
      // No viewer, so no mute set: the feed's ranking pass has already dropped
      // muted authors, and every other caller of this mapper is a surface with
      // no mute term at all. An empty set says "not asked", which is the truth.
      EMPTY_MUTES,
    );
  }
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
        memberUsername: null, // the byline already links a native author
        displayName: row.acc_display_name ?? null,
        handle: row.acc_username ?? null,
        handleUri: null, // native profile is internal (/username); no origin link
        pubkey: row.nostr_pubkey ?? null,
        pipStatus: row.pip_status ?? "unknown",
      }
    : {
        id: row.external_author_id ?? null, // null for tier D (no byline row)
        accountId: row.xa_account_id ?? null,
        memberUsername: row.xa_member_username ?? null,
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
        // Native content links to all.haus, never out (see the client helper).
        webUrl: null,
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
        webUrl: row.ei_canonical_url ?? null,
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
        sourceBrowsable:
          !row.ei_is_context_only &&
          row.source_is_active === true &&
          isPublicSourceProtocol(row.source_protocol),
        publication: null,
        nostrEvent: externalNostrEvent(row.source_protocol, row.ei_interaction_data),
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
  // The conversation's root, straight off the comment's own columns — the
  // event id `POST /replies` takes as its target and the kind that insert
  // RESOLVED (never the kind some client once declared). Both queries that
  // build a CommentRow select them; see `Post.conversation`.
  target_event_id: string;
  target_kind: number;
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
  mutedIds: ReadonlySet<string>,
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
      webUrl: null,
      sourceName: null,
      publication: null,
    },
    author: {
      id: c.author_id,
      accountId: c.author_id,
      memberUsername: null,
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
    // What a reply TO this comment has to be addressed to (see the field's
    // header). Unconditional here and absent everywhere else, so a card can
    // read it as "this post is a remark inside a conversation".
    conversation: {
      rootEventId: c.target_event_id,
      rootKind: Number(c.target_kind),
      commentId: c.id,
    },
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
