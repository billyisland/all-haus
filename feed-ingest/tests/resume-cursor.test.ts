import { describe, it, expect } from "vitest";
import { resumeCursor } from "../src/jetstream/resume-cursor.js";

// =============================================================================
// Where a Jetstream reconnect resumes from (dev diagnosis 2026-08-12).
//
// The bug was not a wrong number, it was an unbounded one: the resume point is
// the minimum cursor across sources, a cursor only moves when that account
// posts, so the minimum is the least active account and it ages forever. On dev
// it had reached a month, and past the wildcard threshold that means replaying
// a month of the entire Bluesky firehose on every reconnect — during which
// every event is one we already hold, so nothing inserts, no cursor moves, and
// ingest looks dead while the socket works perfectly hard.
//
// So the tests are about the BOUND, and about not breaking the property the
// minimum was there for: within the cap, the oldest source still wins.
// =============================================================================

const HOUR = 3_600_000_000n; // microseconds
const NOW = 1_786_500_000_000_000n; // a fixed "now" in time_us
const CAP = 24n * HOUR;

const us = (hoursAgo: number) =>
  (NOW - BigInt(Math.round(hoursAgo * 3_600_000_000))).toString();

describe("resumeCursor", () => {
  it("resumes from live when no source has a cursor", () => {
    expect(resumeCursor([null, undefined, ""], NOW, CAP)).toEqual({
      cursor: null,
      clamped: false,
      storedAgeHours: null,
    });
  });

  it("keeps the OLDEST cursor when everything is inside the cap", () => {
    // The property the minimum exists for: a source that last posted 6 hours
    // ago must not have those 6 hours skipped because a busier source posted a
    // minute ago.
    const r = resumeCursor([us(0.1), us(6), us(2)], NOW, CAP);
    expect(r.cursor).toBe(us(6));
    expect(r.clamped).toBe(false);
  });

  it("caps a resume that reaches back further than the window", () => {
    // The dev state: one quiet account a month back drags every reconnect with
    // it.
    const r = resumeCursor([us(0.5), us(24 * 31)], NOW, CAP);
    expect(r.clamped).toBe(true);
    expect(BigInt(r.cursor!)).toBe(NOW - CAP);
    // The age REPORTED is the stored one, not the capped one — the log line
    // exists to say how deep the stored position had got, which is the fact
    // that would otherwise stay invisible.
    expect(Math.round(r.storedAgeHours!)).toBe(24 * 31);
  });

  it("caps exactly at the boundary rather than one microsecond either side", () => {
    expect(resumeCursor([(NOW - CAP).toString()], NOW, CAP).clamped).toBe(false);
    expect(resumeCursor([(NOW - CAP - 1n).toString()], NOW, CAP).clamped).toBe(true);
  });

  it("starts from live when a cursor is in the FUTURE", () => {
    // The nastiest variant: Jetstream sends nothing until wall-clock catches
    // up, while still answering keepalives — a healthy-looking connection
    // delivering nothing, forever, from one bad time_us.
    const r = resumeCursor([(NOW + 100n * HOUR).toString()], NOW, CAP);
    expect(r.cursor).toBeNull();
    expect(r.clamped).toBe(true);
  });

  it("ignores junk and non-positive cursors rather than throwing", () => {
    const r = resumeCursor(["not-a-number", "0", "-5", us(3)], NOW, CAP);
    expect(r.cursor).toBe(us(3));
    expect(r.clamped).toBe(false);
  });

  it("resumes from live when every cursor is junk", () => {
    expect(resumeCursor(["", "nope", "0"], NOW, CAP).cursor).toBeNull();
  });

  it("honours a retuned cap", () => {
    // The dial is the point: an operator shortening the window must reach live
    // sooner after an outage without a deploy.
    const oneHour = resumeCursor([us(6)], NOW, HOUR);
    expect(oneHour.clamped).toBe(true);
    expect(BigInt(oneHour.cursor!)).toBe(NOW - HOUR);
    expect(resumeCursor([us(6)], NOW, 12n * HOUR).clamped).toBe(false);
  });
});
