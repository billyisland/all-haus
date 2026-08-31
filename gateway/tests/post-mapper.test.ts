import { describe, it, expect } from "vitest";
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
// the event id therefore dangles the edge for article targets. The fix routes both
// nostr branches through nostrTargetPostId(), which resolves an article event id to
// its coordinate before deriving (falling back to the event id for note targets).
//
// The runtime behaviour was validated against the dev DB; these tests are a
// structural regression guard against silently reverting to the naive derivation.

describe("nostrTargetPostId (P1-2 article-coordinate resolution)", () => {
  const sql = nostrTargetPostId("n.reply_to_event_id");

  it("derives under the 'nostr' protocol", () => {
    expect(sql).toContain("feed_items_derive_post_id('nostr',");
  });

  it("resolves an article event id to its naddr coordinate", () => {
    expect(sql).toContain("'30023:'");
    expect(sql).toContain("FROM articles");
    expect(sql).toContain("JOIN accounts");
    // looks up the article by the stored event id
    expect(sql).toContain("nostr_event_id = n.reply_to_event_id");
  });

  it("falls back to the raw event id for non-article (note) targets", () => {
    expect(sql).toContain("COALESCE(");
    // the column appears both in the lookup predicate and as the COALESCE fallback
    const occurrences = sql.split("n.reply_to_event_id").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("guards the coordinate against null pubkey/dtag", () => {
    expect(sql).toContain("nostr_pubkey IS NOT NULL");
    expect(sql).toContain("nostr_d_tag IS NOT NULL");
  });
});

describe("POST_SELECT routes nostr reply/quote edges through the resolver", () => {
  it("does NOT derive the reply edge naively from the raw event id", () => {
    // the pre-fix form — its reintroduction is the regression we guard against
    expect(POST_SELECT).not.toContain(
      "feed_items_derive_post_id('nostr', n.reply_to_event_id)",
    );
    expect(POST_SELECT).not.toContain(
      "feed_items_derive_post_id('nostr', n.quoted_event_id)",
    );
  });

  it("resolves both the reply and quote nostr branches via the article coordinate", () => {
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

// BYLINE-AND-PROVENANCE-ADR D8 (S2): a native article carries its publication
// in the provenance slot — the container the reader subscribed to, the same
// slot an external card gives its source. The join is structural (only
// Postgres evaluates it) and the mapper's projection of it is behavioural.
describe("origin.publication (BYLINE-AND-PROVENANCE-ADR D8)", () => {
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
        acc_avatar: null,
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
