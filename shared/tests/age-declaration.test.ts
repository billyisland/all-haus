import { describe, it, expect } from 'vitest'
import { Pool } from 'pg'
import {
  MINIMUM_AGE_YEARS,
  dateOfBirthSchema,
  isAdultOn,
  isPlausibleDateOfBirth,
  parseDateOfBirth,
  UNDERAGE_MESSAGE,
} from '../src/lib/age.js'

// =============================================================================
// The age rule, on a FIXED clock — and the same rule read back out of Postgres
//
// L6.1. Two halves, and the second is the one that could not have been written
// as a unit test.
//
// THE CLOCK IS AN ARGUMENT. `isAdultOn` and `dateOfBirthSchema` take `now`, so
// the boundary cases below stand at 17y364d and at 18y0d exactly. A function
// reading `Date.now()` cannot be asked either question, and a test that built
// its dates by subtracting eighteen years from today would be testing the
// subtraction it was written with.
//
// AND THE FOURTH COPY OF THE RULE IS IN THE DATABASE. Migration 212 carries a
// CHECK that a declared date of birth was an adult's at the moment it was
// declared, because a route's schema is one door and the CHECK is the wall.
// Two spellings of one rule in two languages disagree silently, and the
// direction of THIS disagreement would have hidden it completely: JS's naive
// anniversary arithmetic rolls 29 February forward to 1 March, Postgres's
// `date + INTERVAL '18 years'` clamps it back to 28 February, so for two days
// a year the route refused somebody the column would have accepted. No row is
// invalid, nothing throws, nothing is logged — the member is simply told they
// are seventeen. The DB-backed block at the foot is what holds the two
// together, and it is `skipIf` because only Postgres can evaluate its own
// constraint.
//
// MUTATION CHECK: change `anniversaryUtc`'s clamp back to a bare `Date.UTC`
// (remove the `setUTCDate(0)` line) and the leap-day case fails in BOTH blocks
// — the unit case on the clamped date, the DB case on the disagreement.
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

/** A fixed instant, chosen so the eighteen-years-back window spans a leap day. */
const NOW = new Date('2026-09-17T12:00:00.000Z')

describe('the age rule', () => {
  it('is eighteen, and the constant is what the message is about', () => {
    expect(MINIMUM_AGE_YEARS).toBe(18)
    expect(UNDERAGE_MESSAGE).toContain('18')
  })

  it('accepts somebody who turned 18 today, at 18y0d exactly', () => {
    // NOW is 2026-09-17; this is their eighteenth birthday, and the
    // declaration is at midday on it.
    expect(isAdultOn('2008-09-17', NOW)).toBe(true)
  })

  it('refuses somebody one day short — 17y364d', () => {
    expect(isAdultOn('2008-09-18', NOW)).toBe(false)
  })

  it('refuses a child by a wide margin, and accepts an adult by one', () => {
    expect(isAdultOn('2020-01-01', NOW)).toBe(false)
    expect(isAdultOn('1970-01-01', NOW)).toBe(true)
  })

  it('CLAMPS a 29 February birthday into a short month, as Postgres does', () => {
    // Born 2008-02-29. In 2026 there is no 29 February. Postgres's
    // `date + INTERVAL '18 years'` lands on 2026-02-28, so they are an adult
    // from the 28th; naive JS arithmetic would say 1 March and refuse them for
    // two days. The DB block below asserts the two agree.
    expect(isAdultOn('2008-02-29', new Date('2026-02-28T00:00:00.000Z'))).toBe(true)
    expect(isAdultOn('2008-02-29', new Date('2026-02-27T23:59:59.999Z'))).toBe(false)
  })

  it('reads a malformed value as NOT an adult — fail closed', () => {
    for (const bad of ['', 'yesterday', '2008', '08-09-2008', '2008-02-30', '2008-13-01']) {
      expect(isAdultOn(bad, NOW)).toBe(false)
      expect(parseDateOfBirth(bad)).toBeNull()
    }
  })

  it('refuses a date in the future and one before 1900 as implausible', () => {
    expect(isPlausibleDateOfBirth('2027-01-01', NOW)).toBe(false)
    expect(isPlausibleDateOfBirth('1899-12-31', NOW)).toBe(false)
    expect(isPlausibleDateOfBirth('1900-01-01', NOW)).toBe(true)
  })
})

describe('the field every door parses with', () => {
  const schema = dateOfBirthSchema(NOW)

  it('accepts 18y0d and refuses 17y364d — the same boundary, through zod', () => {
    expect(schema.safeParse('2008-09-17').success).toBe(true)
    expect(schema.safeParse('2008-09-18').success).toBe(false)
  })

  it('tells the three refusals apart, and the age one names no retry', () => {
    const malformed = schema.safeParse('not-a-date')
    const future = schema.safeParse('2030-01-01')
    const young = schema.safeParse('2020-01-01')

    expect(malformed.success).toBe(false)
    expect(future.success).toBe(false)
    expect(young.success).toBe(false)
    if (malformed.success || future.success || young.success) return

    const msg = (r: typeof young) => r.error.issues[0].message
    // Three different things to be told, and no two of them the same words.
    expect(new Set([msg(malformed), msg(future), msg(young)]).size).toBe(3)
    expect(msg(young)).toBe(UNDERAGE_MESSAGE)
    // No retry hint: the refusal must not teach which number to change.
    expect(UNDERAGE_MESSAGE).not.toMatch(/\b(19|20)\d\d\b/)
  })

  it('is BUILT PER CALL, so the clock is never frozen at module load', () => {
    const dob = '2008-09-17'
    // The day before their birthday the same schema value is refused; the day
    // of, accepted. A module-scope schema could not express this at all.
    expect(dateOfBirthSchema(new Date('2026-09-16T23:59:59.999Z')).safeParse(dob).success).toBe(false)
    expect(dateOfBirthSchema(new Date('2026-09-17T00:00:00.000Z')).safeParse(dob).success).toBe(true)
  })
})

// ─── The fourth copy: the CHECK constraint ──────────────────────────────────

describe.skipIf(!DB_URL)('migration 212 agrees with shared/lib/age.ts', () => {
  // Every case the unit block turns on, asked of Postgres instead.
  const CASES: { dob: string; declaredAt: string; adult: boolean }[] = [
    { dob: '2008-09-17', declaredAt: '2026-09-17T12:00:00Z', adult: true },
    { dob: '2008-09-18', declaredAt: '2026-09-17T12:00:00Z', adult: false },
    { dob: '2008-02-29', declaredAt: '2026-02-28T00:00:00Z', adult: true },
    { dob: '2008-02-29', declaredAt: '2026-02-27T23:59:59Z', adult: false },
    { dob: '2020-01-01', declaredAt: '2026-09-17T12:00:00Z', adult: false },
    { dob: '1970-01-01', declaredAt: '2026-09-17T12:00:00Z', adult: true },
  ]

  // The constraint's expression, as the EXPRESSION test below evaluates it.
  // It is a copy — and the test above it is what stops the copy drifting: it
  // reads the live definition out of `pg_constraint` and fails if the shape
  // moves. "A seeded migration never runs, so schema.sql is what every
  // database actually has" (CLAUDE.md) cuts both ways: a constraint present
  // under the same name meaning something else is the failure a name check
  // cannot see, so the definition is what is asserted.
  const ADULT_EXPR =
    "($1::date + INTERVAL '18 years' <= ($2::timestamptz AT TIME ZONE 'UTC'))"

  it('carries both constraints on `accounts`, by DEFINITION and not by name', async () => {
    const pool = new Pool({ connectionString: DB_URL })
    try {
      const { rows } = await pool.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'accounts'::regclass
            AND conname IN ('accounts_age_declaration_pair',
                            'accounts_age_declaration_adult')`,
      )
      const byName = Object.fromEntries(rows.map((r) => [r.conname, r.def]))

      // Present at all — a migration's stated intent is not evidence its
      // effect is in force.
      expect(Object.keys(byName).sort()).toEqual([
        'accounts_age_declaration_adult',
        'accounts_age_declaration_pair',
      ])

      // The PAIR is the NULL-safe spelling, not a pair of IS NOT NULLs.
      expect(byName.accounts_age_declaration_pair).toMatch(/IS NULL\)\s*=\s*\(/)

      // The ADULT rule adds eighteen years to the BIRTH DATE and compares
      // against the DECLARATION, at UTC. Each clause is load-bearing: drop the
      // `AT TIME ZONE` and the comparison starts depending on the session's
      // TimeZone; compare against `now()` instead and the constraint would
      // re-decide settled rows on every UPDATE.
      const adult = byName.accounts_age_declaration_adult
      expect(adult).toMatch(/date_of_birth/)
      expect(adult).toMatch(/18 years/)
      expect(adult).toMatch(/age_declared_at/)
      expect(adult).toMatch(/UTC/)
      expect(adult).not.toMatch(/now\(\)/)
    } finally {
      await pool.end()
    }
  })

  it('accepts and refuses exactly what isAdultOn does', async () => {
    const pool = new Pool({ connectionString: DB_URL })
    try {
      for (const c of CASES) {
        const { rows } = await pool.query<{ adult: boolean }>(
          `SELECT ${ADULT_EXPR} AS adult`,
          [c.dob, c.declaredAt],
        )
        expect(
          { case: `${c.dob} @ ${c.declaredAt}`, postgres: rows[0].adult },
          'Postgres and isAdultOn disagree',
        ).toEqual({ case: `${c.dob} @ ${c.declaredAt}`, postgres: c.adult })

        expect(isAdultOn(c.dob, new Date(c.declaredAt))).toBe(c.adult)
      }
    } finally {
      await pool.end()
    }
  })

  it('leaves every pre-migration member alone — both columns NULL is legal', async () => {
    const pool = new Pool({ connectionString: DB_URL })
    try {
      // The whole membership on the day this shipped. If the pair constraint
      // were spelled as two NOT NULLs the migration itself would have failed,
      // but a later rewrite could reintroduce it quietly.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM accounts
          WHERE date_of_birth IS NULL AND age_declared_at IS NOT NULL`,
      )
      expect(rows[0].n).toBe('0')
    } finally {
      await pool.end()
    }
  })
})
