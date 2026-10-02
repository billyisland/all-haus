import { describe, it, expect } from "vitest";
import { collectDescendants, rankTopLevel } from "../src/lib/thread-walk.js";

// Minimal node shape the walk needs (the real CommentRow has more fields).
type Node = { derived_post_id: string; label: string };

function adjacency(edges: Array<[string, Node]>): Map<string, Node[]> {
  const m = new Map<string, Node[]>();
  for (const [parentId, node] of edges) {
    (m.get(parentId) ?? m.set(parentId, []).get(parentId)!).push(node);
  }
  return m;
}

describe("collectDescendants (P0-2 cycle guard)", () => {
  it("returns [] for a focal with no children", () => {
    expect(collectDescendants("F", new Map())).toEqual([]);
  });

  it("flattens a well-formed tree depth-first, each node exactly once", () => {
    //        F
    //      /   \
    //     a     b
    //    / \
    //   c   d
    const a = { derived_post_id: "a", label: "a" };
    const b = { derived_post_id: "b", label: "b" };
    const c = { derived_post_id: "c", label: "c" };
    const d = { derived_post_id: "d", label: "d" };
    const childrenOf = adjacency([
      ["F", a],
      ["F", b],
      ["a", c],
      ["a", d],
    ]);

    const out = collectDescendants("F", childrenOf);
    // DFS: a, then a's children c,d, then b.
    expect(out.map((n) => n.label)).toEqual(["a", "c", "d", "b"]);
    // no node appears twice
    expect(new Set(out.map((n) => n.label)).size).toBe(out.length);
  });

  it("walks a deep linear chain fully", () => {
    const edges: Array<[string, Node]> = [];
    let parent = "F";
    for (let i = 0; i < 500; i++) {
      const id = `n${i}`;
      edges.push([parent, { derived_post_id: id, label: id }]);
      parent = id;
    }
    const out = collectDescendants("F", adjacency(edges));
    expect(out).toHaveLength(500);
    expect(out[0].label).toBe("n0");
    expect(out[499].label).toBe("n499");
  });

  it("terminates on a 2-node cycle instead of recursing forever", () => {
    // a -> b -> a (corrupt: b has a child whose post_id loops back to a)
    const a = { derived_post_id: "a", label: "a" };
    const b = { derived_post_id: "b", label: "b" };
    const aAgain = { derived_post_id: "a", label: "a-cycle" };
    const childrenOf = adjacency([
      ["F", a],
      ["a", b],
      ["b", aAgain], // cycle edge back to "a"
    ]);

    const out = collectDescendants("F", childrenOf);
    // a expanded once, b once; the cycle edge node is emitted but "a" is not
    // re-expanded — so the walk is finite.
    expect(out.map((n) => n.label)).toEqual(["a", "b", "a-cycle"]);
  });

  it("terminates on a self-parent (node is its own child)", () => {
    const x = { derived_post_id: "x", label: "x" };
    const xSelf = { derived_post_id: "x", label: "x-self" };
    const childrenOf = adjacency([
      ["F", x],
      ["x", xSelf], // x is its own child
    ]);

    const out = collectDescendants("F", childrenOf);
    expect(out.map((n) => n.label)).toEqual(["x", "x-self"]);
  });

  it("does not blow the stack on a large cycle", () => {
    // A long chain whose tail loops back to the head. Without the guard this
    // recurses unboundedly; with it, it terminates after one pass.
    const edges: Array<[string, Node]> = [];
    let parent = "F";
    for (let i = 0; i < 2000; i++) {
      const id = `c${i}`;
      edges.push([parent, { derived_post_id: id, label: id }]);
      parent = id;
    }
    // tail's child loops back to the first node "c0"
    edges.push([parent, { derived_post_id: "c0", label: "loop" }]);

    const childrenOf = adjacency(edges);
    let out: Node[] = [];
    expect(() => {
      out = collectDescendants("F", childrenOf);
    }).not.toThrow();
    // 2000 chain nodes + 1 loop node, finite.
    expect(out).toHaveLength(2001);
  });
});

describe("rankTopLevel (the article foot's rest state)", () => {
  type C = {
    derived_post_id: string;
    published_at_epoch: number;
    id: string;
    hidden?: boolean;
  };
  const c = (id: string, t: number, hidden = false): C => ({
    derived_post_id: id,
    published_at_epoch: t,
    id: `00000000-0000-0000-0000-00000000000${t % 10}`,
    hidden,
  });
  const counted = (n: C) => !n.hidden;
  const shown = (n: C) => !n.hidden;

  it("ranks direct replies by subtree size, ties newest first, previews chronological", () => {
    const a = c("a", 1), b = c("b", 2), d = c("d", 3), e = c("e", 4);
    const a1 = c("a1", 5), a2 = c("a2", 6), a3 = c("a3", 7), a1x = c("a1x", 8);
    const e1 = c("e1", 9);
    const childrenOf = adjacency_([
      ["R", a], ["R", b], ["R", d], ["R", e],
      ["a", a3], ["a", a1], ["a", a2], ["a1", a1x],
      ["e", e1],
    ]);
    const out = rankTopLevel("R", childrenOf, counted, shown, 2);
    // a has four below it; e has one; b and d have none (d newer, so first).
    expect(out.map((r) => [r.node.derived_post_id, r.count])).toEqual([
      ["a", 4], ["e", 1], ["d", 0], ["b", 0],
    ]);
    // previews are a's first two DIRECT replies by time — never a grandchild.
    expect(out[0].previews.map((p) => p.derived_post_id)).toEqual(["a1", "a2"]);
  });

  it("drops a hidden reply that answers nothing, keeps one that has answers", () => {
    const h = c("h", 1, true), k = c("k", 2, true), k1 = c("k1", 3);
    const childrenOf = adjacency_([["R", h], ["R", k], ["k", k1]]);
    const out = rankTopLevel("R", childrenOf, counted, shown, 2);
    expect(out.map((r) => r.node.derived_post_id)).toEqual(["k"]);
    expect(out[0].count).toBe(1);
  });

  function adjacency_(edges: Array<[string, C]>): Map<string, C[]> {
    const m = new Map<string, C[]>();
    for (const [p, n] of edges) (m.get(p) ?? m.set(p, []).get(p)!).push(n);
    return m;
  }
});
