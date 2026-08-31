import { describe, it, expect } from "vitest";
import {
  advanceSubscriptionPeriod,
  anchorDayOf,
  firstPeriodEnd,
} from "../src/lib/subscription-period.js";

// =============================================================================
// Subscription period arithmetic (CONSOLIDATED-TODO §1.5).
//
// Two bugs are pinned here, and each has a paired control carrying the PRE-FIX
// behaviour so a regression is a failure rather than a silently equal answer:
//
//   • the fixed 30/365-day add (a "month" that is not a month), and
//   • the month-end WALK — advancing the previous period end with setUTCMonth,
//     which overflows 31 Jan into 3 Mar and then advances THAT next cycle.
//
// The walk is the one that needs a multi-cycle test: a single advance from
// 31 Jan looks merely wrong, but the defect is that it compounds.
// =============================================================================

const iso = (d: Date) => d.toISOString();

describe("advanceSubscriptionPeriod — monthly", () => {
  it("lands on the anchor day in the next month", () => {
    const from = new Date("2026-03-15T09:30:00.000Z");
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 15))).toBe(
      "2026-04-15T09:30:00.000Z",
    );
  });

  it("clamps to the last day of a month too short for the anchor", () => {
    const from = new Date("2026-01-31T00:00:00.000Z");
    // 2026 is not a leap year: February has 28 days.
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 31))).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("clamps to 29 February in a leap year", () => {
    const from = new Date("2028-01-31T00:00:00.000Z");
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 31))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("RECOVERS the anchor after a clamp — the walk bug, over six cycles", () => {
    // The defect this closes: setUTCMonth on the previous END gives
    // 31 Jan → 3 Mar → 3 Apr → 3 May, and the subscriber's renewal date has
    // permanently left the day they signed up on. Anchored, February borrows
    // the date and March gives it straight back.
    const anchor = 31;
    let d = new Date("2026-01-31T12:00:00.000Z");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      d = advanceSubscriptionPeriod(d, "monthly", anchor);
      seen.push(iso(d).slice(0, 10));
    }
    expect(seen).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
    ]);
  });

  it("paired control: the pre-fix setUTCMonth form really did walk", () => {
    // Not a test of production code — the proof that the case above is a fix
    // and not a restatement. If this ever stops walking, the fix above is
    // pinning nothing.
    let d = new Date("2026-01-31T12:00:00.000Z");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = new Date(d);
      next.setUTCMonth(next.getUTCMonth() + 1);
      d = next;
      seen.push(iso(d).slice(0, 10));
    }
    expect(seen).toEqual(["2026-03-03", "2026-04-03", "2026-05-03"]);
  });

  it("rolls the year over at December", () => {
    const from = new Date("2026-12-20T00:00:00.000Z");
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 20))).toBe(
      "2027-01-20T00:00:00.000Z",
    );
  });

  it("carries the time of day through, to the millisecond", () => {
    const from = new Date("2026-05-10T23:59:59.123Z");
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 10))).toBe(
      "2026-06-10T23:59:59.123Z",
    );
  });
});

describe("advanceSubscriptionPeriod — annual", () => {
  it("advances one calendar year, not 365 days", () => {
    // 2028 is a leap year, so the span 2027-06-01 → 2028-06-01 is 366 days.
    const from = new Date("2027-06-01T00:00:00.000Z");
    const next = advanceSubscriptionPeriod(from, "annual", 1);
    expect(iso(next)).toBe("2028-06-01T00:00:00.000Z");

    const days = (next.getTime() - from.getTime()) / 86_400_000;
    expect(days).toBe(366);

    // Paired control: the pre-fix fixed add lands a day short of the anniversary.
    const fixed = new Date(from.getTime() + 365 * 86_400_000);
    expect(iso(fixed)).toBe("2028-05-31T00:00:00.000Z");
  });

  it("clamps 29 February to 28 February in the following (non-leap) year", () => {
    const from = new Date("2028-02-29T00:00:00.000Z");
    expect(iso(advanceSubscriptionPeriod(from, "annual", 29))).toBe(
      "2029-02-28T00:00:00.000Z",
    );
  });
});

describe("anchor handling", () => {
  it("anchorDayOf reads the UTC day, not the local one", () => {
    // 22:00 on the 5th UTC is already the 6th in Sydney; every period boundary
    // in the DB is timestamptz compared against now(), so the anchor is UTC.
    expect(anchorDayOf(new Date("2026-04-05T22:00:00.000Z"))).toBe(5);
  });

  it("firstPeriodEnd anchors on the start date it is given", () => {
    const start = new Date("2026-01-31T08:00:00.000Z");
    expect(iso(firstPeriodEnd(start, "monthly"))).toBe(
      "2026-02-28T08:00:00.000Z",
    );
    expect(iso(firstPeriodEnd(start, "annual"))).toBe(
      "2027-01-31T08:00:00.000Z",
    );
  });

  it("clamps an out-of-range anchor into 1..31 rather than throwing", () => {
    // The column has a CHECK, so this can only arrive from a caller bug — and
    // a renewal worker that throws mid-cycle is worse than one that renews on
    // the nearest legal day.
    const from = new Date("2026-03-10T00:00:00.000Z");
    expect(iso(advanceSubscriptionPeriod(from, "monthly", 0)).slice(0, 10)).toBe(
      "2026-04-01",
    );
    expect(
      iso(advanceSubscriptionPeriod(from, "monthly", 99)).slice(0, 10),
    ).toBe("2026-04-30");
  });
});
