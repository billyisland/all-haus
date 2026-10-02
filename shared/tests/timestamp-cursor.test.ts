import { describe, it, expect } from "vitest";
import { parseTimestampCursor } from "../src/lib/timestamp-cursor.js";

// =============================================================================
// The validator half of the precision invariant.
//
// What this file can pin: the SHAPE gate — a malformed cursor must be
// distinguishable from a well-formed one BEFORE it reaches a `$n::timestamptz`
// cast, because Postgres answers a bad cast with an error and the route then
// 500s with a database message in its body.
//
// What it deliberately cannot pin: that the round trip preserves microseconds.
// Only Postgres evaluates that, so it lives in the DB-backed
// `gateway/tests/timestamp-cursor-precision.test.ts`, which also demonstrates
// the failure mode this whole change exists for.
// =============================================================================

describe("parseTimestampCursor", () => {
  it("accepts what timestamptz::text actually produces", () => {
    // Postgres's own output shape under ISO DateStyle / UTC.
    for (const s of [
      "2026-09-10 12:34:56.123456+00",
      "2026-09-10 12:34:56+00",
      "2026-09-10 12:34:56.1+00",
      "2026-09-10 12:34:56.123456+01:30",
      "2026-09-10 12:34:56.123456-05",
    ]) {
      expect(parseTimestampCursor(s), s).toBe(s);
    }
  });

  it("accepts the ISO-8601 shape a client minted before this rule landed", () => {
    // Every one of these cursors is millisecond-precision by construction —
    // that is the defect. Refusing them would 400 every pagination that was
    // open across the deploy, which is a worse outcome than honouring a
    // position that is no less correct than it was yesterday.
    expect(parseTimestampCursor("2026-09-10T12:34:56.123Z")).toBe(
      "2026-09-10T12:34:56.123Z",
    );
    expect(parseTimestampCursor("2026-09-10T12:34:56Z")).toBe(
      "2026-09-10T12:34:56Z",
    );
  });

  it("refuses the values that would otherwise reach the cast", () => {
    for (const s of [
      "",
      "   ",
      "not-a-time",
      "2026",
      "Sep 10 2026",
      "now()",
      "2026-09-10 12:34:56.123456+00; DROP TABLE notifications",
      "2026-09-10 12:34:56.1234567+00", // 7 fractional digits — not a timestamptz
      "12:34:56",
      "-infinity",
    ]) {
      expect(parseTimestampCursor(s), s).toBeNull();
    }
  });

  it("refuses a value with the right SHAPE that Postgres refuses (22008 → a 500) — CA-F9", () => {
    // Each of these was checked against Postgres: every one raises
    // "date/time field value out of range" or "time zone displacement out of
    // range", which no route maps, so it answered internal_error.
    for (const s of [
      "2026-99-99 99:99:99",
      "2026-13-01 00:00:00+00",
      "2026-00-10 00:00:00+00",
      "2026-09-00 00:00:00+00",
      "2026-09-32 00:00:00+00",
      "2026-02-29 00:00:00+00", // not a leap year
      "2026-04-31 00:00:00+00",
      "0000-01-01 00:00:00+00",
      "2026-09-10 12:00:00+16",
      "2026-09-10 12:60:00+00",
    ]) {
      expect(parseTimestampCursor(s), s).toBeNull();
    }
  });

  it("CONTROL — the edges of every bounded field are still accepted", () => {
    for (const s of [
      "2024-02-29 00:00:00+00", // leap day
      "2026-12-31 23:59:59.999999+00",
      "2026-01-01 00:00:00-15:59",
      "2026-09-30T12:00:00+05:30",
    ]) {
      expect(parseTimestampCursor(s), s).toBe(s);
    }
  });

  it("refuses non-strings and absent values rather than coercing them", () => {
    expect(parseTimestampCursor(undefined)).toBeNull();
    expect(parseTimestampCursor(null)).toBeNull();
    expect(parseTimestampCursor(42 as unknown as string)).toBeNull();
  });

  it("caps the length, so a megabyte of digits never reaches the regex", () => {
    expect(parseTimestampCursor("2026-09-10 12:34:56+00".padEnd(200, "0"))).toBeNull();
  });

  it("trims, because a querystring round trip can add whitespace", () => {
    expect(parseTimestampCursor("  2026-09-10 12:34:56.123456+00 ")).toBe(
      "2026-09-10 12:34:56.123456+00",
    );
  });
});
