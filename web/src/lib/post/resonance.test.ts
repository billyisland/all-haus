import { describe, it, expect } from "vitest";
import { authorMark, platformMark, PLATFORM_P90 } from "./resonance";
import { resolveSpec } from "./level-spec";
import type { Level, Post } from "./types";

function makePost(over: Partial<Post> = {}): Post {
  return {
    id: "p1",
    version: "p1",
    origin: { protocol: "atproto", uri: "u", sourceName: "Src", publication: null },
    author: {
      id: "a1",
      accountId: null,
      displayName: "Jane",
      handle: "jane.bsky.social",
      handleUri: null,
      pubkey: null,
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

describe("authorMark — four stored bands, two rendered senses", () => {
  it("collapses bands 1 and 2 to the modest mark and 3 to the loud one", () => {
    expect(authorMark(makePost({ resonanceBand: 1 }))).toBe("noticed");
    expect(authorMark(makePost({ resonanceBand: 2 }))).toBe("noticed");
    expect(authorMark(makePost({ resonanceBand: 3 }))).toBe("high");
  });

  it("renders nothing for band 0 AND for no band — different claims, same silence", () => {
    expect(authorMark(makePost({ resonanceBand: 0 }))).toBeNull();
    expect(authorMark(makePost({ resonanceBand: null }))).toBeNull();
    expect(authorMark(makePost({}))).toBeNull();
  });
});

describe("platformMark — the p90 cut, and absence is not zero", () => {
  it("lights at exactly p90 and not a hair below", () => {
    expect(platformMark(makePost({ ambientPctl: PLATFORM_P90 }))).toBe(true);
    expect(platformMark(makePost({ ambientPctl: PLATFORM_P90 - 0.0001 }))).toBe(false);
  });

  it("lights across the saturated top of the range", () => {
    expect(platformMark(makePost({ ambientPctl: 0.95 }))).toBe(true);
    expect(platformMark(makePost({ ambientPctl: 1 }))).toBe(true);
  });

  // The bug this guards: a null pctl means NO BAND WAS COMPUTED for the row
  // (rss/email, dark nostr, unscored) — a numeric coercion of null is 0, which
  // is a claim about a quiet post rather than the absence of any claim. It
  // must never light, and it must never be confused with a real 0.
  it("treats absence as absence, never as a low score", () => {
    expect(platformMark(makePost({ ambientPctl: null }))).toBe(false);
    expect(platformMark(makePost({}))).toBe(false);
    expect(platformMark(makePost({ ambientPctl: 0 }))).toBe(false);
  });
});

describe("resolveSpec — the two axes are independent", () => {
  it("shows the platform mark on a post with NO author band at all", () => {
    // The case the platform mark exists for: a large account's ordinary post
    // that is still an event for the network. Silent before this shipped.
    const s = resolveSpec("feed", "A", makePost({ resonanceBand: 0, ambientPctl: 0.97 }));
    expect(s.showResonance).toBe(false);
    expect(s.showPlatformResonance).toBe(true);
  });

  it("shows the author mark on a post that is ordinary for its network", () => {
    const s = resolveSpec("feed", "A", makePost({ resonanceBand: 3, ambientPctl: 0.2 }));
    expect(s.showResonance).toBe(true);
    expect(s.showPlatformResonance).toBe(false);
  });

  it("shows both when both axes earn it", () => {
    const s = resolveSpec("feed", "A", makePost({ resonanceBand: 3, ambientPctl: 0.95 }));
    expect(s.showResonance).toBe(true);
    expect(s.showPlatformResonance).toBe(true);
  });
});

describe("resolveSpec — the platform mark follows the RESONANCE level gate, not the origin tag's", () => {
  const lit = makePost({ resonanceBand: 3, ambientPctl: 0.99 });

  it("rides feed and focal", () => {
    for (const level of ["feed", "focal"] as Level[]) {
      expect(resolveSpec(level, "A", lit).showPlatformResonance).toBe(true);
    }
  });

  // Load-bearing: `originTag` is TRUE at thread-parent/thread-reply, so hanging
  // the mark off the tag's own gate would scatter it through an expanded
  // conversation — the exact context the D7 level rule excludes, since
  // band-at-a-glance earns its space where the reader is deciding whether to
  // read, not around something they are already reading.
  it("is OFF at every level the tag renders but resonance does not", () => {
    for (const level of ["thread-parent", "thread-reply"] as Level[]) {
      const s = resolveSpec(level, "A", lit);
      expect(s.showOriginTag).toBe(true);
      expect(s.showPlatformResonance).toBe(false);
    }
  });

  it("is off on quoted and condensed", () => {
    for (const level of ["quoted", "condensed"] as Level[]) {
      expect(resolveSpec(level, "A", lit).showPlatformResonance).toBe(false);
    }
  });
});
