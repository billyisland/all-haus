import { describe, it, expect } from "vitest";
import { interactionCaps } from "./usePostInteractions";

describe("interactionCaps — §7 interact-back gate + protocol guards", () => {
  it("inert when not active (native / tier C-D / no external id)", () => {
    const c = interactionCaps("atproto", true, false);
    expect(c.likeEnabled).toBe(false);
    expect(c.repostEnabled).toBe(false);
    expect(c.replyEnabled).toBe(false);
    expect(c.likeDisabled).toBe(false);
    expect(c.repostDisabled).toBe(false);
    expect(c.replyDisabled).toBe(false);
  });

  it("atproto/activitypub with a linked account: all enabled", () => {
    for (const proto of ["atproto", "activitypub"]) {
      const c = interactionCaps(proto, true, true);
      expect(c.likeEnabled).toBe(true);
      expect(c.repostEnabled).toBe(true);
      expect(c.replyEnabled).toBe(true);
    }
  });

  it("allowed but no linked account: disabled affordance, not enabled", () => {
    const c = interactionCaps("atproto", false, true);
    expect(c.likeEnabled).toBe(false);
    expect(c.likeDisabled).toBe(true);
    expect(c.repostDisabled).toBe(true);
    expect(c.replyDisabled).toBe(true);
  });

  it("nostr_external suppresses repost only (like + reply remain)", () => {
    const c = interactionCaps("nostr_external", true, true);
    expect(c.likeEnabled).toBe(true);
    expect(c.replyEnabled).toBe(true);
    expect(c.repostAllowed).toBe(false);
    expect(c.repostEnabled).toBe(false);
    expect(c.repostDisabled).toBe(false); // not even shown
  });

  it("rss / email suppress like + reply + repost entirely", () => {
    for (const proto of ["rss", "email"]) {
      const c = interactionCaps(proto, true, true);
      expect(c.likeAllowed).toBe(false);
      expect(c.replyAllowed).toBe(false);
      expect(c.repostAllowed).toBe(false);
      expect(c.likeDisabled).toBe(false);
      expect(c.replyDisabled).toBe(false);
      expect(c.repostDisabled).toBe(false);
    }
  });
});
