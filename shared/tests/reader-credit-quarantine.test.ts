import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'

// =============================================================================
// A reading tab is never in credit: the over-collection is moved OUT.
//
// Reader Terms 4.2 — the tab "is a record of what you owe, not an account
// holding your money … not a payment account, a wallet, a stored-value facility
// or a balance". Reader Terms 4.3 — a credit "will be refunded to the payment
// method it came from. We will not show it to you as a balance or let you spend
// it."
//
// The second half of 4.3 was false in the arithmetic, whatever any surface
// said: a reader at −500 who read a 200p piece went to −300, nothing was
// charged, and the writer was never paid. The credit paid for the reading. So
// `applyLedgerDelta` now quarantines: a movement that would leave the balance
// below zero is followed by a second, exactly-mirrored leg taking the tab back
// to zero and opening a `reader_credits` payable.
//
// DB-BACKED BECAUSE EVERY CLAIM HERE IS POSTGRES'S. The quarantine's whole
// point is the parity anchor `balance_pence == −SUM(reader ledger entries)`,
// which is a view over a table — a mocked client would be handed the answer it
// is meant to be checking, and `reader_balance_parity` is a HALTING check, so
// getting this wrong freezes every payout on the platform on every run.
// `reader_credits`'s shape constraint is a CHECK, which only Postgres evaluates.
//
// It drives the REAL primitive rather than a copy of its statements: a test that
// retypes production SQL passes for exactly as long as nobody edits the original.
//
// Every case runs inside a transaction that is ROLLED BACK. The ledger is
// append-only — the DB refuses UPDATE and DELETE on it — so there is no other
// way to run this against a real database without leaving entries behind.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/reader-credit-quarantine.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('applyLedgerDelta — the tab never holds a credit', () => {
  let client: pg.Client
  let ledger: typeof import('../src/lib/ledger.js')
  let readerId: string
  // A row the movements can point at. Any existing table works — the quarantine
  // carries the source ref through opaquely, which is the point of storing it
  // as (table, id) rather than as a settlement.
  const REF_TABLE = 'tab_settlements'
  let refId: string
  let otherRefId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
    ledger = await import('../src/lib/ledger.js')
    // Two uuids that need not exist: `ledger_entries.ref_id` carries no FK, and
    // the orphan check is a reconciliation concern, not a write-time one.
    const { rows } = await client.query<{ a: string; b: string }>(
      `SELECT gen_random_uuid() AS a, gen_random_uuid() AS b`,
    )
    refId = rows[0].a
    otherRefId = rows[0].b
  })

  afterAll(async () => {
    await client.end()
  })

  beforeEach(async () => {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, email) VALUES ($1, $2) RETURNING id`,
      [`credq${Date.now().toString(36)}`.padEnd(64, '0'), null],
    )
    readerId = rows[0].id
  })

  afterEach(async () => {
    await client.query('ROLLBACK')
  })

  const c = () => client as unknown as pg.PoolClient

  const move = (deltaPence: number, triggerType: any, ref = refId) =>
    ledger.applyLedgerDelta(c(), {
      accountId: readerId,
      counterpartyId: null,
      deltaPence,
      triggerType,
      refTable: REF_TABLE,
      refId: ref,
    })

  const tab = async () => {
    const { rows } = await client.query<{ balance_pence: string }>(
      `SELECT balance_pence FROM reading_tabs WHERE reader_id = $1`,
      [readerId],
    )
    return rows.length === 0 ? null : Number(rows[0].balance_pence)
  }

  const ledgerBalance = async () => {
    const { rows } = await client.query<{ balance_pence: string }>(
      `SELECT balance_pence FROM ledger_reader_balance WHERE account_id = $1`,
      [readerId],
    )
    return rows.length === 0 ? 0 : Number(rows[0].balance_pence)
  }

  const credits = async () => {
    const { rows } = await client.query(
      `SELECT amount_pence, status, source_ref_table, source_ref_id,
              quarantine_ledger_entry_id, release_ledger_entry_id, resolved_at
         FROM reader_credits WHERE reader_id = $1 ORDER BY created_at`,
      [readerId],
    )
    return rows.map((r: any) => ({ ...r, amount_pence: Number(r.amount_pence) }))
  }

  /** THE HALTING INVARIANT. `reader_balance_parity` compares exactly these two
   * and freezes every payout on the platform when they disagree, so it is
   * asserted after every case rather than in one of them. */
  const expectParity = async () => {
    expect(await tab(), 'reading_tabs.balance_pence vs ledger_reader_balance')
      .toBe(await ledgerBalance())
  }

  it('leaves an ordinary movement completely alone', async () => {
    const r = await move(250, 'read_accrual')

    expect(r.quarantined).toBeNull()
    expect(r.balancePence).toBe(250)
    expect(await credits()).toEqual([])
    // No second leg: an ordinary movement posts exactly one entry, as before.
    const { rows } = await client.query(
      `SELECT trigger_type FROM ledger_entries WHERE account_id = $1`,
      [readerId],
    )
    expect(rows.map((x: any) => x.trigger_type)).toEqual(['read_accrual'])
    await expectParity()
  })

  it('moves the over-collection out the moment it would exist', async () => {
    await move(300, 'read_accrual')
    // A settlement collecting 900 against a 300 debt — the double-charge shape.
    const r = await move(-900, 'tab_settlement')

    expect(r.quarantined).not.toBeNull()
    expect(r.quarantined!.amountPence).toBe(600)
    // Zero, not −600: there is nothing in the tab to spend.
    expect(r.balancePence).toBe(0)
    expect(await tab()).toBe(0)

    const rows = await credits()
    expect(rows).toHaveLength(1)
    expect(rows[0].amount_pence).toBe(600)
    expect(rows[0].status).toBe('pending_refund')
    expect(rows[0].resolved_at).toBeNull()
    // The payable names what over-collected, so the release can find it.
    expect(rows[0].source_ref_table).toBe(REF_TABLE)
    expect(rows[0].source_ref_id).toBe(refId)
    expect(rows[0].quarantine_ledger_entry_id).toBe(r.quarantined!.ledgerId)

    await expectParity()
  })

  it('posts the causing movement IN FULL — it is not a clamp', async () => {
    await move(300, 'read_accrual')
    await move(-900, 'tab_settlement')

    const { rows } = await client.query(
      `SELECT trigger_type, amount_pence FROM ledger_entries
        WHERE account_id = $1 ORDER BY created_at, trigger_type`,
      [readerId],
    )
    const entries = rows.map((x: any) => [x.trigger_type, Number(x.amount_pence)])
    // The settlement's own entry is the full +900 it collected. A clamp would
    // have shrunk one side of that pair, which is the divergence bug class the
    // primitive exists to abolish; the quarantine is a SEPARATE −600 movement.
    expect(entries).toContainEqual(['tab_settlement', 900])
    expect(entries).toContainEqual(['credit_quarantine', -600])
    await expectParity()
  })

  it('does NOT let the credit pay for the next read', async () => {
    // THE CASE THE WHOLE CHANGE IS FOR. Before: a −600 tab reading a 200p piece
    // went to −400, nothing was charged, the writer was never paid, and the
    // reader had spent a credit Reader Terms 4.3 says they cannot spend.
    await move(-600, 'tab_settlement')
    expect(await tab()).toBe(0)

    const r = await move(200, 'read_accrual')

    // They owe the full 200. The debt is real and collectible.
    expect(r.balancePence).toBe(200)
    expect(await tab()).toBe(200)
    // And the payable is untouched — we still owe them the whole 600.
    const rows = await credits()
    expect(rows).toHaveLength(1)
    expect(rows[0].amount_pence).toBe(600)
    expect(rows[0].status).toBe('pending_refund')
    await expectParity()
  })

  it('never reports a negative balance to a caller that branches on it', async () => {
    // `logSubscriptionCharge` read this value and called a charge already
    // collected when it was <= 0, stamping the writer's earning settled — a
    // reader's credit settling a writer's money. The value it now sees cannot
    // be negative.
    await move(-600, 'tab_settlement')
    const r = await move(500, 'subscription_charge')
    expect(r.balancePence).toBe(500)
    expect(r.balancePence).toBeGreaterThan(0)
    await expectParity()
  })

  it('opens a payable per over-collection, not one running total', async () => {
    await move(-100, 'tab_settlement')
    await move(-250, 'tab_settlement', otherRefId)

    const rows = await credits()
    expect(rows.map((r) => r.amount_pence)).toEqual([100, 250])
    // Each names its own source, which is what lets a reversal release exactly
    // the one it caused and leave the other standing.
    expect(rows.map((r) => r.source_ref_id)).toEqual([refId, otherRefId])
    await expectParity()
  })

  describe('releaseReaderCredit — the inverse, for a reversed over-collection', () => {
    it('returns the money to the tab as debt and closes the payable', async () => {
      await move(300, 'read_accrual')
      await move(-900, 'tab_settlement') // tab 0, payable 600
      expect(await tab()).toBe(0)

      // The reversal's real order: restore the debt FIRST, then release.
      await move(900, 'tab_settlement_reversal')
      expect(await tab()).toBe(900)

      const released = await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })

      expect(released).not.toBeNull()
      expect(released!.amountPence).toBe(600)
      // Back to the 300 they actually owed all along: the reversal put 900 back
      // and the release took out the 600 that was never theirs to owe.
      expect(await tab()).toBe(300)

      const rows = await credits()
      expect(rows[0].status).toBe('released')
      expect(rows[0].resolved_at).not.toBeNull()
      expect(rows[0].release_ledger_entry_id).not.toBeNull()
      await expectParity()
    })

    it('releases only the payable its OWN source produced', async () => {
      await move(-100, 'tab_settlement')
      await move(-250, 'tab_settlement', otherRefId)

      await move(100, 'tab_settlement_reversal')
      await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })

      const rows = await credits()
      expect(rows.find((r) => r.source_ref_id === refId)!.status).toBe('released')
      // The other settlement's credit is still owed. Releasing it here would be
      // taking back money on the strength of an unrelated reversal.
      expect(rows.find((r) => r.source_ref_id === otherRefId)!.status).toBe('pending_refund')
      await expectParity()
    })

    it('is a no-op where nothing was over-collected', async () => {
      await move(300, 'read_accrual')
      const released = await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })
      expect(released).toBeNull()
      expect(await tab()).toBe(300)
      await expectParity()
    })

    it('will not release a payable whose refund is at Stripe (§0z item 19a)', async () => {
      await move(300, 'read_accrual')
      await move(-900, 'tab_settlement') // payable 600
      // The refund path's claim: the money may be leaving Stripe right now.
      // The reservation as the refund path writes it — the CHECK requires the
      // reason, the actor and the charge beside the timestamp.
      await client.query(
        `UPDATE reader_credits
            SET refund_reserved_at = now(), refund_reason = 'test', refund_actor_id = $1,
                refund_charge_id = 'ch_test', refund_attempt = 1
          WHERE reader_id = $1 AND status = 'pending_refund'`,
        [readerId],
      )
      await move(900, 'tab_settlement_reversal')

      const released = await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })
      // Pre-fix: released, and the reader had the refund AND the restored
      // debt. Now the reversal restores the whole charge and the refund's own
      // confirm closes the row — the same net position, and no hand needed.
      expect(released).toBeNull()
      const rows = await credits()
      expect(rows[0].status).toBe('pending_refund')
      expect(await tab()).toBe(900)
    })

    it('will not release a payable that has already been refunded', async () => {
      // L3.1's action pays the money outward and marks the row `refunded`. If a
      // reversal then released it too, the reader would have the refund AND the
      // debt taken off their tab — paid twice for one over-collection.
      await move(-600, 'tab_settlement')
      // Written the way L3.1's confirm writes it, because migration 207's
      // `reader_credits_refund_evidence` CHECK refuses a `refunded` row that
      // carries no refund: the status is a record, not a claim. A fixture that
      // sets the status alone no longer reaches the state this test is about —
      // which is the constraint working.
      const { rows: refundLeg } = await client.query<{ id: string }>(
        `INSERT INTO ledger_entries (account_id, counterparty_id, amount_pence,
                                     trigger_type, ref_table, ref_id)
         VALUES ($1, NULL, 600, 'credit_refund', 'reader_credits',
                 (SELECT id FROM reader_credits WHERE reader_id = $1))
         RETURNING id`,
        [readerId],
      )
      await client.query(
        `UPDATE reader_credits
            SET status = 'refunded', resolved_at = now(), stripe_refund_id = 're_test',
                refund_charge_id = 'ch_test', refund_reason = 'the money went back',
                refund_ledger_entry_id = $2
          WHERE reader_id = $1`,
        [readerId, refundLeg[0].id],
      )

      await move(600, 'tab_settlement_reversal')
      const released = await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })

      expect(released).toBeNull()
      expect(await tab()).toBe(600)
      await expectParity()
    })

    it('does not re-quarantine what it releases', async () => {
      // The ordering hazard, stated as a test. The release moves the tab DOWN,
      // so run before the restore it would drive the balance negative and the
      // quarantine would fire on it — closing one payable and opening an
      // identical one, for ever. Restore-then-release leaves exactly one row.
      await move(-600, 'tab_settlement')
      await move(600, 'tab_settlement_reversal')
      await ledger.releaseReaderCredit(c(), {
        accountId: readerId,
        refTable: REF_TABLE,
        refId,
      })
      expect(await credits()).toHaveLength(1)
      expect(await tab()).toBe(0)
      await expectParity()
    })
  })

  it('refuses a payable that claims to be both open and resolved', async () => {
    // The shape constraint, written NULL-safe because a CHECK is satisfied by
    // NULL — proved by trying to set the column NULL as well as by the pair.
    await move(-600, 'tab_settlement')
    await expect(
      client.query(
        `UPDATE reader_credits SET status = 'released' WHERE reader_id = $1`,
        [readerId],
      ),
    ).rejects.toThrow(/reader_credits_resolution_shape/)
  })
})
