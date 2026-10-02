import { describe, it, expect } from "vitest";
import { planNostrPollBatch } from "./feed-ingest-nostr.js";
import type { NostrEvent } from "../lib/nostr-ingest.js";

// =============================================================================
// The nostr poll's cap is a RESUME POINT, not a loss (MIRROR-AUDIT §3, S17).
//
// The defect: three separately-capped streams, each keeping the NEWEST
// maxItems, and a cursor set to the newest event SEEN. A source that published
// more than maxItems inside one poll window lost its oldest events and the
// cursor moved past them — permanently, silently, and worse the busier the
// author.
//
// So the claim under test is not "the cap holds" (it always did) but "the
// cursor never passes an event the run declined to process". Every case below
// asserts the cursor against the batch, which is the only relationship that
// makes the gap impossible.
//
// Mutation-proved: sorting DESC and slicing (the old shape) fails "the cursor
// stops at the newest event kept"; dropping the `since + 1` escape fails the
// degenerate case; removing the id tiebreak makes the ordering non-deterministic
// and the boundary assertions flap.
// =============================================================================

let seq = 0;
const ev = (created_at: number, kind = 1): NostrEvent => ({
  id: (++seq).toString(16).padStart(64, "0"),
  pubkey: "a".repeat(64),
  created_at,
  kind,
  tags: [],
  content: `e${seq}`,
  sig: "f".repeat(128),
});

describe("planNostrPollBatch", () => {
  it("under the cap: everything is processed and the cursor is the newest", () => {
    const events = [ev(100), ev(300), ev(200)];
    const plan = planNostrPollBatch(events, 50, 10);
    expect(plan.batch).toHaveLength(3);
    expect(plan.dropped).toBe(0);
    expect(plan.cursor).toBe(300);
    expect(plan.skippedSecond).toBe(false);
  });

  it("over the cap: it keeps the OLDEST, and the cursor stops at the newest KEPT", () => {
    const events = [100, 200, 300, 400, 500].map((t) => ev(t));
    const plan = planNostrPollBatch(events, 50, 3);
    expect(plan.batch.map((e) => e.created_at)).toEqual([100, 200, 300]);
    expect(plan.dropped).toBe(2);
    // The whole point: 400 and 500 were NOT processed, so the cursor must not
    // be past them. Under the old shape this was 500 and they were lost.
    expect(plan.cursor).toBe(300);
    expect(plan.skippedSecond).toBe(false);
  });

  it("the next tick resumes with nothing missed", () => {
    // `since` is inclusive in NIP-01, so the relay re-serves the boundary event
    // and the run after it picks up exactly where this one stopped.
    const all = [100, 200, 300, 400, 500].map((t) => ev(t));
    const first = planNostrPollBatch(all, 50, 3);
    const refetched = all.filter((e) => e.created_at >= first.cursor);
    const second = planNostrPollBatch(refetched, first.cursor, 3);
    const seen = new Set(
      [...first.batch, ...second.batch].map((e) => e.created_at),
    );
    expect([...seen].sort((a, b) => a - b)).toEqual([100, 200, 300, 400, 500]);
    expect(second.cursor).toBe(500);
    expect(second.dropped).toBe(0);
  });

  it("all three kinds share ONE cap, deduped by event id", () => {
    // deletionEvents arrives as a flat array across relays, so the same kind-5
    // seen on three relays used to spend three of the cap's slots.
    const del = ev(150, 5);
    const plan = planNostrPollBatch(
      [ev(100), del, del, del, ev(200, 6), ev(250)],
      50,
      10,
    );
    expect(plan.batch).toHaveLength(4);
    expect(plan.batch.filter((e) => e.kind === 5)).toHaveLength(1);
    expect(plan.cursor).toBe(250);
  });

  it("a kind the caller then declines still moves the cursor", () => {
    // The batch is what was CONSIDERED. A kind-6 detectNostrRepost rejects, or
    // an event the published_at ratchet skips, must not hold the cursor back —
    // a window of nothing but those would spin the source for ever.
    const plan = planNostrPollBatch([ev(100, 6), ev(200, 6)], 50, 10);
    expect(plan.cursor).toBe(200);
  });

  it("nothing fetched leaves the cursor exactly where it was", () => {
    const plan = planNostrPollBatch([], 12345, 50);
    expect(plan.batch).toEqual([]);
    expect(plan.cursor).toBe(12345);
    expect(plan.dropped).toBe(0);
    expect(plan.skippedSecond).toBe(false);
  });

  it("the cursor never moves backwards, whatever the relay serves", () => {
    // A relay ignoring `since` (or a source whose cursor was hand-set forward)
    // must not rewind the position and re-ingest history.
    const plan = planNostrPollBatch([ev(100), ev(200)], 9000, 50);
    expect(plan.cursor).toBe(9000);
  });

  it("the degenerate case: more than maxItems in the boundary second steps past it, loudly", () => {
    // Every event shares `since`, so keeping the oldest maxItems produces the
    // SAME batch every run and the cursor cannot move — the source would stop
    // ingesting for good, which is worse than the gap. Step past, and flag it.
    const events = Array.from({ length: 5 }, () => ev(1000));
    const plan = planNostrPollBatch(events, 1000, 3);
    expect(plan.dropped).toBe(2);
    expect(plan.skippedSecond).toBe(true);
    expect(plan.cursor).toBe(1001);
  });

  it("a full boundary second that fits is NOT a skipped second", () => {
    // The control for the case above: same timestamps, cap large enough. The
    // escape hatch must fire on the cap, never on the tie.
    const events = Array.from({ length: 5 }, () => ev(1000));
    const plan = planNostrPollBatch(events, 1000, 10);
    expect(plan.skippedSecond).toBe(false);
    expect(plan.cursor).toBe(1000);
  });
});
