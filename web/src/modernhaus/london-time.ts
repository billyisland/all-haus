// =============================================================================
// modernhaus — London time, the one zone this register speaks (MODERNHAUS-ADR
// §D2.9 Q1: a scheduled time is read as London time and the field says so).
//
// A page with no script cannot ask the browser for its zone, and a native
// date-and-time picker draws its value in the browser's order, which markup
// cannot change (web-foundations.md, *Dates are British*). So the schedule is
// five labelled boxes — day, month, year, hour, minute — read as a London wall
// clock and converted here, on the server, with `Intl` and no library.
//
// THE TWO AWKWARD HOURS ARE ANSWERED, NOT GUESSED:
//   - the spring-forward gap (01:00–01:59 on the last Sunday of March) names a
//     time London never shows: refused, as no such time;
//   - the autumn repeat (01:00–01:59 on the last Sunday of October) names two
//     instants: the EARLIER (the first, BST, pass) is taken, and the page then
//     states the chosen instant back in en-GB, so the writer sees what they got.
// =============================================================================

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export interface LondonWall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** The London wall-clock reading of an instant. */
export function londonWall(at: Date): LondonWall {
  const p: Record<string, number> = {}
  for (const part of PARTS.formatToParts(at)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }
}

function same(a: LondonWall, b: LondonWall): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

/**
 * The instant a London wall-clock reading names, or null when it names none
 * (not a date, or inside the spring-forward gap). London is UTC+0 or UTC+1, so
 * the two candidates are the reading taken as UTC and one hour before it; the
 * earlier that reads back as the same wall clock wins.
 */
export function londonToInstant(w: LondonWall): Date | null {
  const { year, month, day, hour, minute } = w
  if (![year, month, day, hour, minute].every(Number.isInteger)) return null
  if (year < 2000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  for (const candidate of [asUtc - 3_600_000, asUtc]) {
    const d = new Date(candidate)
    if (same(londonWall(d), w)) return d
  }
  return null
}

/** Five boxes' strings, as a wall-clock reading; null unless all five are whole numbers. */
export function wallFromBoxes(boxes: {
  day: string
  month: string
  year: string
  hour: string
  minute: string
}): LondonWall | null {
  const n = (s: string) => (/^\d{1,4}$/.test(s.trim()) ? Number(s.trim()) : NaN)
  const w = { day: n(boxes.day), month: n(boxes.month), year: n(boxes.year), hour: n(boxes.hour), minute: n(boxes.minute) }
  return Object.values(w).every(Number.isInteger) ? w : null
}
