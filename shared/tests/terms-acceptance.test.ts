import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'
import {
  READER_TERMS_VERSION,
  WRITER_TERMS_VERSION,
  termsAcceptanceIsCurrent,
  termsMajor,
} from '../src/lib/terms-versions.js'

// =============================================================================
// The acceptance record (migration 204).
//
// Two halves, in two places. The comparison is pure and is tested here without
// a database. Everything else about the record is SQL — a CHECK constraint and
// an `IS DISTINCT FROM` in a WHERE clause — and a mocked client dispatching on
// the query text would be handed the answer it is meant to be checking. Only
// Postgres can say whether the pair constraint actually fires, or whether the
// first-write-wins predicate really matches zero rows the second time.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/terms-acceptance.test.ts
// =============================================================================

describe('terms versions — the comparison', () => {
  it('ignores the text sub-version', () => {
    // The whole point of the two-part version: a typo fix must not re-prompt
    // the membership.
    const major = termsMajor(READER_TERMS_VERSION)
    expect(termsAcceptanceIsCurrent('reader', `${major}.0`)).toBe(true)
    expect(termsAcceptanceIsCurrent('reader', `${major}.99`)).toBe(true)
    expect(termsAcceptanceIsCurrent('reader', major)).toBe(true)
  })

  it('refuses a different major, which is what re-prompts', () => {
    const next = String(Number(termsMajor(WRITER_TERMS_VERSION)) + 1)
    expect(termsAcceptanceIsCurrent('writer', `${next}.0`)).toBe(false)
  })

  it('treats never-accepted and unreadable alike: not accepted', () => {
    expect(termsAcceptanceIsCurrent('reader', null)).toBe(false)
    expect(termsAcceptanceIsCurrent('reader', undefined)).toBe(false)
    expect(termsAcceptanceIsCurrent('reader', '')).toBe(false)
    // A leading dot yields an empty major, which must fail closed rather than
    // matching another malformed value.
    expect(termsAcceptanceIsCurrent('reader', '.0')).toBe(false)
  })

  it('does not confuse the two texts', () => {
    // They happen to carry the same number today. A comparison that read the
    // wrong constant would still pass if it only ever checked one kind, so
    // both are asserted against their own.
    expect(termsAcceptanceIsCurrent('reader', READER_TERMS_VERSION)).toBe(true)
    expect(termsAcceptanceIsCurrent('writer', WRITER_TERMS_VERSION)).toBe(true)
  })
})

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('terms acceptance — the row', () => {
  let client: pg.Client
  let accountId: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, email) VALUES ($1, $2) RETURNING id`,
      ['terms'.padEnd(64, '0'), `terms-${Date.now().toString(36)}@test.local`],
    )
    accountId = rows[0].id
  })

  afterAll(async () => {
    await client.query(`DELETE FROM accounts WHERE id = $1`, [accountId])
    await client.end()
  })

  afterEach(async () => {
    await client.query(
      `UPDATE accounts
          SET reader_terms_accepted_at = NULL, reader_terms_version = NULL,
              writer_terms_accepted_at = NULL, writer_terms_version = NULL
        WHERE id = $1`,
      [accountId],
    )
  })

  /** The route's own statement, verbatim in shape. */
  const accept = (col: 'reader' | 'writer', version: string) =>
    client.query(
      `UPDATE accounts
          SET ${col}_terms_accepted_at = now(), ${col}_terms_version = $2
        WHERE id = $1
          AND ${col}_terms_version IS DISTINCT FROM $2`,
      [accountId, version],
    )

  it('starts with nothing accepted', async () => {
    const { rows } = await client.query(
      `SELECT reader_terms_accepted_at, reader_terms_version,
              writer_terms_accepted_at, writer_terms_version
         FROM accounts WHERE id = $1`,
      [accountId],
    )
    // No default and no backfill: a column that asserted an agreement nobody
    // made would be worse than the absence it replaced.
    expect(rows[0].reader_terms_accepted_at).toBeNull()
    expect(rows[0].reader_terms_version).toBeNull()
    expect(rows[0].writer_terms_accepted_at).toBeNull()
    expect(rows[0].writer_terms_version).toBeNull()
  })

  it('stamps both halves together', async () => {
    const res = await accept('reader', READER_TERMS_VERSION)
    expect(res.rowCount).toBe(1)

    const { rows } = await client.query(
      `SELECT reader_terms_accepted_at, reader_terms_version FROM accounts WHERE id = $1`,
      [accountId],
    )
    expect(rows[0].reader_terms_version).toBe(READER_TERMS_VERSION)
    expect(rows[0].reader_terms_accepted_at).not.toBeNull()
  })

  it('does not move the timestamp when the same version is re-accepted', async () => {
    await accept('reader', READER_TERMS_VERSION)
    const first = await client.query<{ at: Date }>(
      `SELECT reader_terms_accepted_at AS at FROM accounts WHERE id = $1`,
      [accountId],
    )

    const again = await accept('reader', READER_TERMS_VERSION)
    // Zero rows, which is the whole guard: the record says when this text was
    // accepted, and a retry or a second tab must not rewrite it.
    expect(again.rowCount).toBe(0)

    const second = await client.query<{ at: Date }>(
      `SELECT reader_terms_accepted_at AS at FROM accounts WHERE id = $1`,
      [accountId],
    )
    expect(second.rows[0].at.getTime()).toBe(first.rows[0].at.getTime())
  })

  it('moves both halves when a new version is accepted', async () => {
    await accept('reader', '1.0')
    const res = await accept('reader', '2.0')
    expect(res.rowCount).toBe(1)
    const { rows } = await client.query(
      `SELECT reader_terms_version FROM accounts WHERE id = $1`,
      [accountId],
    )
    expect(rows[0].reader_terms_version).toBe('2.0')
  })

  it('accepting one text leaves the other untouched', async () => {
    await accept('reader', READER_TERMS_VERSION)
    const { rows } = await client.query(
      `SELECT writer_terms_accepted_at, writer_terms_version FROM accounts WHERE id = $1`,
      [accountId],
    )
    expect(rows[0].writer_terms_accepted_at).toBeNull()
    expect(rows[0].writer_terms_version).toBeNull()
  })

  it('refuses a timestamp with no version', async () => {
    // The CHECK is written as an equality between two IS NULL tests precisely
    // so that it is not vacuously satisfied by a half-filled pair.
    await expect(
      client.query(
        `UPDATE accounts SET reader_terms_accepted_at = now() WHERE id = $1`,
        [accountId],
      ),
    ).rejects.toThrow(/accounts_reader_terms_pair_chk/)
  })

  it('refuses a version with no timestamp', async () => {
    await expect(
      client.query(`UPDATE accounts SET writer_terms_version = $2 WHERE id = $1`, [
        accountId,
        WRITER_TERMS_VERSION,
      ]),
    ).rejects.toThrow(/accounts_writer_terms_pair_chk/)
  })
})
