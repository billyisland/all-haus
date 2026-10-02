import { describe, it, expect } from "vitest";
import {
  resumeCursor,
  resumeFrom,
  watermarkAfterFlush,
} from "./resume-cursor.js";

// =============================================================================
// ONE STREAM, ONE WATERMARK (CA-C7, 2026-09-29) — the pure half.
//
// The resume point was the MIN over per-source cursors, which is the least
// active account's last post, so every reconnect replayed the whole cap. With
// a watermark present the per-source cursors are not consulted at all; the
// only thing that can pull the resume below the watermark is an ingest that
// FAILED, and the flush writes the watermark held below that floor.
//
// MUTATION CHECKS (each fails the named case):
//   resume from the per-source MIN even with a watermark → "a watermark wins…"
//   ignore failedFloor in resumeFrom                     → "a failed ingest pulls…"
//   write the batch max regardless of the floor           → "the flush holds…"
// =============================================================================

const NOW = 1_800_000_000_000_000n; // µs
const CAP = 24n * 3600n * 1_000_000n;

describe("resumeCursor (the cap, unchanged)", () => {
  it("takes the oldest and clamps it to the cap", () => {
    const old = NOW - 2n * CAP;
    const r = resumeCursor([old.toString(), (NOW - 1000n).toString()], NOW, CAP);
    expect(r.clamped).toBe(true);
    expect(r.cursor).toBe((NOW - CAP).toString());
  });
});

describe("resumeFrom", () => {
  it("a watermark wins over the per-source MIN — the stale sources are not consulted", () => {
    const stale = (NOW - 20n * 3600n * 1_000_000n).toString();
    const watermark = (NOW - 60n * 1_000_000n).toString();
    const r = resumeFrom(
      { watermark, failedFloor: null, perSourceCursors: [stale, watermark] },
      NOW,
      CAP,
    );
    expect(r.cursor).toBe(watermark);
    expect(r.clamped).toBe(false);
  });

  it("no watermark yet: the per-source cursors are the fallback, exactly as before", () => {
    const stale = (NOW - 20n * 3600n * 1_000_000n).toString();
    const r = resumeFrom(
      { watermark: null, failedFloor: null, perSourceCursors: [stale, (NOW - 5n).toString()] },
      NOW,
      CAP,
    );
    expect(r.cursor).toBe(stale);
  });

  it("a failed ingest pulls the resume below the watermark", () => {
    const watermark = NOW - 60n * 1_000_000n;
    const failed = NOW - 600n * 1_000_000n;
    const r = resumeFrom(
      { watermark: watermark.toString(), failedFloor: failed, perSourceCursors: [] },
      NOW,
      CAP,
    );
    expect(r.cursor).toBe(failed.toString());
  });

  it("a failure NEWER than the watermark does not move it", () => {
    const watermark = NOW - 600n * 1_000_000n;
    const failed = NOW - 60n * 1_000_000n;
    const r = resumeFrom(
      { watermark: watermark.toString(), failedFloor: failed, perSourceCursors: [] },
      NOW,
      CAP,
    );
    expect(r.cursor).toBe(watermark.toString());
  });

  it("does not mutate the caller's per-source list", () => {
    const list = [(NOW - 5n).toString()];
    resumeFrom({ watermark: null, failedFloor: 1n, perSourceCursors: list }, NOW, CAP);
    expect(list).toHaveLength(1);
  });
});

describe("watermarkAfterFlush", () => {
  it("is the batch's newest success", () => {
    expect(watermarkAfterFlush([10n, 30n, 20n], null)).toBe(30n);
  });

  it("the flush holds the watermark below a failure older than the batch", () => {
    expect(watermarkAfterFlush([10n, 30n, 20n], 15n)).toBe(15n);
  });

  it("a failure newer than every success does not hold it", () => {
    expect(watermarkAfterFlush([10n, 30n], 40n)).toBe(30n);
  });

  it("an empty batch writes nothing", () => {
    expect(watermarkAfterFlush([], 5n)).toBeNull();
  });
});
