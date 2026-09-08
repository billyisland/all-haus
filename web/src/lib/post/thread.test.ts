import { describe, it, expect } from "vitest";
import { deriveThreadView } from "./thread";
import type { Post } from "./types";

// Minimal Post factory — only the fields deriveThreadView reads matter.
function p(
  id: string,
  inReplyTo: string | null,
  publishedAt: number,
): Post {
  return {
    id,
    version: id,
    origin: { protocol: "nostr", uri: id, sourceName: null, publication: null },
    author: {
      id: null,
      accountId: null,
      displayName: null,
      handle: null,
      handleUri: null,
      pubkey: "pk",
      pipStatus: "unknown",
    },
    type: "note",
    accessMode: "free",
    body: {
      text: id,
      html: null,
      title: null,
      summary: null,
      media: [],
      contentWarning: null,
      poll: null,
    },
    inReplyTo,
    quotes: null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: "A",
    publishedAt,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: null,
    externalItemId: null,
  };
}

function poolOf(...posts: Post[]): Map<string, Post> {
  return new Map(posts.map((x) => [x.id, x]));
}

// root → a → b (chain), root → c (sibling of a)
//   root(0) ── a(10) ── b(20)
//          └── c(15)
const root = p("root", null, 0);
const a = p("a", "root", 10);
const b = p("b", "a", 20);
const c = p("c", "root", 15);

describe("deriveThreadView", () => {
  it("returns null when the focal is not in the pool", () => {
    expect(deriveThreadView(poolOf(root), "missing")).toBeNull();
  });

  it("walks ancestors root-first and flattens the subtree chronologically", () => {
    const view = deriveThreadView(poolOf(root, a, b, c), "root");
    expect(view).not.toBeNull();
    expect(view!.focal.id).toBe("root");
    expect(view!.ancestors).toEqual([]);
    // a(10), c(15), b(20) — global chronological flatten across all depths.
    expect(view!.descendants.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  it("re-roots: same pool, focal = a → root is the sole ancestor, b the lone reply", () => {
    const view = deriveThreadView(poolOf(root, a, b, c), "a");
    expect(view!.focal.id).toBe("a");
    expect(view!.ancestors.map((x) => x.id)).toEqual(["root"]);
    expect(view!.descendants.map((x) => x.id)).toEqual(["b"]);
  });

  it("re-roots onto a leaf: no descendants, full ancestor chain root→a", () => {
    const view = deriveThreadView(poolOf(root, a, b, c), "b");
    expect(view!.ancestors.map((x) => x.id)).toEqual(["root", "a"]);
    expect(view!.descendants).toEqual([]);
  });

  it("stops the ancestor walk at a gap (parent missing from pool)", () => {
    // b's parent `a` is absent; the walk yields nothing rather than throwing.
    const view = deriveThreadView(poolOf(b, root), "b");
    expect(view!.ancestors).toEqual([]);
  });

  it("is cycle-safe (self-reference / mutual parents do not loop)", () => {
    const x = p("x", "y", 1);
    const y = p("y", "x", 2);
    const view = deriveThreadView(poolOf(x, y), "x");
    // Walk halts once it revisits a seen id; it does not hang.
    expect(view!.ancestors.length).toBeLessThanOrEqual(1);
  });

  it("breaks descendant ties on id when publishedAt is equal", () => {
    const r = p("r", null, 0);
    const m = p("m", "r", 5);
    const n = p("n", "r", 5);
    const view = deriveThreadView(poolOf(r, m, n), "r");
    expect(view!.descendants.map((x) => x.id)).toEqual(["m", "n"]);
  });
});
