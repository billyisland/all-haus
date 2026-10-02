import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'
import { READER_TERMS_VERSION } from '../src/lib/terms-versions.js'

// =============================================================================
// Registering a card IS accepting the Reader Terms (operator decision A3).
//
// `connectPaymentMethod` writes both facts in ONE statement, because they are
// one fact: a card recorded without the acceptance is a reading tab running
// against a text nobody agreed to, and an acceptance recorded without the card
// is a record of nothing. Two sequential UPDATEs could half-happen; one cannot.
//
// DB-BACKED BECAUSE THE RULE IS ENTIRELY IN THE SQL. The first-write-wins half
// is a CASE expression inside the SET list, and the pair constraint is a CHECK
// — a mocked client dispatching on the query text would be handed the answer it
// is meant to be checking. Only Postgres can say whether the timestamp really
// stays put on a card replacement, or whether the constraint fires.
//
// It drives the REAL function rather than a copy of its statement: a test that
// retypes production SQL passes for as long as the copy is right, which is
// exactly as long as nobody edits the original.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/connect-card-terms.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('connectPaymentMethod — the card and the acceptance', () => {
  let client: pg.Client
  let accounts: typeof import('../src/auth/accounts.js')
  let accountId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
    accounts = await import('../src/auth/accounts.js')

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, email) VALUES ($1, $2) RETURNING id`,
      ['card'.padEnd(64, '0'), `card-${Date.now().toString(36)}@test.local`],
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
          SET stripe_customer_id = NULL,
              card_action_required_at = NULL,
              reader_terms_accepted_at = NULL,
              reader_terms_version = NULL
        WHERE id = $1`,
      [accountId],
    )
  })

  const read = async () => {
    const { rows } = await client.query<{
      stripe_customer_id: string | null
      card_action_required_at: Date | null
      reader_terms_accepted_at: Date | null
      reader_terms_version: string | null
    }>(
      `SELECT stripe_customer_id, card_action_required_at,
              reader_terms_accepted_at, reader_terms_version
         FROM accounts WHERE id = $1`,
      [accountId],
    )
    return rows[0]
  }

  it('records the card and the acceptance together', async () => {
    await accounts.connectPaymentMethod(accountId, 'cus_one', READER_TERMS_VERSION)

    const row = await read()
    expect(row.stripe_customer_id).toBe('cus_one')
    expect(row.reader_terms_version).toBe(READER_TERMS_VERSION)
    expect(row.reader_terms_accepted_at).not.toBeNull()
  })

  it('leaves the timestamp alone when the same reader replaces their card', async () => {
    await accounts.connectPaymentMethod(accountId, 'cus_one', READER_TERMS_VERSION)
    const first = await read()

    await accounts.connectPaymentMethod(accountId, 'cus_two', READER_TERMS_VERSION)
    const second = await read()

    // The card moved; WHEN they accepted this text did not. Replace the CASE
    // expression with a bare `now()` and this is the case that goes red.
    expect(second.stripe_customer_id).toBe('cus_two')
    expect(second.reader_terms_accepted_at!.getTime()).toBe(
      first.reader_terms_accepted_at!.getTime(),
    )
  })

  it('moves both halves when the reader accepts a NEWER text', async () => {
    await accounts.connectPaymentMethod(accountId, 'cus_one', '1.0')
    const first = await read()

    await accounts.connectPaymentMethod(accountId, 'cus_one', '2.0')
    const second = await read()

    expect(second.reader_terms_version).toBe('2.0')
    expect(second.reader_terms_accepted_at!.getTime()).toBeGreaterThanOrEqual(
      first.reader_terms_accepted_at!.getTime(),
    )
  })

  it('still clears the settlement back-off flag (STRIPE audit S1)', async () => {
    // The behaviour that was already here has to survive the change: a reader
    // re-attaching a card after a terminal decline is what unfreezes their tab.
    await client.query(
      `UPDATE accounts SET card_action_required_at = now() WHERE id = $1`,
      [accountId],
    )
    await accounts.connectPaymentMethod(accountId, 'cus_one', READER_TERMS_VERSION)
    expect((await read()).card_action_required_at).toBeNull()
  })

  it('satisfies the pair constraint — never a version without a timestamp', async () => {
    // `accounts_reader_terms_pair_chk` is NULL-safe, so it would fire on a
    // statement that set only one half. Reaching this line at all is the
    // assertion; the explicit read is what says which half landed.
    await accounts.connectPaymentMethod(accountId, 'cus_one', READER_TERMS_VERSION)
    const row = await read()
    expect(row.reader_terms_version === null).toBe(row.reader_terms_accepted_at === null)
  })
})
