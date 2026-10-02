import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'
import { recordConfigAudit } from '../src/lib/config-audit.js'

// =============================================================================
// THE SHAPE OF THE EVIDENCE (L5.2, migration 209).
//
// The route refuses a blank reason and the client disables the button, but
// neither is the guarantee: a route's schema is one door, and there are always
// more doors than the one you were thinking about (a psql prompt, a future
// service, a script). The column's own CHECK is the wall, and the append-only
// trigger is what makes the record evidence rather than a note the operator can
// edit afterwards.
//
// WHY DB-BACKED. Every claim here is one only Postgres can evaluate: a CHECK
// over `btrim`, two triggers, and a foreign key. A mocked client would answer
// whatever this file's author decided, which is the reverse of the question.
//
// It drives the REAL helper (`recordConfigAudit`) inside a transaction that is
// always rolled back.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and
// FAILS on a skip). Run locally against the dev DB:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/config-audit-shape-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('config_audit — the shape of an operator record', () => {
  let client: pg.Client
  let adminId: string
  let subjectId: string

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')
    adminId = await insertAccount()
    subjectId = await insertAccount()
  })
  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  let seq = 0
  const uniq = () => `cfgaudit-${Date.now().toString(36)}-${seq++}`

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, '0')],
    )
    return rows[0].id
  }

  const base = () => ({
    actorAccountId: adminId,
    key: 'platform_fee_bps',
    oldValue: '800',
    newValue: '1000',
    reason: 'the quarterly retune we agreed',
  })

  async function only(): Promise<Record<string, unknown>> {
    const { rows } = await client.query(
      `SELECT * FROM config_audit WHERE actor_account_id = $1`,
      [adminId],
    )
    expect(rows).toHaveLength(1)
    return rows[0]
  }

  // --- what a good row looks like -------------------------------------------

  it('stores the whole act: actor, key, both values, reason and when', async () => {
    await recordConfigAudit(client, base())

    const row = await only()
    expect(row.actor_account_id).toBe(adminId)
    expect(row.key).toBe('platform_fee_bps')
    expect(row.old_value).toBe('800')
    expect(row.new_value).toBe('1000')
    expect(row.reason).toBe('the quarterly retune we agreed')
    expect(row.subject_account_id).toBeNull()
    expect(row.changed_at).toBeInstanceOf(Date)
  })

  it('accepts a NULL new_value — that is a key being DELETED, which is how a halt is released', async () => {
    // Not a corner case: `payouts_halted` is presence-means-halted, so the
    // whole second act this table exists for writes a NULL here. A NOT NULL
    // column would have forced that act to record a lie or stay unrecorded.
    await recordConfigAudit(client, {
      actorAccountId: adminId,
      key: 'payouts_halted',
      oldValue: 'true',
      newValue: null,
      reason: 'reconciled the orphan by hand',
    })

    const row = await only()
    expect(row.new_value).toBeNull()
    expect(row.old_value).toBe('true')
  })

  it('carries the W4 per-account subject as a JOINABLE column, not a string', async () => {
    await recordConfigAudit(client, {
      actorAccountId: adminId,
      key: 'payouts_halted',
      subjectAccountId: subjectId,
      oldValue: 'ledger_orphans',
      newValue: null,
      reason: 'stale pending payout, cleared',
    })

    // The point of the column: the first question about a per-account release
    // is which account, and an id inside a key string is an id nothing joins on.
    const { rows } = await client.query(
      `SELECT ca.reason, a.nostr_pubkey
         FROM config_audit ca JOIN accounts a ON a.id = ca.subject_account_id
        WHERE ca.actor_account_id = $1`,
      [adminId],
    )
    expect(rows).toHaveLength(1)
  })

  // --- the wall --------------------------------------------------------------

  it('REFUSES a blank reason — the CHECK, not the route, is the guarantee', async () => {
    await expect(
      recordConfigAudit(client, { ...base(), reason: '' }),
    ).rejects.toThrow(/config_audit_reason_present/)
  })

  it('REFUSES a reason that is only whitespace', async () => {
    // `btrim` is why: a required field that accepts " " is required in name
    // only, and a length check alone would have let this through.
    await expect(
      recordConfigAudit(client, { ...base(), reason: '   \n\t ' }),
    ).rejects.toThrow(/config_audit_reason_present/)
  })

  it('REFUSES an actor who is not an account', async () => {
    await expect(
      recordConfigAudit(client, {
        ...base(),
        actorAccountId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(/config_audit_actor_account_id_fkey/)
  })

  // --- append-only -----------------------------------------------------------

  it('cannot be EDITED afterwards', async () => {
    await recordConfigAudit(client, base())
    await expect(
      client.query(`UPDATE config_audit SET reason = 'something else' WHERE actor_account_id = $1`, [
        adminId,
      ]),
    ).rejects.toThrow(/append-only/)
  })

  it('cannot be DELETED afterwards', async () => {
    await recordConfigAudit(client, base())
    await expect(
      client.query(`DELETE FROM config_audit WHERE actor_account_id = $1`, [adminId]),
    ).rejects.toThrow(/append-only/)
  })
})
