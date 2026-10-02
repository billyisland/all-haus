import { describe, it, expect } from "vitest";
import {
  init,
  step,
  settle,
  arrival,
  refreshed,
  refreshedEmpty,
  hide,
  restore,
  reconcile,
  tier,
  cmp,
  factsOf,
  queueViolations,
  feedSetChanged,
  sameQueue,
  type QueueState,
  type Toggle,
  type FeedFacts,
  type Facts,
} from "./queue";

// WORKSPACE-QUEUE-ADR §V. The fixtures pin the reasoning (§V.5, §V.4, one
// block per operation); the randomised corpus at the bottom guards the
// universal claim — every live invariant after every operation of any
// sequence, walks and `step(−1)` included.

type Counts = { rank: number; n?: number; u?: number; hidden?: boolean };

function world(spec: Record<string, Counts>): Map<string, FeedFacts> {
  const m = new Map<string, FeedFacts>();
  for (const [id, c] of Object.entries(spec)) {
    m.set(id, {
      id,
      sortRank: c.rank,
      hidden: c.hidden ?? false,
      newCount: c.n ?? 0,
      unreadCount: Math.max(c.u ?? 0, c.n ?? 0),
    });
  }
  return m;
}

function set(facts: Map<string, FeedFacts>, id: string, patch: Partial<FeedFacts>) {
  facts.set(id, { ...(facts.get(id) as FeedFacts), ...patch });
}

function legal(s: QueueState, facts: Facts, afterSort: boolean) {
  expect(queueViolations(s, facts, afterSort)).toEqual([]);
}

const state = (keys: string[], focal: string | null, settled: string[] = []): QueueState => ({
  keys,
  focal,
  settled: new Set(settled),
});

describe("tier and cmp", () => {
  it("tiers by new, then unread", () => {
    const f = world({ a: { rank: 1, n: 1 }, b: { rank: 1, u: 1 }, c: { rank: 1 } });
    expect([tier(f.get("a")!), tier(f.get("b")!), tier(f.get("c")!)]).toEqual([0, 1, 2]);
  });

  it("is a total order: tier, then rank, then id", () => {
    const f = world({ a: { rank: 2, n: 1 }, b: { rank: 1, u: 1 }, x: { rank: 1 }, y: { rank: 1 } });
    expect(cmp(f.get("a")!, f.get("b")!)).toBeLessThan(0); // tier beats rank
    expect(cmp(f.get("x")!, f.get("y")!)).toBeLessThan(0); // id breaks a tie
    expect(cmp(f.get("y")!, f.get("x")!)).toBeGreaterThan(0);
    expect(cmp(f.get("x")!, f.get("x")!)).toBe(0);
  });

  it("factsOf keys by id", () => {
    const f = factsOf([{ id: "a", sortRank: 1, hidden: false, newCount: 0, unreadCount: 0 }]);
    expect(f.get("a")?.sortRank).toBe(1);
  });
});

describe("§V.5 worked examples", () => {
  // Feeds A…F have sortRank 1…6: A, D, F new; B unread only; C, E nothing.
  // G is hidden throughout, and so never in the keys.
  const start = () =>
    world({
      A: { rank: 1, n: 1 },
      B: { rank: 2, u: 2 },
      C: { rank: 3 },
      D: { rank: 4, n: 1 },
      E: { rank: 5 },
      F: { rank: 6, n: 1 },
      G: { rank: 7, hidden: true },
    });

  it("walks the whole sequence", () => {
    const f = start();

    let s = init(f);
    expect(s.keys).toEqual(["A", "D", "F", "B", "C", "E"]);
    expect(s.focal).toBe("A");
    legal(s, f, true);

    s = settle(s, "A");
    s = step(s, 1);
    s = step(s, 1);
    expect(s.focal).toBe("F");
    expect(s.keys.slice(0, 2)).toEqual(["A", "D"]);
    expect([...s.settled]).toEqual(["A"]);
    legal(s, f, false);

    // Dwell on F; E gets an arrival. D is a skipped tier-0 line and rejoins.
    s = settle(s, "F");
    set(f, "E", { newCount: 1, unreadCount: 1 });
    s = arrival(s, "E", f);
    expect(s.keys).toEqual(["A", "F", "D", "E", "B", "C"]);
    expect(s.focal).toBe("F");
    legal(s, f, true);

    // Pull on F finds nothing but F is still tier 1: focal stays, nothing moves.
    set(f, "F", { newCount: 0, unreadCount: 3 });
    const before = s.keys;
    s = refreshedEmpty(s, "F", f);
    expect(s.focal).toBe("F");
    expect(s.keys).toEqual(before);

    // All of F passed (tier 2); an empty pull now advances to the key after F.
    set(f, "F", { unreadCount: 0 });
    s = refreshedEmpty(s, "F", f);
    expect(s.focal).toBe("D");
    expect(s.keys.slice(0, 2)).toEqual(["A", "F"]);
    legal(s, f, true);

    s = step(s, -1);
    expect(s.focal).toBe("F");
    expect(s.keys[2]).toBe("D");

    // Hide F while focal: focus passes to the key now at its old index.
    set(f, "F", { hidden: true });
    s = hide(s, "F");
    expect(s.keys).toEqual(["A", "D", "E", "B", "C"]);
    expect(s.focal).toBe("D");
    expect([...s.settled]).toEqual(["A"]);
    legal(s, f, false);

    // Restore F while focal is D: nothing unread, sorts after C, so last.
    set(f, "F", { hidden: false });
    s = restore(s, "F", f);
    expect(s.keys).toEqual(["A", "D", "E", "B", "C", "F"]);
    legal(s, f, false);

    // Invariant 7. A gets an arrival: it leaves the lines AND settled.
    set(f, "A", { newCount: 1, unreadCount: 1 });
    s = arrival(s, "A", f);
    expect(s.keys).toEqual(["D", "A", "E", "B", "C", "F"]);
    expect(s.settled.has("A")).toBe(false);
    legal(s, f, true);

    // Walk to E without dwelling on A: A is a skipped line again, and the
    // next sort brings it back — under the old rule it stayed buried.
    s = step(step(s, 1), 1);
    expect(s.focal).toBe("E");
    expect(s.keys.indexOf("A")).toBeLessThan(s.keys.indexOf("E"));
    s = reconcile(s, f);
    expect(s.keys.indexOf("A")).toBeGreaterThan(s.keys.indexOf("E"));
    legal(s, f, true);
  });
});

describe("§V.4 the sanctioned unsorted states", () => {
  const f = world({
    a: { rank: 1, n: 1 },
    b: { rank: 2, n: 1 },
    c: { rank: 3, n: 1 },
    d: { rank: 4 },
    e: { rank: 5, u: 1 },
  });

  it("a walk left of k steps leaves k feeds at the front of ahead, in their original order", () => {
    let s = init(f); // [a b c e d]
    s = step(step(step(s, 1), 1), 1); // focal e
    s = step(step(s, -1), -1); // focal b
    expect(s.focal).toBe("b");
    expect(s.keys.slice(2)).toEqual(["c", "e", "d"]);
    // Sorted when walked, but the walk does not keep it so: once c has nothing
    // unread, the front of ahead is out of `cmp` order.
    const g = new Map(f);
    set(g, "c", { newCount: 0, unreadCount: 0 });
    expect(queueViolations(s, g, true)).toContain("4: c before e");
    // …and it stays that way until a trigger sorts it.
    const t = settle(step(s, 1), "c");
    expect(t.keys).toEqual(s.keys);
    expect(queueViolations(reconcile(s, g), g, true)).toEqual([]);
  });

  it("step(−1) puts the old focal at the front of ahead whatever its tier, and unsettles it", () => {
    let s = init(f);
    s = settle(s, "a");
    s = step(s, 1);
    s = settle(s, "b");
    s = step(s, -1);
    expect(s.focal).toBe("a");
    expect(s.keys[1]).toBe("b");
    expect(s.settled.has("b")).toBe(false);
    expect(s.settled.has("a")).toBe(true);
  });

  it("restore inserts without sorting the others", () => {
    const g = world({
      a: { rank: 1, n: 1 },
      b: { rank: 2 },
      c: { rank: 3, n: 1 },
      x: { rank: 9, u: 1 },
    });
    // An unsorted ahead left by a walk: [b c] with b tier 2 before c tier 0.
    const s = state(["a", "b", "c"], "a");
    const t = restore(s, "x", g);
    // x (tier 1) sorts before b (tier 2): first such index, and c is not moved.
    expect(t.keys).toEqual(["a", "x", "b", "c"]);
  });
});

describe("step", () => {
  const f = world({ a: { rank: 1 }, b: { rank: 2 }, h: { rank: 3, hidden: true } });

  it("stops at both ends, returning the same state", () => {
    const s = init(f);
    expect(step(s, -1)).toBe(s);
    const end = step(s, 1);
    expect(end.focal).toBe("b"); // a hidden feed is never walked to
    expect(step(end, 1)).toBe(end);
  });

  it("is a no-op on an empty queue", () => {
    const s = init(new Map());
    expect(s).toEqual({ keys: [], focal: null, settled: new Set() });
    expect(step(s, 1)).toBe(s);
  });
});

describe("settle", () => {
  const f = world({ a: { rank: 1 }, b: { rank: 2 }, h: { rank: 3, hidden: true } });

  it("records only the focal feed, once", () => {
    const s = init(f);
    const t = settle(s, "a");
    expect([...t.settled]).toEqual(["a"]);
    expect(settle(t, "a")).toBe(t);
    expect(settle(s, "b")).toBe(s); // a timer that outlived its stay
  });

  it("never settles a hidden feed", () => {
    const s = init(f);
    expect(settle(s, "h")).toBe(s);
  });
});

describe("arrival", () => {
  it("on the focal feed sorts the feeds ahead", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = init(f);
    set(f, "c", { newCount: 1, unreadCount: 1 });
    expect(arrival(s, "a", f).keys).toEqual(["a", "c", "b"]);
  });

  it("ignores a hidden or unknown feed", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true } });
    const s = init(f);
    expect(arrival(s, "h", f)).toBe(s);
    expect(arrival(s, "zz", f)).toBe(s);
  });

  it("on a feed ahead sorts it into place", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = init(f);
    set(f, "c", { newCount: 1, unreadCount: 1 });
    expect(arrival(s, "c", f).keys).toEqual(["a", "c", "b"]);
  });

  it("on a line at the far end, brings it back ahead of focal", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, h: { rank: 3, hidden: true } });
    let s = settle(init(f), "a");
    s = step(s, 1);
    expect(s.focal).toBe("b");
    set(f, "a", { newCount: 1, unreadCount: 1 });
    s = arrival(s, "a", f);
    expect(s.keys).toEqual(["b", "a"]);
    expect(s.settled.has("a")).toBe(false);
    legal(s, f, true);
  });
});

describe("refreshed", () => {
  it("on the focal feed sorts", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = init(f);
    set(f, "c", { unreadCount: 1 });
    expect(refreshed(s, "a", f).keys).toEqual(["a", "c", "b"]);
  });

  it("after focal has moved on, is an arrival on that feed", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    let s = settle(init(f), "a");
    s = step(s, 1);
    set(f, "a", { newCount: 2, unreadCount: 2 });
    s = refreshed(s, "a", f);
    expect(s.keys).toEqual(["b", "a", "c"]);
    expect(s.settled.has("a")).toBe(false);
  });
});

describe("refreshedEmpty", () => {
  it("stays when nothing is ahead but a hidden feed", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true } });
    const s = init(f);
    expect(refreshedEmpty(s, "a", f).focal).toBe("a");
  });

  it("stays when nothing is ahead at all", () => {
    const f = world({ a: { rank: 1 } });
    expect(refreshedEmpty(init(f), "a", f).focal).toBe("a");
  });

  it("sorts but does not move when the feed is no longer focal", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = step(init(f), 1);
    set(f, "a", { unreadCount: 1 });
    set(f, "c", { unreadCount: 1 });
    const t = refreshedEmpty(s, "a", f);
    expect(t.focal).toBe("b");
    expect(t.keys).toEqual(["b", "a", "c"]); // a, a skipped line with unread, rejoins
  });

  it("advances to the first feed ahead AFTER sorting", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = init(f);
    set(f, "c", { newCount: 1, unreadCount: 1 });
    expect(refreshedEmpty(s, "a", f).focal).toBe("c");
  });
});

describe("hide", () => {
  const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });

  it("ignores an id not in the queue", () => {
    const s = init(f);
    expect(hide(s, "zz")).toBe(s);
    const t = hide(s, "a");
    expect(hide(t, "a")).toBe(t);
  });

  it("keeps focal when another feed is hidden", () => {
    let s = init(f);
    s = hide(s, "b");
    expect(s).toEqual(state(["a", "c"], "a"));
    s = hide(s, "c");
    expect(s.keys).toEqual(["a"]);
  });

  it("hiding the last feed focuses the feed to its left", () => {
    let s = step(step(init(f), 1), 1); // focal c
    s = settle(s, "c");
    s = hide(s, "c");
    expect(s.focal).toBe("b");
    expect(s.settled.has("c")).toBe(false);
  });

  it("hiding the only feed empties the queue", () => {
    const s = hide(init(world({ a: { rank: 1 } })), "a");
    expect(s).toEqual(state([], null));
  });
});

describe("restore", () => {
  it("ignores a feed still hidden, unknown, or already present", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true } });
    const s = init(f);
    expect(restore(s, "h", f)).toBe(s);
    expect(restore(s, "zz", f)).toBe(s);
    expect(restore(s, "a", f)).toBe(s);
  });

  it("keeps focal where the reader is, and goes last when it sorts after everything", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true }, i: { rank: 3, hidden: true } });
    let s = init(f);
    set(f, "h", { hidden: false });
    s = restore(s, "h", f);
    expect(s).toEqual(state(["a", "h"], "a"));
    set(f, "i", { hidden: false });
    s = restore(s, "i", f);
    expect(s).toEqual(state(["a", "h", "i"], "a"));
    legal(s, f, false);
  });

  it("into an empty queue", () => {
    const f = world({ a: { rank: 1 } });
    expect(restore(init(new Map()), "a", f)).toEqual(state(["a"], "a"));
  });

  it("never sorts before an ahead key it has no facts for", () => {
    const f = world({ a: { rank: 1 }, c: { rank: 5 }, x: { rank: 0, n: 1 } });
    // b is in the keys but not in these facts (a deletion not yet reconciled).
    expect(restore(state(["a", "b", "c"], "a"), "x", f).keys).toEqual(["a", "b", "x", "c"]);
  });
});

describe("feedSetChanged (the host's feed set, §VII.11)", () => {
  // Hidden flags as the host holds them, in the facts' order.
  const shape = (f: Facts) => new Map([...f.values()].map((x) => [x.id, x.hidden]));
  // The host flips one feed; the diff sees `before → after` of its set.
  function flip(
    s: QueueState,
    f: Map<string, FeedFacts>,
    id: string,
    hidden: boolean,
    last: Toggle | null,
  ) {
    const prev = shape(f);
    set(f, id, { hidden });
    return feedSetChanged(s, prev, shape(f), f, last);
  }

  it("hiding focal lands on §V.3's key", () => {
    const f = world({ a: { rank: 1, n: 1 }, b: { rank: 2, n: 1 }, c: { rank: 3 } });
    const s = step(init(f), 1); // [a b c], focal b
    const r = flip(s, f, "b", true, null);
    expect(r.state).toEqual(state(["a", "c"], "c"));
    expect(r.toggle).toMatchObject({ feedId: "b", hidden: true, before: s });
    legal(r.state, f, false);
  });

  it("restoring leaves the reader where they are", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true }, i: { rank: 3, hidden: true } });
    const s = init(f);
    const r = flip(s, f, "h", false, null);
    expect(r.state).toEqual(state(["a", "h"], "a"));
  });

  it("a refused hide puts the reader back on the feed they hid", () => {
    const f = world({ a: { rank: 1, n: 1 }, b: { rank: 2, n: 1 }, c: { rank: 3 } });
    const s = settle(step(settle(init(f), "a"), 1), "b");
    const hid = flip(s, f, "b", true, null);
    expect(hid.state.focal).toBe("c");
    const back = flip(hid.state, f, "b", false, hid.toggle);
    expect(back.state).toBe(s);
    expect(back.toggle).toBeNull();
    // The inverse operation alone would have left focal on c, with b ahead.
    expect(restore(hid.state, "b", f).focal).toBe("c");
  });

  it("a refused restore takes the feed back out, exactly", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true } });
    const s = init(f);
    const shown = flip(s, f, "h", false, null);
    expect(shown.state).toEqual(state(["a", "h"], "a"));
    const back = flip(shown.state, f, "h", true, shown.toggle);
    expect(back.state).toBe(s);
    legal(back.state, f, false);
  });

  it("a revert after the queue has moved is the inverse operation", () => {
    const f = world({ a: { rank: 1, n: 1 }, b: { rank: 2, n: 1 }, c: { rank: 3 } });
    const s = step(init(f), 1); // focal b
    const hid = flip(s, f, "b", true, null);
    const moved = step(hid.state, -1); // the reader stepped back to a
    const back = flip(moved, f, "b", false, hid.toggle);
    expect(back.state).toEqual(restore(moved, "b", f));
    expect(back.state.focal).toBe("a");
  });

  it("a toggle of another feed, or in the same direction, is never taken for a revert", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = init(f);
    const hidB = flip(s, f, "b", true, null);
    // Hiding c next is its own hide, not an undo of b's.
    const hidC = flip(hidB.state, f, "c", true, hidB.toggle);
    expect(hidC.state).toEqual(hide(hidB.state, "c"));
    // Restoring b now is a restore: the queue is no longer what b's hide made.
    const shownB = flip(hidC.state, f, "b", false, hidB.toggle);
    expect(shownB.state).toEqual(restore(hidC.state, "b", f));
  });

  it("a created or deleted feed reconciles, and clears the last toggle", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 } });
    const s = init(f);
    const prev = shape(f);
    f.set("n", { id: "n", sortRank: 3, hidden: false, newCount: 1, unreadCount: 1 });
    f.delete("b");
    const r = feedSetChanged(s, prev, shape(f), f, null);
    expect(r.state).toEqual(reconcile(s, f));
    expect(r.toggle).toBeNull();
    legal(r.state, f, true);
  });

  it("sameQueue compares what a state says, not its identity", () => {
    const a = state(["a", "b"], "a", ["a"]);
    expect(sameQueue(a, state(["a", "b"], "a", ["a"]))).toBe(true);
    expect(sameQueue(a, state(["a", "b"], "b", ["a"]))).toBe(false);
    expect(sameQueue(a, state(["b", "a"], "a", ["a"]))).toBe(false);
    expect(sameQueue(a, state(["a", "b"], "a"))).toBe(false);
    expect(sameQueue(a, state(["a", "b"], "a", ["b"]))).toBe(false);
    expect(sameQueue(a, state(["a"], "a", ["a"]))).toBe(false);
  });
});

describe("reconcile", () => {
  it("drops deleted and hidden feeds, appends new ones", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    let s = init(f);
    f.delete("b");
    set(f, "c", { hidden: true });
    f.set("d", { id: "d", sortRank: 4, hidden: false, newCount: 1, unreadCount: 1 });
    s = reconcile(s, f);
    expect(s).toEqual(state(["a", "d"], "a"));
    f.delete("c");
    expect(reconcile(s, f).keys).toEqual(["a", "d"]);
  });

  it("a dropped focal passes to the key now at its old index", () => {
    const f = world({ a: { rank: 1 }, b: { rank: 2 }, c: { rank: 3 } });
    const s = step(init(f), 1); // focal b
    f.delete("b");
    expect(reconcile(s, f).focal).toBe("c");
    f.delete("c");
    expect(reconcile(s, f).focal).toBe("a"); // clamped
  });

  it("a feed restored elsewhere joins ahead, sorted", () => {
    const f = world({ a: { rank: 1 }, h: { rank: 2, hidden: true } });
    const s = init(f);
    set(f, "h", { hidden: false, newCount: 1, unreadCount: 1 });
    const t = reconcile(s, f);
    expect(t).toEqual(state(["a", "h"], "a"));
    legal(t, f, true);
  });

  it("an empty queue picks up its first feeds, and loses them again", () => {
    const f = world({});
    let s = reconcile(init(f), world({ a: { rank: 1 } }));
    expect(s).toEqual(state(["a"], "a"));
    s = reconcile(s, f);
    expect(s).toEqual(state([], null));
  });
});

describe("queueViolations", () => {
  const f = world({ a: { rank: 1, n: 1 }, b: { rank: 2 }, h: { rank: 3, hidden: true } });

  it("names each broken invariant", () => {
    const v = (s: QueueState, after = false) => queueViolations(s, f, after).map((m) => m[0]);
    expect(v(state(["a", "a", "b"], "a"))).toContain("1");
    expect(v(state(["b"], "b"))).toContain("1"); // a missing
    expect(v(state(["a", "b", "h"], "a"))).toContain("1"); // h hidden
    expect(v(state(["a", "b"], "a"))).toEqual([]); // a hidden feed needs nothing in the keys
    expect(v(state(["a", "b"], "zz"))).toContain("3");
    expect(v(state(["a", "b"], null))).toContain("3");
    expect(v(state(["a", "b"], "a", ["b"]))).toContain("7");
    expect(v(state(["a", "b"], "a", ["h"]))).toContain("7");
    expect(v(state(["a", "b"], "b"), true)).toEqual(["5"]); // a skipped with new
    const g = world({ a: { rank: 1 }, b: { rank: 2, n: 1 } });
    expect(queueViolations(state(["a", "a", "b"], "a"), g, true)).toContain("4: a before b");
  });
});

// ── The corpus ───────────────────────────────────────────────────────────────

describe("property: every live invariant after every operation", () => {
  // Deterministic PRNG (mulberry32) — reproducible failures, no flakes.
  function prng(seed: number) {
    let s = seed;
    return () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const lines = (s: QueueState) =>
    s.focal === null ? [] : s.keys.slice(0, s.keys.indexOf(s.focal));

  /** Invariant 6: feeds that are lines both before and after keep their order. */
  function linesKeepOrder(a: QueueState, b: QueueState) {
    const after = new Set(lines(b));
    const common = lines(a).filter((k) => after.has(k));
    const inB = lines(b).filter((k) => common.includes(k));
    expect(inB).toEqual(common);
  }

  /** A non-sorting operation reorders nothing: the keys common to both
   *  sides are in the same relative order. */
  function noReorder(a: QueueState, b: QueueState) {
    const inB = new Set(b.keys);
    const inA = new Set(a.keys);
    expect(b.keys.filter((k) => inA.has(k))).toEqual(a.keys.filter((k) => inB.has(k)));
  }

  it("holds over 400 random sessions of 60 operations", () => {
    const rand = prng(0x51ed270b);
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const hit: Record<string, number> = {};
    let nextId = 0;

    for (let run = 0; run < 400; run++) {
      const facts = new Map<string, FeedFacts>();
      const mint = () => {
        const id = `f${nextId++}`;
        facts.set(id, {
          id,
          sortRank: pick(1, 5), // collide on purpose: the id tiebreak must hold
          hidden: rand() < 0.15,
          newCount: rand() < 0.3 ? pick(1, 3) : 0,
          unreadCount: 0,
        });
        const f = facts.get(id)!;
        f.unreadCount = f.newCount + (rand() < 0.4 ? pick(1, 4) : 0);
      };
      for (let i = pick(0, 8); i > 0; i--) mint();

      let s = init(facts);
      legal(s, facts, true);

      for (let n = 0; n < 60; n++) {
        const ids = [...facts.keys()];
        const anyId = ids.length ? ids[pick(0, ids.length - 1)] : "none";
        const before = s;
        let sorted = false;
        const op = pick(0, 10);
        hit[op] = (hit[op] ?? 0) + 1;

        switch (op) {
          case 0:
          case 1:
            s = step(s, 1);
            break;
          case 2:
            s = step(s, -1);
            break;
          case 3:
            if (s.focal) s = settle(s, s.focal);
            break;
          case 4: {
            // Counts drift, then a poll reports an arrival somewhere.
            if (!ids.length) break;
            const f = facts.get(anyId)!;
            facts.set(anyId, { ...f, newCount: f.newCount + 1, unreadCount: f.unreadCount + 1 });
            s = arrival(s, anyId, facts);
            sorted = !facts.get(anyId)!.hidden; // a hidden feed's arrival is ignored
            break;
          }
          case 5: {
            // The reader passes posts in the focal feed, then pulls.
            if (!s.focal) break;
            const f = facts.get(s.focal)!;
            const passed = pick(0, f.unreadCount);
            facts.set(f.id, {
              ...f,
              unreadCount: f.unreadCount - passed,
              newCount: Math.min(f.newCount, f.unreadCount - passed),
            });
            s = rand() < 0.5 ? refreshedEmpty(s, f.id, facts) : refreshed(s, f.id, facts);
            sorted = true;
            break;
          }
          case 6: {
            // Hide a visible feed.
            const vis = s.keys;
            if (!vis.length) break;
            const id = vis[pick(0, vis.length - 1)];
            facts.set(id, { ...facts.get(id)!, hidden: true });
            s = hide(s, id);
            noReorder(before, s);
            break;
          }
          case 7: {
            // Restore a hidden feed.
            const hid = ids.filter((k) => facts.get(k)!.hidden);
            if (!hid.length) break;
            const id = hid[pick(0, hid.length - 1)];
            facts.set(id, { ...facts.get(id)!, hidden: false });
            s = restore(s, id, facts);
            noReorder(before, s);
            break;
          }
          case 8: {
            // The feed set changes underneath: delete, create, or flip hidden.
            const r = rand();
            if (r < 0.35 && ids.length) facts.delete(anyId);
            else if (r < 0.7) mint();
            else if (ids.length) facts.set(anyId, { ...facts.get(anyId)!, hidden: !facts.get(anyId)!.hidden });
            s = reconcile(s, facts);
            sorted = true;
            break;
          }
          case 9: {
            // A walk: a run of steps to a random key, dwelling on nothing.
            if (!s.keys.length) break;
            const target = s.keys[pick(0, s.keys.length - 1)];
            while (s.focal !== target) {
              const t = step(s, s.keys.indexOf(target) > s.keys.indexOf(s.focal!) ? 1 : -1);
              linesKeepOrder(s, t);
              s = t;
            }
            break;
          }
          case 10: {
            // Counts drift with no trigger: nothing sorts, nothing moves.
            if (!ids.length) break;
            const f = facts.get(anyId)!;
            facts.set(anyId, { ...f, newCount: 0, unreadCount: pick(0, 2) });
            const t = settle(step(s, 1), "not-focal");
            noReorder(s, t);
            s = t;
            break;
          }
        }

        const v = queueViolations(s, facts, sorted);
        if (v.length) {
          throw new Error(
            `run ${run} op ${n} (${op}): ${v.join("; ")}\n` +
              `before ${JSON.stringify({ ...before, settled: [...before.settled] })}\n` +
              `after  ${JSON.stringify({ ...s, settled: [...s.settled] })}`,
          );
        }
        linesKeepOrder(before, s);
        if ([0, 1, 2, 3, 6, 7, 9, 10].includes(op)) noReorder(before, s);
      }
    }
    // Every operation was exercised, many times.
    for (let op = 0; op <= 10; op++) expect(hit[op]).toBeGreaterThan(1000);
  });
});
