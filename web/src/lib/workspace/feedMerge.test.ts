import { describe, it, expect } from "vitest";
import { mergeFirstPage, type MergeItem } from "./feedMerge";

const P = 20;

/** A timeline, newest first, one post a minute. */
function timeline(n: number, prefix: string, newest = 1_000_000): MergeItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    publishedAt: newest - i * 60,
  }));
}

/** What the server would now answer: `fresh` posts arrived at the head, and
 *  each of `backdated` slotted in at its own `publishedAt`. */
function arrive(old: MergeItem[], fresh: number, backdated: MergeItem[] = []) {
  const head = timeline(fresh, "n", old[0].publishedAt + fresh * 60);
  return [...head, ...old, ...backdated].sort(
    (a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? -1 : 1),
  );
}

/** The result is a CONTIGUOUS run of the true timeline from its head: every
 *  post between the list's first and last is present, so nothing is counted
 *  that cannot be scrolled to. */
function expectNoHole(items: MergeItem[], truth: MergeItem[]) {
  expect(items.map((i) => i.id)).toEqual(truth.slice(0, items.length).map((i) => i.id));
}

describe("mergeFirstPage (§VI.5)", () => {
  const old = timeline(60, "o");
  const loaded = old.slice(0, 2 * P); // two pages paged down

  it("takes page one whole when nothing was loaded", () => {
    const r = mergeFirstPage([], old.slice(0, P), { pageSize: P });
    expect(r.outcome).toEqual({ kind: "first", newCount: P });
    expect(r.keepCursor).toBe(false);
    expect(r.items).toHaveLength(P);
  });

  it("splices a few arrivals onto the tail and keeps the tail's cursor", () => {
    const truth = arrive(old, 3);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
    expect(r.outcome).toEqual({ kind: "spliced", newCount: 3 });
    expect(r.keepCursor).toBe(true);
    expect(r.items).toHaveLength(2 * P + 3);
    expectNoHole(r.items, truth);
  });

  it("finds nothing new on an unchanged feed and changes nothing", () => {
    const r = mergeFirstPage(loaded, old.slice(0, P), { pageSize: P, window: old });
    expect(r.outcome).toEqual({ kind: "spliced", newCount: 0 });
    expect(r.items.map((i) => i.id)).toEqual(loaded.map((i) => i.id));
    expect(r.keepCursor).toBe(true);
  });

  it("25 injected arrivals RELOAD rather than splice a hole", () => {
    const truth = arrive(old, 25);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
    expect(r.outcome).toEqual({ kind: "reloaded", reason: "no-contact", newCount: P });
    expect(r.keepCursor).toBe(false);
    expect(r.items).toHaveLength(P);
    expectNoHole(r.items, truth);
  });

  it("a backdated window post inside the loaded range reloads", () => {
    // Between the 30th and 31st loaded posts: below page one, above the tail's
    // oldest — and page one still overlaps the loaded list.
    const back = { id: "b", publishedAt: old[30].publishedAt + 30 };
    const truth = arrive(old, 2, [back]);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
    expect(r.outcome).toEqual({ kind: "reloaded", reason: "backdated", newCount: 2 });
    expect(r.items).toHaveLength(P);
    expectNoHole(r.items, truth);
  });

  it("a backdated post below the loaded range splices — the cursor will reach it", () => {
    const back = { id: "b", publishedAt: old[50].publishedAt + 30 };
    const truth = arrive(old, 2, [back]);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
    expect(r.outcome.kind).toBe("spliced");
    expectNoHole(r.items, truth);
  });

  it("a backdated post the window has not heard of cannot be seen, and splices", () => {
    const back = { id: "b", publishedAt: old[30].publishedAt + 30 };
    const truth = arrive(old, 2, [back]);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: old });
    expect(r.outcome.kind).toBe("spliced");
  });

  it("a short page one is the whole feed — what it no longer holds is gone", () => {
    const small = timeline(8, "s");
    const truth = arrive(small, 2);
    // Loaded once, since removed at the source: below every post the page
    // shares, where a tail would otherwise carry it.
    const loadedSmall = [...small, { id: "gone", publishedAt: small[7].publishedAt - 60 }];
    const r = mergeFirstPage(loadedSmall, truth, { pageSize: P, window: truth });
    expect(r.outcome).toEqual({ kind: "spliced", newCount: 2 });
    expect(r.keepCursor).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(truth.map((i) => i.id));
  });

  it("drops a post that left page one's range rather than carrying it out of order", () => {
    const gone = old[5].id;
    const truth = arrive(old.filter((p) => p.id !== gone), 1);
    const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
    expect(r.items.some((i) => i.id === gone)).toBe(false);
    expectNoHole(r.items, truth);
  });

  it("never leaves a hole, whatever arrives (every count 0…45, every backdated slot)", () => {
    for (let fresh = 0; fresh <= 45; fresh++) {
      for (const slot of [-1, 3, 19, 25, 39, 55]) {
        const back =
          slot < 0 ? [] : [{ id: `b${slot}`, publishedAt: old[slot].publishedAt + 30 }];
        const truth = arrive(old, fresh, back);
        const r = mergeFirstPage(loaded, truth.slice(0, P), { pageSize: P, window: truth });
        expectNoHole(r.items, truth);
        expect(new Set(r.items.map((i) => i.id)).size).toBe(r.items.length);
      }
    }
  });
});
