// =============================================================================
// How old somebody said they were, and whether that is old enough
//
// The ONE home for the age rule (L6.1, decision A1). Three doors write
// `accounts.date_of_birth` — email signup, the declaration a Google member
// makes on their first landing, and the once-only ask an existing member gets
// — and a rule spelled three times is three rules. There is a FOURTH copy that
// cannot import this file, the CHECK constraint in migration 212, and the two
// are held to each other by a DB-backed test rather than by hope.
//
// THE CLOCK IS AN ARGUMENT, NEVER `Date.now()` INSIDE. Two reasons, and the
// second is the one that bites. A boundary test has to be able to stand at
// 17y364d and at 18y0d, which a function reading the wall clock cannot be made
// to do. And a schema built once at module load would freeze `now` at process
// start: a service that has been up for a fortnight would go on refusing
// somebody who turned 18 last Tuesday, with nothing to see. So the caller
// passes the instant, and passes it per request.
//
// THE ANNIVERSARY CLAMPS, IT DOES NOT ROLL OVER. `new Date(Date.UTC(y + 18, 1,
// 29))` for a 29 February birth lands on 1 March, which is a day later than
// Postgres's `date + INTERVAL '18 years'` — that clamps to 28 February. Two
// copies of one rule disagreeing for two days a year is the whole reason this
// file exists, and the direction of the disagreement (route stricter than
// column) would have hidden it: no invalid row could ever be written, so
// nothing would have failed. Same family as the `setUTCMonth` overflow the
// subscription-period rule is about — an anniversary arithmetic that overflows
// rather than clamps is wrong every time the month is short.
//
// WHAT THIS RESTS ON: `docs/adr/LEGAL-BRAKES.md` (the operator decision, the
// clauses it implements, and what is still outstanding).
//
// UTC ON BOTH SIDES. A date of birth is a calendar date with no timezone; the
// declaration is an instant. Comparing them needs a convention, and the
// convention is the column's (`AT TIME ZONE 'UTC'`). It means a member in New
// Zealand may be refused for up to twelve hours after their local birthday,
// which is the conservative direction and the same one the constraint takes.
// =============================================================================

import { z } from 'zod'

/** The age a member must declare to hold an account. */
export const MINIMUM_AGE_YEARS = 18

/**
 * `YYYY-MM-DD`, and nothing else. Deliberately not `new Date(s)`, which accepts
 * `"2001"`, `"March 3 2001"` and a full ISO instant, and silently reinterprets
 * a bare date string as UTC midnight in some runtimes and local midnight in
 * others. The wire format is unchanged and is what the form assembles:
 * `DateOfBirthField` (web) posts three boxes joined into one string, and the
 * refusals below are therefore worded for a PERSON rather than for the
 * control — a member who typed `78` into a box labelled Year is told the
 * year wants four digits (see `dateOfBirthSchema` for why it lands there),
 * where "enter it as YYYY-MM-DD" names a format they were never shown.
 */
export const DATE_OF_BIRTH_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse `YYYY-MM-DD` into its parts, or `null` if it is not a real calendar
 * date. The round-trip check is what refuses `2001-02-30` — the regex alone
 * accepts it, and `Date.UTC` rolls it forward to 2 March without complaint.
 */
export function parseDateOfBirth(
  value: string,
): { year: number; month: number; day: number } | null {
  if (!DATE_OF_BIRTH_RE.test(value)) return null
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

/**
 * The instant a person born on `year-month-day` attains `years` years, as
 * Postgres's `date + INTERVAL 'n years'` computes it: the anniversary, clamped
 * back into the target month when that month is too short to hold the day.
 */
function anniversaryUtc(
  year: number,
  month: number,
  day: number,
  years: number,
): Date {
  const t = new Date(Date.UTC(year + years, month - 1, day))
  // A short target month (29 February into a non-leap year) has already rolled
  // the date into the NEXT month by the time we can look at it. `setUTCDate(0)`
  // is "the last day of the previous month", which is the clamp.
  if (t.getUTCMonth() !== month - 1) t.setUTCDate(0)
  return t
}

/**
 * Was somebody born on `dateOfBirth` an adult at `now`?
 *
 * `false` for anything unparseable, so a malformed value can never read as old
 * enough. That is the fail-closed half; the malformed case gets its OWN
 * refusal at the schema, because "that is not a date" and "you are too young"
 * are different things to be told and only one of them is about the person.
 */
export function isAdultOn(dateOfBirth: string, now: Date): boolean {
  const parts = parseDateOfBirth(dateOfBirth)
  if (parts === null) return false
  const attained = anniversaryUtc(
    parts.year,
    parts.month,
    parts.day,
    MINIMUM_AGE_YEARS,
  )
  return now.getTime() >= attained.getTime()
}

/**
 * Is `dateOfBirth` a date a living person could have been born on, at `now`?
 *
 * The far bound is the one worth having: a date in the future is not a typo
 * anybody makes deliberately, and it is what an off-by-a-century paste
 * produces. The near bound is the age rule above and is asked separately.
 */
export function isPlausibleDateOfBirth(dateOfBirth: string, now: Date): boolean {
  const parts = parseDateOfBirth(dateOfBirth)
  if (parts === null) return false
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day)
  if (asUtc > now.getTime()) return false
  return parts.year >= 1900
}

/**
 * What a member who is too young is told. One sentence, and NO RETRY HINT: a
 * refusal that explains which number to change is a form that teaches the way
 * round it, and this one is a declaration we are recording rather than a lock
 * we are picking at. It does not say "come back in N years" either — that is
 * a calculation from a value we have just refused to trust.
 */
export const UNDERAGE_MESSAGE =
  'You have to be 18 or over to have an all.haus account.'


/**
 * The date-of-birth FIELD, and the only spelling of it. Three doors write this
 * value — `signupSchema`, the post-OAuth declaration and the existing-member
 * ask — and the refusals have to be the same words in all three, because a
 * member who is refused at one door and admitted at another has found a bug in
 * the rule rather than a difference between the doors.
 *
 * THREE REFUSALS, NOT ONE, because they are three different things to be told:
 * what was typed is not a date; what was typed cannot be anybody's date of
 * birth (the paste that lost a digit); and the person is too young, which is
 * the only one of the three that is a decision about them.
 *
 * THE FIRST ONE NAMES A FOUR-DIGIT YEAR, and that is not padding. A two-digit
 * year was nearly unreachable while the form was an `<input type="date">`,
 * which enforces four; the three-box field lets a member type `78`, and it
 * arrives here as `0078-03-05`. It lands on THIS arm rather than the
 * plausibility one below, because `Date.UTC(78, …)` maps a year under 100 to
 * 1978, so the round-trip in `parseDateOfBirth` sees 1978 come back where 78
 * went in and rejects it as not a calendar date. Fails closed either way,
 * which is right — but "that is not a date" is a puzzling thing to read when
 * you have just filled in three boxes, so the sentence says what the year
 * wants. Confirmed by driving all three refusals through the rendered gate.
 */
export function dateOfBirthSchema(now: Date) {
  return z
    .string()
    .refine((v) => parseDateOfBirth(v) !== null, {
      message: 'Enter a date of birth — a day, a month and a four-digit year.',
    })
    .refine((v) => isPlausibleDateOfBirth(v, now), {
      message: 'That date of birth is not a date anybody could be born on.',
    })
    .refine((v) => isAdultOn(v, now), { message: UNDERAGE_MESSAGE })
}
