import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  nostrTargetPostId,
  POST_SELECT,
  feedItemToPost,
  commentToPost,
} from "../src/lib/post-mapper.js";
import { FEED_SELECT, FEED_JOINS } from "../src/lib/feed-sql.js";

// These guard the P1-2 fix: a native kind-1 reply/quote stores the target's raw
// nostr EVENT id, but a native article's deterministic post_id is minted from its
// naddr COORDINATE '30023:<pubkey>:<dtag>' (migration 098). Deriving straight from
// the event id therefore dangles the edge for article targets. Both nostr branches
// route through nostrTargetPostId(), which resolves an article event id to the
// article's post_id before falling back to the event id for note targets.
//
// AMENDED 2026-09-05. The resolver used to REBUILD the coordinate itself
// ('30023:' || pubkey || ':' || dtag) and hash that; it now calls
// `article_post_id(uuid)`, which READS feed_items.post_id and derives only where
// no row exists (READING-LOG-AND-LIBRARY-ADR D7). The three assertions that
// pinned the rebuilt coordinate are gone, because the string they looked for is
// the thing that was wrong: a re-derivation cannot produce the mint's own
// fallback form, `('nostr_article', <article id>)`.
//
// AND NOTE WHAT A TEXT PIN CAN NO LONGER SEE. One assertion here used to be
// "POST_SELECT does NOT contain feed_items_derive_post_id('nostr',
// n.reply_to_event_id)", the naive form. That exact string is now present and
// CORRECT — it is the COALESCE's fallback arm, which is what a note target must
// take. So the structural guard can no longer tell the shipped expression from
// the bug it replaced, and it does not pretend to: the behavioural guard is
// `tests/root-post-id-resolution.test.ts`, DB-backed, which constructs the one
// row where reading and re-deriving disagree and asserts both answers. These
// remain what they always said they were — a cheap check that the resolver is
// still WIRED IN, not a check that it is right.

describe("nostrTargetPostId (article-target resolution)", () => {
  const sql = nostrTargetPostId("n.reply_to_event_id");

  it("reads the article's post_id through the one home, never rebuilding the coord", () => {
    expect(sql).toContain("article_post_id(art2.id)");
    expect(sql).toContain("FROM articles");
    // looks the article up by the stored event id
    expect(sql).toContain("nostr_event_id = n.reply_to_event_id");
    // The re-derivation is GONE. This is the regression that matters now: it
    // invents an id for any article the mint's fallback branch minted.
    expect(sql).not.toContain("'30023:'");
  });

  it("falls back to the raw event id for non-article (note) targets", () => {
    expect(sql).toContain("COALESCE(");
    expect(sql).toContain("feed_items_derive_post_id('nostr',");
    // the column appears both in the lookup predicate and as the COALESCE fallback
    const occurrences = sql.split("n.reply_to_event_id").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("POST_SELECT routes nostr reply/quote edges through the resolver", () => {
  it("routes both nostr branches through the resolver, not straight at the event id", () => {
    // The naive form is no longer distinguishable by text — it IS the
    // resolver's fallback arm (see the header) — so what is pinned instead is
    // that the article lookup is present on both branches. Below.
    expect(POST_SELECT).toContain("article_post_id(art2.id)");
    expect(POST_SELECT).not.toContain("'30023:'");
  });

  it("resolves both the reply and quote nostr branches via the article lookup", () => {
    expect(POST_SELECT).toContain("nostr_event_id = n.reply_to_event_id");
    expect(POST_SELECT).toContain("nostr_event_id = n.quoted_event_id");
  });

  it("leaves the external (non-nostr) reply/quote derivation unchanged", () => {
    expect(POST_SELECT).toContain(
      "feed_items_derive_post_id(fi.source_protocol::text, ei.source_reply_uri)",
    );
    expect(POST_SELECT).toContain(
      "feed_items_derive_post_id(fi.source_protocol::text, ei.source_quote_uri)",
    );
  });
});

// Guards the Phase-5 KNOWN GAP fix: the /thread projector must surface the
// external_item id as Post.externalItemId so the focal card's like/repost/reply
// interact-back enables (web's usePostInteractions gates `active` on it). Before
// the fix the field was never emitted → buttons rendered inert for every external
// thread node despite a valid linked account.
describe("feedItemToPost surfaces the external interact-back key", () => {
  it("emits externalItemId for an external THING", () => {
    const post = feedItemToPost({
      item_type: "external",
      external_item_id: "ext-123",
      post_id: "deadbeef",
      source_protocol: "atproto",
      published_at_epoch: 1000,
    });
    expect(post.externalItemId).toBe("ext-123");
  });

  it("leaves externalItemId null for a native THING (scoresheet, not interact-back)", () => {
    expect(
      feedItemToPost({
        item_type: "note",
        external_item_id: null,
        post_id: "cafe",
        published_at_epoch: 1000,
      }).externalItemId,
    ).toBeNull();
    expect(
      feedItemToPost({
        item_type: "article",
        external_item_id: null,
        post_id: "f00d",
        published_at_epoch: 1000,
      }).externalItemId,
    ).toBeNull();
  });
});

// MODERNHAUS-ADR §E7.3: a private email newsletter's cards linked to
// `/source/<id>`, which `GET /sources/:id` answers 404 — the route serves only a
// PUBLIC protocol on an ACTIVE row. `origin.sourceBrowsable` is those two
// conditions, stated where the row is read, so the card links only a page that
// opens. Each case differs from the browsable one in ONE column.
describe("origin.sourceBrowsable is the source route's own two conditions", () => {
  const browsable = {
    item_type: "external",
    post_id: "e2",
    published_at_epoch: 1000,
    source_id: "src-1",
    source_protocol: "rss",
    source_is_active: true,
    source_display_name: "A Blog",
    ei_is_context_only: false,
  };
  it("is true for an active row of a public protocol", () => {
    expect(feedItemToPost(browsable).origin.sourceBrowsable).toBe(true);
  });
  it("is false for an email newsletter, which the route will not serve to anybody", () => {
    expect(feedItemToPost({ ...browsable, source_protocol: "email" }).origin.sourceBrowsable).toBe(false);
  });
  it("is false for an inactive source", () => {
    expect(feedItemToPost({ ...browsable, source_is_active: false }).origin.sourceBrowsable).toBe(false);
  });
  it("is false for a context-only row, whose source is the hydrating focal's, not its own", () => {
    expect(feedItemToPost({ ...browsable, ei_is_context_only: true }).origin.sourceBrowsable).toBe(false);
  });
  it("FEED_SELECT carries the row's is_active off the source join", () => {
    expect(FEED_SELECT).toContain("xs.is_active AS source_is_active");
    expect(FEED_JOINS).toContain("LEFT JOIN external_sources xs ON xs.id = fi.source_id");
  });
});

// BYLINE-AND-PROVENANCE-ADR D8 (S2): a native article carries its publication
// in the provenance slot — the container the reader subscribed to, the same
// slot an external card gives its source. The join is structural (only
// Postgres evaluates it) and the mapper's projection of it is behavioural.
describe("origin.publication (BYLINE-AND-PROVENANCE-ADR D8)", () => {
  // The embed darks with the publications suspension AT THIS MAPPER — the one
  // choke point every card path shares — so the projection tests below run
  // with the flag on, and one test pins the dark state.
  beforeEach(() => {
    process.env.PUBLICATIONS_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.PUBLICATIONS_ENABLED;
  });

  it("is withheld ENTIRELY while PUBLICATIONS_ENABLED is off — no card may wear a /pub link into a suspended surface", () => {
    delete process.env.PUBLICATIONS_ENABLED;
    const post = feedItemToPost({
      item_type: "article",
      post_id: "f00d",
      published_at_epoch: 1000,
      pub_name: "The Recurse",
      pub_slug: "the-recurse",
      pub_status: "active",
    });
    expect(post.origin.publication).toBeNull();
  });

  it("FEED_SELECT/FEED_JOINS carry the publication off articles.publication_id", () => {
    // Structural pin: the columns the mapper reads must be projected, and
    // from a join keyed on the ARTICLE's publication (never a feed_source's).
    expect(FEED_SELECT).toContain("pub.name AS pub_name");
    expect(FEED_SELECT).toContain("pub.slug AS pub_slug");
    expect(FEED_JOINS).toContain(
      "LEFT JOIN publications pub ON pub.id = a.publication_id",
    );
  });

  it("projects a publication article's name + slug, active while status = 'active'", () => {
    const post = feedItemToPost({
      item_type: "article",
      post_id: "f00d",
      published_at_epoch: 1000,
      pub_name: "The Recurse",
      pub_slug: "the-recurse",
      pub_status: "active",
    });
    expect(post.origin.publication).toEqual({
      name: "The Recurse",
      slug: "the-recurse",
      active: true,
    });
  });

  it("an archived/suspended publication keeps its name but is NOT active (no link to a 404)", () => {
    // /pub/:slug answers 404 unless status = 'active' (publications/public.ts),
    // so the card renders the name plain; the FEED_SELECT pin above carries
    // pub_status for this reason.
    expect(FEED_SELECT).toContain("pub.status AS pub_status");
    for (const status of ["archived", "suspended", null, undefined]) {
      const post = feedItemToPost({
        item_type: "article",
        post_id: "f00d",
        published_at_epoch: 1000,
        pub_name: "The Recurse",
        pub_slug: "the-recurse",
        pub_status: status,
      });
      expect(post.origin.publication).toEqual({
        name: "The Recurse",
        slug: "the-recurse",
        active: false,
      });
    }
  });

  it("is null for an article outside a publication, for a note, and for external", () => {
    const base = { post_id: "x", published_at_epoch: 1000, pub_name: null, pub_slug: null };
    expect(feedItemToPost({ ...base, item_type: "article" }).origin.publication).toBeNull();
    expect(feedItemToPost({ ...base, item_type: "note" }).origin.publication).toBeNull();
    // An external row never carries one even if a stray column arrives: its
    // container is origin.sourceName, and the two are one slot on the card.
    expect(
      feedItemToPost({
        ...base,
        item_type: "external",
        source_protocol: "rss",
        source_display_name: "The Guardian",
        pub_name: "leak",
        pub_slug: "leak",
      }).origin.publication,
    ).toBeNull();
  });

  it("a comment carries no publication", () => {
    const post = commentToPost(
      {
        derived_post_id: "c1",
        nostr_event_id: "ev",
        author_id: "a",
        acc_display_name: "A",
        acc_username: "a",
        nostr_pubkey: "pk",
        pip_status: null,
        vt_up: 0,
        vt_down: 0,
      } as any,
      "root",
      new Set(),
    );
    expect(post.origin.publication).toBeNull();
  });
});

// The email adapter (normaliseEmail) yields "" — never null — for a sender with
// no display name, and "" for the handle when there is no From at all. The
// trigger's tier-C mint NULLIFs that string and mints nothing, so the card
// carries no record; if the mapper passed "" through, level-spec's
// `namesSomeone` would still be true via the handle and ExternalByline's
// `displayName ?? handle` would render an EMPTY name (`??` is nullish-only).
// An empty string is an absent name here, exactly as it is in the DB.
describe("external author fields: an empty string is an absent value", () => {
  const base = {
    item_type: "external",
    post_id: "e1",
    published_at_epoch: 1000,
    source_protocol: "email",
    source_display_name: "Newsletter",
  };
  it("displayName '' becomes null so the handle carries the byline", () => {
    const post = feedItemToPost({
      ...base,
      ei_author_name: "",
      ei_author_handle: "sender@example.com",
    });
    expect(post.author.displayName).toBeNull();
    expect(post.author.handle).toBe("sender@example.com");
  });
  it("handle '' becomes null too", () => {
    const post = feedItemToPost({ ...base, ei_author_name: "", ei_author_handle: "" });
    expect(post.author.displayName).toBeNull();
    expect(post.author.handle).toBeNull();
  });
  it("a record's display_name still wins over the item's", () => {
    const post = feedItemToPost({
      ...base,
      external_author_id: "xa-1",
      xa_display_name: "Kiran Stacey",
      ei_author_name: "kiran stacey",
    });
    expect(post.author.displayName).toBe("Kiran Stacey");
  });
});

// =============================================================================
// A COMMENT SAYS WHICH CONVERSATION IT IS IN, OR A REPLY TO IT CANNOT BE SENT.
//
// A comment is projected as a Post of `type: "note"` with its own event id in
// `version` — the union has no third value — so on the wire nothing else tells
// it from a top-level note. The web's `replyTargetFromPost` had nothing else to
// read either, addressed the reply at the comment's own event, and `POST
// /replies` refused it: 400 `target_is_reply`, correctly, since
// `comments.target_event_id` is the conversation's ROOT and nesting is
// `parentCommentId`. Replying to a reply failed on every card surface.
//
// `conversation` is what closes that, and it is worth being precise about what
// each half of this section can see. The projection is behavioural. The two
// QUERIES are a text pin and say so: `commentToPost` reads columns that two
// separate statements must select, only one of which is typed against
// `CommentRow` at all (`author.ts` queries `<any>`), and a `pool.query<T>` is a
// claim about the SQL rather than a check of it in either case. A dropped
// column is silent all the way to the browser, where it reappears as the same
// 400 this fixed.
// =============================================================================

const COMMENT_ROW = {
  id: "comment-uuid",
  derived_post_id: "c1",
  nostr_event_id: "comment-event",
  parent_comment_id: null,
  parent_post_id: null,
  target_event_id: "root-event",
  target_kind: 30023,
  content: "a remark",
  published_at_epoch: 1,
  deleted_at: null,
  author_id: "a",
  acc_display_name: "A",
  acc_username: "a",
  nostr_pubkey: "pk",
  pip_status: null,
  vt_up: 0,
  vt_down: 0,
} as any;

describe("commentToPost stamps the conversation a reply must be addressed to", () => {
  it("carries the root event, the root kind and the comment's own row id", () => {
    const post = commentToPost(COMMENT_ROW, "root", new Set());
    expect(post.conversation).toEqual({
      rootEventId: "root-event",
      rootKind: 30023,
      commentId: "comment-uuid",
    });
    // The comment's OWN event stays where it was: it is the NIP-10 `e` reply
    // tag and the vote target, and it is not what the reply is addressed to.
    expect(post.version).toBe("comment-event");
  });

  it("coerces the kind, because a smallint that ever arrives as text is a kind nothing matches", () => {
    const post = commentToPost(
      { ...COMMENT_ROW, target_kind: "1" },
      "root",
      new Set(),
    );
    expect(post.conversation?.rootKind).toBe(1);
  });

  it("is absent from a THING, which is how a card tells the two apart", () => {
    // `feedItemToPost` never sets it, and must not learn to: an article or a
    // note IS the root, so a reply to one is addressed to it directly.
    expect(
      feedItemToPost({
        post_id: "x",
        published_at_epoch: 1000,
        item_type: "native",
        content_type: "note",
      } as any).conversation,
    ).toBeUndefined();
  });
});

describe("TEXT PIN — both statements that build a CommentRow select those columns", () => {
  const read = (rel: string) =>
    readFileSync(path.resolve(__dirname, "..", "src", rel), "utf8");

  for (const [what, rel] of [
    ["the thread projector", "routes/post-thread.ts"],
    ["the author's replies log", "routes/author.ts"],
  ] as const) {
    it(`${what} selects target_event_id and target_kind`, () => {
      const src = read(rel);
      expect(src).toContain("c.target_event_id");
      expect(src).toContain("c.target_kind");
    });
  }
});
