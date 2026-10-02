import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { formatDateInputEcho } from '../src/lib/format'

// =============================================================================
// UK date style, sitewide
//
// The site is British and every date it RENDERS says so. Two halves, and they
// fail in different ways.
//
// THE RENDERED HALF is a locale argument, and its failure is a bare
// `toLocaleDateString()` — which resolves against whatever locale the runtime
// happens to carry. That is the SERVER's locale for an SSR'd page and the
// READER's for a hydration pass, so the same date can render two ways in one
// paint and React repairs the mismatch silently. The scan below refuses the
// bare form outright.
//
// THE TYPED HALF cannot be fixed by an argument at all. `<input type="date">`
// draws itself in the BROWSER's locale order, and `lang` on the element and on
// `<html>` are both ignored (probed in Chromium, 2026-09-18). So a date the
// member TYPES is handled one of two ways: the date of birth drops the widget
// for three labelled boxes (`DateOfBirthField`), and everything else keeps the
// widget and states its value alongside in UK long form
// (`formatDateInputEcho`). Both are pinned here, because both are invisible to
// `tsc`, to the linter and to `next build` — this class is only ever found by
// looking at the rendered page.
// =============================================================================

const SRC = join(__dirname, '../src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const FILES = walk(SRC)

/**
 * Source with its `//` comments removed.
 *
 * Every structural pin below must read CODE. The first cut of the hourCycle
 * pin passed against the comment that EXPLAINS the option — so replacing the
 * option in the code left the test green, which is the whole failure mode
 * these pins exist to catch, one level in. Same discipline as the schema
 * drift guard's comment-stripped copy.
 */
function code(src: string): string {
  return src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('formatDateInputEcho — the UK restatement of a picker value', () => {
  it('reads a date-only value as a LOCAL date, never UTC midnight', () => {
    // `new Date('2026-03-05')` is UTC midnight, which west of UTC is the 4th —
    // the echo would contradict the widget it is captioning. This is the whole
    // reason the helper parses components by hand.
    // `,?` — Chromium's ICU omits the comma Node's adds after the weekday
    // (seen side by side on the live page). Everything that MATTERS is
    // pinned: the weekday, the day before the month, the full year.
    expect(formatDateInputEcho('2026-03-05')).toMatch(/^Thu,? 5 March 2026$/)
  })

  it('parses COMPONENTS, never the string — a STRUCTURAL pin', () => {
    // This one cannot be behavioural here, and saying so is the point.
    // `new Date('2026-03-05')` is UTC midnight, which is the WRONG DAY only
    // west of UTC; this repo's clock is Europe/London, where it is the right
    // one all year (GMT in winter, BST is east). So a `new Date(value)`
    // implementation passes every assertion above. The obvious dodge — set
    // `process.env.TZ` inside the test — does nothing: vitest runs the file
    // in a worker where a runtime TZ change is not picked up (probed
    // 2026-09-18; `Intl…resolvedOptions().timeZone` stays Europe/London).
    // So the guard reads the source, and is honest that it pins a SHAPE.
    const src = code(readFileSync(join(SRC, 'lib/format.ts'), 'utf8'))
    const fn = src.match(/export function formatDateInputEcho\([\s\S]*?\n\}\n/)
    expect(fn, 'formatDateInputEcho not found — was it renamed?').toBeTruthy()
    expect(fn![0], 'the Date is built from components').toContain(
      'new Date(year, month - 1, day, hours, mins)',
    )
    expect(fn![0], 'never from the raw string').not.toMatch(
      /new Date\(\s*value\s*\)/,
    )
  })

  it('pins hourCycle h23 — also STRUCTURAL', () => {
    // `hour12: false` renders midnight as `24:00` under some ICU builds and
    // as `00:00` under others; this machine's is one of the others, so the
    // 00:00 assertion above passes either way. The option is what is pinned.
    const src = code(readFileSync(join(SRC, 'lib/format.ts'), 'utf8'))
    expect(src, 'read as CODE — the comment beside it does not count').toContain(
      "hourCycle: 'h23'",
    )
  })

  it('states the day before the month — the point of the exercise', () => {
    // The value an en-US browser would have drawn as `03/05/2026`.
    const echo = formatDateInputEcho('2026-03-05')!
    expect(echo.indexOf('5')).toBeLessThan(echo.indexOf('March'))
  })

  it('carries the time for a datetime-local value, on a 24-hour clock', () => {
    expect(formatDateInputEcho('2026-03-05T18:30')).toMatch(
      /^Thu,? 5 March 2026 at 18:30$/,
    )
  })

  it('renders midnight as 00:00, never 24:00', () => {
    // `hour12: false` resolves to h24 under some ICU builds. `hourCycle: h23`
    // is what pins it.
    expect(formatDateInputEcho('2026-03-05T00:00')).toMatch(
      /^Thu,? 5 March 2026 at 00:00$/,
    )
  })

  it('returns null rather than a confident wrong answer', () => {
    expect(formatDateInputEcho('')).toBeNull()
    expect(formatDateInputEcho('2026-03')).toBeNull()
    // The regex accepts it and the Date constructor rolls it to 2 March; the
    // round-trip is what refuses it.
    expect(formatDateInputEcho('2026-02-30')).toBeNull()
    // Out-of-range minutes roll the hour without moving the day, so the
    // round-trip cannot see them.
    expect(formatDateInputEcho('2026-03-05T10:75')).toBeNull()
    expect(formatDateInputEcho('2026-03-05T25:00')).toBeNull()
  })
})

describe('every rendered date names its locale', () => {
  it('no bare toLocaleDateString / toLocaleString / toLocaleTimeString', () => {
    const offenders: string[] = []
    // Scanned over the whole FILE, not line by line: a call whose locale
    // argument is on the next line is still a bare call, and a per-line regex
    // cannot see it (`\s` does not cross a line it was never handed).
    // Numbers too — `en-GB` and `en-US` agree on grouping, but a French
    // runtime renders `1 234` beside a `£1,234.00` that `formatPence` pinned:
    // one surface, two conventions.
    const BARE = /\.toLocale(Date|Time)?String\(\s*(\)|undefined)/g
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(BARE)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${f.slice(SRC.length + 1)}:${line}`)
      }
    }
    expect(offenders, 'pass "en-GB" explicitly').toEqual([])
  })

  it('the document declares en-GB', () => {
    // It does NOT fix the date inputs (probed), but it is what an unqualified
    // `Intl` call, a screen reader and the spellchecker read.
    const layout = readFileSync(join(SRC, 'app/layout.tsx'), 'utf8')
    expect(layout).toMatch(/<html lang="en-GB"/)
  })
})

describe('a date the member TYPES', () => {
  it('no native date picker asks for a date of birth', () => {
    // The two doors that write `accounts.date_of_birth`. A `type="date"` here
    // is the regression this whole change exists to stop: the member is asked
    // for the one value never shown back to them, in an order the browser
    // chooses.
    for (const rel of [
      'components/legal/AgeGate.tsx',
      'app/auth/signup/page.tsx',
    ]) {
      const src = readFileSync(join(SRC, rel), 'utf8')
      expect(src, `${rel} still uses a native date picker`).not.toMatch(
        /type="date"/,
      )
      expect(src, `${rel} must use DateOfBirthField`).toMatch(
        /<DateOfBirthField/,
      )
    }
  })

  it('DateOfBirthField labels all three parts and assembles YYYY-MM-DD', () => {
    const src = readFileSync(join(SRC, 'components/public/Field.tsx'), 'utf8')
    const fn = src.match(/export function DateOfBirthField\([\s\S]*?\n\}\n/)
    expect(fn, 'DateOfBirthField not found — was it renamed?').toBeTruthy()
    // The labels are the shared copy (`content/auth.ts`, which modernhaus's
    // age and signup forms read too), so the pin follows each constant to its
    // words.
    const copy = readFileSync(join(SRC, 'content/auth.ts'), 'utf8')
    for (const part of ['Day', 'Month', 'Year']) {
      const name = `DOB_${part.toUpperCase()}`
      expect(fn![0], `the ${part} box has no label`).toContain(`label={${name}}`)
      expect(copy, `${name} is not "${part}"`).toContain(`export const ${name} = '${part}'`)
    }
    // The order on screen is the order the site reads in.
    const body = fn![0]
    expect(body.indexOf('label={DOB_DAY}')).toBeLessThan(body.indexOf('label={DOB_MONTH}'))
    expect(body.indexOf('label={DOB_MONTH}')).toBeLessThan(body.indexOf('label={DOB_YEAR}'))
    // `${y}-${m}-${d}`, padded — the wire format `shared/src/lib/age.ts` parses.
    expect(body).toMatch(/\$\{y\.padStart\(4, '0'\)\}-\$\{m\.padStart\(2, '0'\)\}-\$\{d\.padStart\(2, '0'\)\}/)
    // Real autofill tokens, not a single `bday`.
    for (const token of ['bday-day', 'bday-month', 'bday-year']) {
      expect(src).toContain(`autoComplete="${token}"`)
    }
  })

  it('every surviving native date picker states its value in UK form', () => {
    // A calendar is the right control for a date next Tuesday; what it may not
    // do is leave the chosen value ambiguous. Any file holding a `type="date"`
    // or `type="datetime-local"` must also echo it.
    const offenders: string[] = []
    for (const f of FILES) {
      // JSX only — a `type="date"` named in a `.ts` doc comment is prose
      // about this decision, not a control.
      if (!f.endsWith('.tsx')) continue
      const src = readFileSync(f, 'utf8')
      if (!/type="date(time-local)?"/.test(src)) continue
      if (!src.includes('formatDateInputEcho')) {
        offenders.push(f.slice(SRC.length + 1))
      }
    }
    expect(
      offenders,
      'a native picker with no UK echo beside it',
    ).toEqual([])
  })
})
