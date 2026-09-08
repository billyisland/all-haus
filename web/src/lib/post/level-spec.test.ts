import { describe, it, expect } from "vitest";
import { resolveSpec, tierCaps, LEVEL_SPEC } from "./level-spec";
import type { Level, BiddabilityTier, Post } from "./types";

function makePost(over: Partial<Post> = {}): Post {
  return {
    id: "p1",
    version: "p1",
    origin: { protocol: "nostr", uri: "p1", sourceName: null, publication: null },
    author: {
      id: null,
      accountId: null,
      displayName: null,
      handle: null,
      handleUri: null,
      pubkey: "pub-1",
      pipStatus: "known",
    },
    type: "note",
    accessMode: "free",
    body: { text: "x", html: null, title: null, summary: null, media: [], contentWarning: null, poll: null },
    inReplyTo: null,
    quotes: null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: "A",
    publishedAt: 1,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: null,
    externalItemId: null,
    ...over,
  };
}

const native = makePost();
const external = (tier: BiddabilityTier) =>
  makePost({
    origin: { protocol: tier === "B" ? "activitypub" : "atproto", uri: "u", sourceName: "Src", publication: null },
    author: { ...native.author, pubkey: null, displayName: "Jane" },
    biddabilityTier: tier,
    originCounts: { like: 1, reply: 2, repost: 3 },
  });

const ALL_LEVELS: Level[] = ["focal", "feed", "thread-parent", "thread-reply", "quoted", "condensed"];

describe("LEVEL_SPEC table", () => {
  it("has a row for every level", () => {
    for (const lvl of ALL_LEVELS) expect(LEVEL_SPEC[lvl]).toBeTruthy();
  });
  it("text scale matches §4 (focal/feed/parent 1.0, reply .9, quoted/condensed .85)", () => {
    expect(LEVEL_SPEC.focal.textScale).toBe(1.0);
    expect(LEVEL_SPEC.feed.textScale).toBe(1.0);
    expect(LEVEL_SPEC["thread-reply"].textScale).toBe(0.9);
    expect(LEVEL_SPEC.quoted.textScale).toBe(0.85);
    expect(LEVEL_SPEC.condensed.textScale).toBe(0.85);
  });
  // THE SPINE IS CONTEXT, EXCEPT WHERE IT IS AN ARTICLE (2026-09-05,
  // ARTICLE-HEADED-CONVERSATIONS-ADR D1). These assertions are the inverse of
  // the 2026-09-02 ones, which asserted the table cell that had been changed to
  // fix an ARTICLE at the head of a chain — a fix applied to the shared row, so
  // every conversation on every surface got the article's treatment. The row
  // goes back; the article case is an override keyed on POST TYPE.
  //
  // BOTH fixtures, because either alone passes against the wrong key: `native`
  // is a NOTE (makePost defaults to type "note"), so a test that only checks it
  // would go green against a table row of 1.0/0 with no override at all, and a
  // test that only checks the article would go green against the 2026-09-02
  // state this reverses.
  it("the spine is inset context; an ARTICLE at its head is not", () => {
    expect(LEVEL_SPEC["thread-parent"].textScale).toBe(0.9);
    expect(LEVEL_SPEC["thread-parent"].indentStep).toBe(1);
    expect(LEVEL_SPEC["thread-reply"].indentStep).toBe(1);

    // A note ancestor: context, so inset and smaller.
    const note = resolveSpec("thread-parent", "A", native);
    expect(note.textScale).toBe(0.9);
    expect(note.indentPx).toBeGreaterThan(0);

    // An article ancestor: the thing the conversation is about, so it renders
    // as itself — full size, flush.
    const article = resolveSpec("thread-parent", "A", makePost({ type: "article" }));
    expect(article.textScale).toBe(1.0);
    expect(article.indentPx).toBe(0);

    // The override is scoped to the spine: an article in a FEED is not
    // re-scaled by it, and neither is one at thread-reply.
    expect(resolveSpec("thread-reply", "A", makePost({ type: "article" })).indentPx)
      .toBeGreaterThan(0);
    expect(resolveSpec("thread-reply", "A", native).indentPx).toBeGreaterThan(0);
  });
});

describe("tierCaps — §7", () => {
  it("origin counters only for A/B", () => {
    expect(tierCaps("A").originCounters).toBe(true);
    expect(tierCaps("B").originCounters).toBe(true);
    expect(tierCaps("C").originCounters).toBe(false);
    expect(tierCaps("D").originCounters).toBe(false);
  });
  it("byline profile for A/B/C, plain text for D", () => {
    expect(tierCaps("C").bylineProfile).toBe(true);
    expect(tierCaps("D").bylineProfile).toBe(false);
  });
  it("tier D origin tag is source-name only", () => {
    expect(tierCaps("D").originTagSourceOnly).toBe(true);
    expect(tierCaps("A").originTagSourceOnly).toBe(false);
  });
});

describe("resolveSpec — bylineProfile follows the identity record (BYLINE-AND-PROVENANCE S3)", () => {
  const rssBase: Post = {
    ...native,
    author: { ...native.author, id: null, pubkey: null, displayName: "Aditya Chakrabortty" },
    origin: { ...native.origin, protocol: "rss" },
  };
  it("a biddability-D rss post WITH a tier-C author record routes its byline", () => {
    const withAuthor: Post = { ...rssBase, author: { ...rssBase.author, id: "xa-1" } };
    expect(resolveSpec("feed", "D", withAuthor).bylineProfile).toBe(true);
  });
  it("a biddability-D rss post with NO author record stays plain text", () => {
    expect(resolveSpec("feed", "D", rssBase).bylineProfile).toBe(false);
  });
});

// D9 + Q1 (S5): the byline row exists only for a post that names someone. A
// genuine tier-D post (no pubkey, no record, no name, no handle) has no byline;
// the timestamp moves to the provenance line wherever the level renders one.
describe("resolveSpec — showByline / originTagTime (BYLINE-AND-PROVENANCE S5)", () => {
  const tierD: Post = {
    ...native,
    author: { ...native.author, id: null, pubkey: null, displayName: null, handle: null },
    origin: { ...native.origin, protocol: "rss", sourceName: "Simon Willison's Weblog" },
  };
  it("a post with no author identity at all has no byline row at feed level", () => {
    const r = resolveSpec("feed", "D", tierD);
    expect(r.showByline).toBe(false);
    expect(r.originTagTime).toBe(true);
    expect(r.showOriginTag).toBe(true);
  });
  it("the source name is not an author identity (D9)", () => {
    // Same post, sourceName present — must not resurrect the byline.
    expect(resolveSpec("focal", "D", tierD).showByline).toBe(false);
  });
  it("a name alone (record-less, rss) keeps the byline", () => {
    const named: Post = { ...tierD, author: { ...tierD.author, displayName: "Aditya Chakrabortty" } };
    const r = resolveSpec("feed", "D", named);
    expect(r.showByline).toBe(true);
    expect(r.originTagTime).toBe(false);
  });
  it("a record alone (nameless data gap) keeps the byline, with its protocol fallback", () => {
    const rec: Post = { ...tierD, author: { ...tierD.author, id: "xa-9" }, origin: { ...tierD.origin, protocol: "atproto" } };
    expect(resolveSpec("feed", "B", rec).showByline).toBe(true);
  });
  it("a handle alone keeps the byline", () => {
    const h: Post = { ...tierD, author: { ...tierD.author, handle: "@x" } };
    expect(resolveSpec("feed", "D", h).showByline).toBe(true);
  });
  it("native always has a byline and never a provenance-line time", () => {
    const r = resolveSpec("feed", "A", native);
    expect(r.showByline).toBe(true);
    expect(r.originTagTime).toBe(false);
  });
  it("where the level has no provenance line the row stays as the timestamp's home", () => {
    const r = resolveSpec("quoted", "D", tierD);
    expect(r.showOriginTag).toBe(false);
    expect(r.showByline).toBe(true);
    expect(r.originTagTime).toBe(false);
  });
});

describe("resolveSpec — quoted level", () => {
  const r = resolveSpec("quoted", "A", native);
  it("quoted shows byline+body only: no actions, no origin tag, no counters, stub quote", () => {
    expect(r.haus).toBe("none");
    expect(r.showOriginTag).toBe(false);
    expect(r.originCounters).toBe("none");
    expect(r.quoteEmbed).toBe("stub");
    expect(r.media).toBe("single-thumbnail");
    expect(r.insideHost).toBe(true);
  });
});

describe("resolveSpec — condensed level", () => {
  const r = resolveSpec("condensed", "A", native);
  it("condensed actions are numerals-only and counters inline", () => {
    expect(r.haus).toBe("numerals-only");
    expect(r.originCounters).toBe("none"); // native has no origin counters anyway
    expect(r.media).toBe("none");
    expect(r.body).toBe("one-line");
  });
});

describe("resolveSpec — all.haus available at every tier (§7)", () => {
  for (const t of ["A", "B", "C", "D"] as BiddabilityTier[]) {
    it(`tier ${t} keeps haus=full at feed level`, () => {
      expect(resolveSpec("feed", t, external(t)).haus).toBe("full");
    });
  }
});

describe("resolveSpec — report is native-only", () => {
  it("native feed shows report", () => {
    expect(resolveSpec("feed", "A", native).showReport).toBe(true);
  });
  it("external tier-A feed does NOT show report", () => {
    expect(resolveSpec("feed", "A", external("A")).showReport).toBe(false);
  });
});

describe("resolveSpec — origin counters gate by tier", () => {
  it("external A/B parent level shows static counters", () => {
    expect(resolveSpec("thread-parent", "B", external("B")).originCounters).toBe("static");
  });
  it("external C parent level has no counters", () => {
    expect(resolveSpec("thread-parent", "C", external("C")).originCounters).toBe("none");
  });
});

describe("resolveSpec — articles override click to reader-pane", () => {
  it("article at feed level → reader-pane (not expand-focal)", () => {
    expect(resolveSpec("feed", "A", makePost({ type: "article" })).click).toBe("reader-pane");
  });
  it("note at feed level → expand-focal", () => {
    expect(resolveSpec("feed", "A", native).click).toBe("expand-focal");
  });
});

// SOCIAL-PROOF-RESONANCE-ADR D7 — the glyph is level-gated AND data-gated.
describe("resonance glyph (D7)", () => {
  const banded = (band: number | null | undefined) =>
    makePost({ resonanceBand: band });

  it("shows at feed and thread-focal levels only", () => {
    for (const lvl of ALL_LEVELS) {
      const shown = resolveSpec(lvl, "A", banded(2)).showResonance;
      expect(shown).toBe(lvl === "feed" || lvl === "focal");
    }
  });

  it("shows for bands 1-3 and never for band 0", () => {
    expect(resolveSpec("feed", "A", banded(1)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(2)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(3)).showResonance).toBe(true);
    expect(resolveSpec("feed", "A", banded(0)).showResonance).toBe(false);
  });

  // Absence is not zero (D4): an unscored / rss / dark-nostr row carries no
  // band at all. It renders nothing, same as band 0, but must never throw or
  // be coerced into a band by a stray COALESCE upstream.
  it("treats a missing band as no glyph", () => {
    expect(resolveSpec("feed", "A", banded(null)).showResonance).toBe(false);
    expect(resolveSpec("feed", "A", banded(undefined)).showResonance).toBe(false);
    expect(resolveSpec("feed", "A", makePost()).showResonance).toBe(false);
  });

  // Resonance measures response, not identity — so it is NOT tier-masked the
  // way origin counters are. Silence for rss/email comes from no band being
  // computed, not from a mask here.
  it("is not tier-masked", () => {
    for (const tier of ["A", "B", "C", "D"] as BiddabilityTier[]) {
      expect(resolveSpec("feed", tier, banded(3)).showResonance).toBe(true);
    }
  });
});
