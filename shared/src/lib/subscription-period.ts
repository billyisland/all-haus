// =============================================================================
// subscription-period.ts — the one home for subscription period arithmetic.
//
// Two bugs this closes (CONSOLIDATED-TODO §1.5, Wave-3 P2 tail):
//
//  1. FIXED-MILLISECOND PERIODS. Subscribe / re-activate / comp all added a
//     literal 30 or 365 days. A "monthly" subscription taken out on 1 January
//     therefore renewed on 31 January, and an annual one lost a day every leap
//     year. A month is a calendar month; a year is a calendar year.
//
//  2. THE MONTH-END WALK. The renewal worker did move to calendar arithmetic,
//     but by advancing the PREVIOUS period end with setUTCMonth — which
//     overflows rather than clamps (31 January + 1 month → 3 March) — and then
//     advanced that drifted value again next cycle. A subscriber who signed up
//     on the 31st walked forward a few days every month until their renewal
//     date had nothing to do with the day they subscribed.
//
// The fix for (2) is that a period end is derived from a STORED ANCHOR DAY
// (`subscriptions.period_anchor_day`, migration 170) rather than from the
// previous end. The anchor is the day-of-month the subscription's periods hang
// off; each advance lands on that day in the target month, CLAMPED to the last
// day of a month too short to hold it. So anchor 31 gives
// 31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May, and February never permanently
// shortens the subscription.
//
// Time-of-day, and therefore the sub-second component, is carried through from
// the date being advanced — a renewal keeps the hour the subscription started.
// =============================================================================

export type SubscriptionPeriodKind = "monthly" | "annual";

/**
 * The anchor day to store for a subscription whose periods start at `start`.
 * Always UTC: every period boundary in the system is stored as timestamptz and
 * compared against `now()`, so a local-time day-of-month would put the anchor
 * one day out for anyone west of UTC.
 */
export function anchorDayOf(start: Date): number {
  return start.getUTCDate();
}

/**
 * Advance `from` by one subscription period, landing on `anchorDay` in the
 * target month (clamped to that month's last day). `anchorDay` outside 1..31 is
 * clamped into range rather than throwing — the column carries a CHECK, so an
 * out-of-range value can only arrive from a caller bug, and a renewal worker
 * that throws mid-cycle is worse than one that renews on the nearest legal day.
 */
export function advanceSubscriptionPeriod(
  from: Date,
  period: SubscriptionPeriodKind,
  anchorDay: number,
): Date {
  const months = period === "annual" ? 12 : 1;

  // Month index arithmetic first, so the year rollover is explicit rather than
  // relying on setUTCMonth's own normalisation (which would apply AFTER a day
  // overflow and defeat the clamp below).
  const absoluteMonth = from.getUTCMonth() + months;
  const targetYear = from.getUTCFullYear() + Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;

  const wanted = Math.min(31, Math.max(1, Math.trunc(anchorDay)));
  const day = Math.min(wanted, daysInUtcMonth(targetYear, targetMonth));

  const next = new Date(from);
  // Set all three fields in one call: assigning month and day separately would
  // pass through an intermediate date (e.g. 31 February) that normalises away.
  next.setUTCFullYear(targetYear, targetMonth, day);
  return next;
}

/**
 * Convenience for the create paths: the period `start` begins now, so it is
 * both the anchor source and the date to advance from.
 */
export function firstPeriodEnd(
  start: Date,
  period: SubscriptionPeriodKind,
): Date {
  return advanceSubscriptionPeriod(start, period, anchorDayOf(start));
}

// Day 0 of the following month is the last day of this one.
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}
