// =============================================================================
// The §4 capability matrix + §7 biddability gate, as data.
//
// UNIVERSAL-POST-ADR §4 is "the centrepiece": every (level × affordance) cell is
// a value in LEVEL_SPEC. §7 then SUBTRACTS per biddability tier (tierCaps).
// resolveSpec(level, tier, post) intersects the two into a flat ResolvedSpec that
// PostCard hands to its dumb leaf components — so affordance logic is one table
// lookup + one mask, never scattered `if (protocol === 'rss')` chains.
//
// The matrix is the MAXIMUM per level; the tier mask only ever removes.
// =============================================================================

import type { Level, BiddabilityTier, Post } from "./types";
import { authorMark, platformMark } from "./resonance";

// "+1 step" of indentation. Matches the documented thread step-in (CLAUDE.md →
// "Thread step-in … indented 32px once (ml-8)"). Phase 3 owns the thread walk;
// here it only governs parent/reply offset in the harness.
export const INDENT_STEP_PX = 32;

// CLAUDE feed/thread rhythm. Exported because the feed gap is a card's own
// half of the 20px a vessel renders (the column's `VESSEL_GAP` is the other),
// and a non-post card in a feed-rhythm log — the profile's `PersonCard` — has
// to take it from here rather than restate the number.
export const GAP_PX = { feed: 8, tight: 5, none: 0 } as const;

type BodyMode = "expanded" | "full" | "one-line";
type MediaMode = "full-width" | "sized" | "single-thumbnail" | "none";
type VideoMode = "autoplay-unmute" | "static" | "none";
type HausMode = "full" | "numerals-only" | "none";
type CountersMode = "fresh-on-expand" | "static" | "inline-numerals" | "none";
type QuoteMode = "full-child" | "mini" | "stub" | "none";
// `focus` walks the queue to the row's feed (WORKSPACE-QUEUE-ADR §VII.5) — a
// member of its own, never an overload of `expand-focal`, because what it opens
// is a FEED, not the post.
type ClickAction =
  | "collapse"
  | "expand-focal"
  | "reroot-focal"
  | "reader-pane"
  | "focus"
  | "none";

interface LevelSpec {
  textScale: number; // × ctx.bodyPx
  indentStep: 0 | 1 | "host"; // "host" = rendered inside the quote container, no own indent
  gapBelow: keyof typeof GAP_PX;
  body: BodyMode;
  media: MediaMode;
  video: VideoMode;
  haus: HausMode; // all.haus vote/repost/save
  originTag: boolean;
  report: boolean; // whether this LEVEL offers the control at all
  originCounters: CountersMode;
  quoteEmbed: QuoteMode;
  click: ClickAction;
  // D7: the resonance glyph rides the byline metadata cluster at feed and
  // thread-focal levels ONLY. Off everywhere else — the cluster is already
  // tight on quoted/condensed, and band-at-a-glance earns its space where the
  // reader is deciding whether to read, not on context chrome around something
  // they're already reading.
  resonance: boolean;
  // The post's time, in the byline or (tier D) on the provenance line. Off only
  // for a preview row, which shows none (WORKSPACE-QUEUE-ADR §VI.3).
  timestamp: boolean;
  // A content-warned post's SHOW CONTENT toggle. Off, the warning label stands
  // in place of the text with nothing to reveal it — a preview row is not
  // where a warned post is opened (§VII.5).
  warningReveal: boolean;
}

// One row per §4 column. Read the ADR §4 table top-to-bottom against this.
export const LEVEL_SPEC: Record<Level, LevelSpec> = {
  focal: {
    textScale: 1.0,
    indentStep: 0,
    gapBelow: "tight",
    body: "expanded",
    media: "full-width",
    video: "autoplay-unmute",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "fresh-on-expand",
    quoteEmbed: "full-child",
    click: "collapse",
    resonance: true,
    timestamp: true,
    warningReveal: true,
  },
  feed: {
    textScale: 1.0,
    indentStep: 0,
    gapBelow: "feed",
    body: "full",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "none",
    quoteEmbed: "mini",
    click: "expand-focal",
    resonance: true,
    timestamp: true,
    warningReveal: true,
  },
  // THE SPINE IS CONTEXT, EXCEPT WHERE IT IS AN ARTICLE (2026-09-05).
  // ARTICLE-HEADED-CONVERSATIONS-ADR D1. This row went full-size and flush on
  // 2026-09-02 to fix a real complaint — an ARTICLE at the head of a chain
  // rendered as a 90%-scale inset preview of itself, which is not what an
  // article is anywhere else in the product. But the complaint was about
  // articles in threads and the fix was applied to the shared row, so every
  // conversation on every surface got the article's treatment and the whole of
  // the workspace, where a chain almost never terminates in an article, lost
  // the inset that says "this is what is being replied to".
  //
  // So the table goes back to what it was and the ARTICLE case is an override
  // in resolveSpec, keyed on POST TYPE — beside the `click` override that is
  // already keyed the same way, one line away. A note or an external post above
  // the focal is context and the smaller inset is what says so; the article is
  // the thing the conversation is about and renders as itself.
  //
  // The 32px channel the gutter pointers live in is this step-in, so with the
  // inset back the channel is continuous again — but PostThread keeps reading
  // the SPINE rect for its clash test, because a full-size flush article
  // ancestor has no channel beside it and the spine rect is the more general
  // test of the two.
  "thread-parent": {
    textScale: 0.9,
    indentStep: 1,
    gapBelow: "tight",
    body: "expanded",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "static",
    quoteEmbed: "mini",
    click: "reroot-focal",
    resonance: false,
    timestamp: true,
    warningReveal: true,
  },
  "thread-reply": {
    textScale: 0.9,
    indentStep: 1,
    gapBelow: "tight",
    body: "expanded",
    media: "sized",
    video: "static",
    haus: "full",
    originTag: true,
    report: true,
    originCounters: "static",
    quoteEmbed: "mini",
    click: "reroot-focal",
    resonance: false,
    timestamp: true,
    warningReveal: true,
  },
  quoted: {
    textScale: 0.85,
    indentStep: "host",
    gapBelow: "none",
    body: "full",
    media: "single-thumbnail",
    video: "none",
    haus: "none",
    originTag: false,
    report: false,
    originCounters: "none",
    quoteEmbed: "stub",
    click: "reroot-focal",
    resonance: false,
    timestamp: true,
    warningReveal: true,
  },
  condensed: {
    textScale: 0.85,
    indentStep: 0,
    gapBelow: "tight",
    body: "one-line",
    media: "none",
    video: "none",
    haus: "numerals-only",
    originTag: false,
    report: false,
    originCounters: "inline-numerals",
    quoteEmbed: "stub",
    click: "expand-focal",
    resonance: false,
    timestamp: true,
    warningReveal: true,
  },
  // THE QUEUE'S PREVIEW ROWS (WORKSPACE-QUEUE-ADR §VII.5): a feed ahead of the
  // reader, shown as a list of what is in it. `condensed` with the cells that
  // make a row a GLANCE rather than a card: its provenance line (`originTag`),
  // no actions (`haus`), no origin counts, and a click that walks the queue to
  // the feed and opens the row's conversation there (`focus`, 2026-09-27) — except on an ARTICLE, whose click `resolveSpec`
  // rewrites to `reader-pane` here as everywhere (D6: a click on an article is
  // already the decision to read it). And three cells §VI.3 asks for that the
  // §VII.5 table did not list: no quote (the stub is a control, and it would
  // re-root a thread nobody can see), no timestamp, and a content warning
  // that stands in for the text rather than offering to reveal it.
  preview: {
    textScale: 0.85,
    indentStep: 0,
    gapBelow: "tight",
    body: "one-line",
    media: "none",
    video: "none",
    haus: "none",
    originTag: true,
    report: false,
    originCounters: "none",
    quoteEmbed: "none",
    click: "focus",
    resonance: false,
    timestamp: false,
    warningReveal: false,
  },
};

// §7 subtractive mask. all.haus actions (haus) are AVAILABLE AT EVERY TIER —
// the scoresheet is minted for every THING — so haus is never masked here.
export interface TierCaps {
  bylineProfile: boolean; // byline routes to a profile (author known: A/B/C) vs plain text (D)
  originCounters: boolean; // origin like/reply/repost exist (A/B) vs not (C/D)
  threads: boolean; // origin parents/replies exist (A/B) — informs click reachability (Phase 3)
  interactBack: boolean; // reply/like/repost to the origin (A/B)
  originTagSourceOnly: boolean; // tier D: origin tag degrades to source-name only
}

export function tierCaps(tier: BiddabilityTier): TierCaps {
  switch (tier) {
    case "A":
    case "B":
      return {
        bylineProfile: true,
        originCounters: true,
        threads: true,
        interactBack: true,
        originTagSourceOnly: false,
      };
    case "C":
      return {
        bylineProfile: true,
        originCounters: false,
        threads: false,
        interactBack: false,
        originTagSourceOnly: false,
      };
    case "D":
      return {
        bylineProfile: false,
        originCounters: false,
        threads: false,
        interactBack: false,
        originTagSourceOnly: true,
      };
  }
}

export interface ResolvedSpec {
  textScale: number;
  indentPx: number;
  insideHost: boolean; // quoted: laid out inside the host's quote container
  gapBelowPx: number;
  body: BodyMode;
  media: MediaMode;
  video: VideoMode;
  haus: HausMode;
  showOriginTag: boolean;
  originTagSourceOnly: boolean;
  showReport: boolean; // the level permits it (every tier may be reported)
  originCounters: CountersMode; // "none" once the tier has no origin counters
  quoteEmbed: QuoteMode;
  click: ClickAction; // articles override to "reader-pane"
  bylineProfile: boolean; // byline routes to a profile
  // BYLINE-AND-PROVENANCE-ADR D9/Q1: the byline row exists only for a post that
  // NAMES someone. A genuine tier-D post (rss/email with no author, ever) has
  // nothing true to put in the slot — the source is the provenance line's
  // fact, not the byline's — so the row goes, the title leads, and the
  // timestamp rejoins the provenance line (`originTagTime`). Where the level
  // carries no provenance line the row stays as the timestamp's only home.
  showByline: boolean;
  originTagTime: boolean;
  threads: boolean;
  interactBack: boolean;
  // D7 resonance glyph: the level permits it AND this post actually carries a
  // band ≥ 1. Band 0 and "no band" both render nothing, so they collapse here.
  showResonance: boolean;
  // The same mark at the PLATFORM scope, rendered in the origin row beside the
  // network name. Gated on `spec.resonance`, NOT on `spec.originTag`: the tag
  // itself runs on thread parents/replies, where band-at-a-glance deliberately
  // does not — the mark earns its space where the reader is deciding whether to
  // read, not on context chrome around something they are already reading.
  showPlatformResonance: boolean;
  // The byline's time. (The provenance line's is `originTagTime`, which this
  // gates too.)
  showTime: boolean;
  // A content warning offers SHOW CONTENT; false, it is a label alone.
  warningReveal: boolean;
}

export function resolveSpec(
  level: Level,
  tier: BiddabilityTier,
  post: Post,
): ResolvedSpec {
  const spec = LEVEL_SPEC[level];
  const caps = tierCaps(tier);
  // A post names someone when it carries any author identity at all: a native
  // pubkey, an external_authors record, or a name/handle (a record-less name
  // is a data gap the byline still shows, via its protocol fallback — never
  // the source's name, which is D1's slot collapse). Only the tier-D case —
  // all four absent — has no byline.
  const namesSomeone =
    !!post.author.pubkey ||
    !!post.author.id ||
    !!post.author.displayName ||
    !!post.author.handle;
  const showByline = namesSomeone || !spec.originTag;

  // D1 — an ARTICLE at the head of a chain is the thing the whole conversation
  // is about and the one node with a full card treatment everywhere else in the
  // product, so it renders as itself: full size, flush. Everything else at
  // `thread-parent` is context and keeps the table's inset. Keyed on post type
  // rather than on surface, because an article ancestor is equally wrong at 0.9
  // in a workspace vessel — where the 2026-09-02 change would never have caught
  // it — and a level-plus-type key needs no new prop threaded through four hosts.
  const articleHead = level === "thread-parent" && post.type === "article";

  return {
    textScale: articleHead ? 1.0 : spec.textScale,
    indentPx: articleHead ? 0 : spec.indentStep === 1 ? INDENT_STEP_PX : 0,
    insideHost: spec.indentStep === "host",
    gapBelowPx: GAP_PX[spec.gapBelow],
    body: spec.body,
    media: spec.media,
    video: spec.video,
    haus: spec.haus, // never tier-masked
    showOriginTag: spec.originTag,
    originTagSourceOnly: caps.originTagSourceOnly,
    // REPORTING IS NOT NATIVE-ONLY ANY MORE (L6.3; D1 §9.2, which says
    // reporting covers "native, DM, and ingested"). It was, because the report
    // table could only hold a Nostr event id or an account id — so an external
    // card had no identifier to report WITH, and the honest thing was to
    // withhold a control that could not work. `moderation_reports.target_post_id`
    // (migration 223) is `feed_items.post_id`, which every card carries
    // whatever it is made of, so the reason for the restriction is gone and the
    // restriction goes with it. The level still decides: a quoted or condensed
    // card offers nothing, because the full card underneath it does.
    showReport: spec.report,
    // Origin counters require both the tier to expose them AND actual data
    // (native is null per §6, so it never shows origin counters).
    originCounters:
      caps.originCounters && post.originCounts ? spec.originCounters : "none",
    quoteEmbed: spec.quoteEmbed,
    // Articles open the reader pane instead of expanding inline (§3.1).
    click: post.type === "article" ? "reader-pane" : spec.click,
    // The byline routes to a profile when the post CARRIES an identity record
    // (native accounts.id / external_authors.id), whatever the biddability
    // tier says: since BYLINE-AND-PROVENANCE-ADR S3 a bylined rss item has an
    // external_authors row (tier C, source-scoped) while its biddability stays
    // D (D5 — that ladder is load-bearing for dedup and does not move), so the
    // tier mask alone would keep every RSS byline dead. The identity is the
    // fact; the mask is the fallback for a post that carries none.
    bylineProfile: caps.bylineProfile || !!post.author.id,
    showByline,
    originTagTime: !showByline && spec.originTag && spec.timestamp,
    threads: caps.threads,
    interactBack: caps.interactBack,
    // Not tier-masked: resonance is a property of the response a post drew, not
    // of how much identity we hold on its author, so a tier-C rss item with a
    // band would show one. In practice rss/email never get a band computed at
    // all (D4 absence semantics), which is the ADR's chosen mechanism — the
    // silence lives in the data, deliberately, rather than in a tier mask here.
    showResonance: spec.resonance && authorMark(post) !== null,
    showPlatformResonance: spec.resonance && platformMark(post),
    showTime: spec.timestamp,
    warningReveal: spec.warningReveal,
  };
}
