import { describe, it, expect } from "vitest";
import { planReveal, type Buffered, type RevealStatus } from "./queueReveal";

// WORKSPACE-QUEUE-ADR §VI.5 — what a pull does with each feed's buffer.
// Audit 2026-09-27 (1): a feed showing COULDN'T LOAD FEED discarded its buffer
// on every pull, so in the queue it could never recover.
//
// MUTATION LOG (each applied to queueReveal.ts, the suite re-run, reverted):
//   1. the gate put back to `st === "ready"` ⇒ "a failed feed is shown its
//      buffer" fails.                                             DETECTED
//   2. the drop moved ahead of the loading check (the old order) ⇒ "a
//      loading feed keeps its buffer" fails.                      DETECTED
//   3. the error fallback removed ⇒ "a failed feed with nothing buffered is
//      reloaded" fails.                                           DETECTED

function plan(
  ids: string[],
  buffer: Record<string, Buffered<string>>,
  status: Record<string, RevealStatus>,
  gen: Record<string, number> = {},
) {
  return planReveal(
    ids,
    new Map(Object.entries(buffer)),
    (id) => status[id],
    (id) => gen[id] ?? 0,
  );
}

describe("planReveal", () => {
  it("shows a ready feed's current buffer, spends it, and reads again", () => {
    const p = plan(["a"], { a: { gen: 0, page: "A" } }, { a: "ready" });
    expect([...p.show]).toEqual([["a", "A"]]);
    expect(p.drop).toEqual(["a"]);
    expect(p.poke).toEqual(["a"]);
    expect(p.reload).toEqual([]);
  });

  it("never shows a page older than the last replace, and drops it", () => {
    const p = plan(["a"], { a: { gen: 1, page: "A" } }, { a: "ready" }, { a: 2 });
    expect(p.show.size).toBe(0);
    expect(p.drop).toEqual(["a"]);
    expect(p.poke).toEqual(["a"]);
  });

  it("a failed feed is shown its buffer", () => {
    const p = plan(["a"], { a: { gen: 0, page: "A" } }, { a: "error" });
    expect([...p.show]).toEqual([["a", "A"]]);
    expect(p.reload).toEqual([]);
  });

  it("a failed feed with nothing buffered is reloaded, and not poked too", () => {
    const p = plan(["a"], {}, { a: "error" });
    expect(p.show.size).toBe(0);
    expect(p.reload).toEqual(["a"]);
    expect(p.poke).toEqual([]);
    // …and a stale buffer is as good as none.
    const q = plan(["a"], { a: { gen: 0, page: "A" } }, { a: "error" }, { a: 1 });
    expect(q.reload).toEqual(["a"]);
    expect(q.drop).toEqual(["a"]);
  });

  it("a loading feed keeps its buffer and is poked", () => {
    const p = plan(["a"], { a: { gen: 1, page: "A" } }, { a: "loading" }, { a: 1 });
    expect(p.show.size).toBe(0);
    expect(p.drop).toEqual([]);
    expect(p.reload).toEqual([]);
    expect(p.poke).toEqual(["a"]);
  });

  it("a ready feed with nothing buffered reveals nothing and is poked", () => {
    const p = plan(["a", "b"], {}, { a: "ready" });
    expect(p.show.size).toBe(0);
    expect(p.reload).toEqual([]);
    expect(p.poke).toEqual(["a", "b"]);
  });
});
