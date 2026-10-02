import { describe, it, expect } from "vitest";
import { deriveRecordKey, TID_RE } from "./atproto-tid.js";

const ROW = "3f8a1c2e-0000-4000-8000-000000000001";
const OTHER = "3f8a1c2e-0000-4000-8000-000000000002";
const CREATED = new Date("2026-09-10T11:22:33.444Z");

describe("deriveRecordKey", () => {
  it("is a well-formed TID — 13 chars, base32-sortable, top bit clear", () => {
    const rkey = deriveRecordKey(ROW, CREATED);
    expect(rkey).toHaveLength(13);
    // The PDS validates this syntax for a `tid`-keyed collection, which is why
    // a bare base32 of the uuid is refused.
    expect(rkey).toMatch(TID_RE);
  });

  it("is the SAME for the same row — that is the whole point", () => {
    // The property the double-post fix rests on: attempt 1 and attempt 4 of one
    // row address the same record. Called twice, seconds apart in wall-clock
    // terms, with the row's own values.
    expect(deriveRecordKey(ROW, CREATED)).toBe(
      deriveRecordKey(ROW, new Date(CREATED.getTime())),
    );
  });

  it("differs between rows created in the same millisecond", () => {
    // Two posts enqueued in one tick must not collide on one record, or the
    // second would overwrite the first. The clock-identifier slot carries the
    // row id's hash for exactly this.
    expect(deriveRecordKey(ROW, CREATED)).not.toBe(
      deriveRecordKey(OTHER, CREATED),
    );
  });

  it("sorts by the row's own creation time", () => {
    // A TID is meant to be a timestamp; keeping that true means a member's repo
    // lists their posts in the order they made them.
    const earlier = deriveRecordKey(ROW, new Date("2026-01-01T00:00:00.000Z"));
    const later = deriveRecordKey(ROW, new Date("2026-06-01T00:00:00.000Z"));
    expect(earlier < later).toBe(true);
    expect(earlier).toMatch(TID_RE);
  });

  it("stays well-formed across the range of dates a row can carry", () => {
    for (const iso of [
      "2020-01-01T00:00:00.000Z",
      "2026-09-10T11:22:33.444Z",
      "2099-12-31T23:59:59.999Z",
    ]) {
      expect(deriveRecordKey(ROW, new Date(iso))).toMatch(TID_RE);
    }
  });
});
