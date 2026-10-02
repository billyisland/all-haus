import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// `logSubscriptionCharge` — a registered money path that had no test.
//
// It is the only writer of a subscription's two `subscription_events` rows and
// the only place a subscription touches the reading tab, and it is reached from
// three call sites (writer subscribe, publication subscribe, the hourly renewal
// worker). The existing coverage tests those CALLERS with this function mocked
// (`subscription-expiry.test.ts` asserts what it was HANDED), which is the trap
// the mock rule names: it pins the arguments and says nothing about what the
// function does with them.
//
// Four things are pinned here, each of which is silent and each of which moves
// money in the reassuring direction when it is wrong:
//
//   1. The platform fee FLOORS (F11). `Math.round` is a second definition of
//      "net" and disagrees with every other money path by a penny per charge.
//   2. The reader leg goes through `applyLedgerDelta` — the ONE writer of
//      `reading_tabs.balance_pence` — at the FULL price, positive (a debt, like
//      a read accrual), referencing the CHARGE event, not the earning.
//   3. The collection gate. A post-charge balance <= 0 means pre-paid credit
//      already covered it, so no settlement will ever fire for it and the
//      earning is payable now (`settled_at` stamped); above zero it stays NULL
//      until `confirmSettlement`. Stamp it wrongly one way and the writer's
//      money strands for ever; the other way and the cycle pays out money the
//      platform has not collected.
//   4. A PUBLICATION subscription posts NO `subscription_earning` ledger entry.
//      Publication money enters the ledger at payout time, per split — posting
//      it here as well would count it twice and the pool would distribute the
//      double.
// =============================================================================

const mockLoadConfig = vi.fn()
const mockApplyLedgerDelta = vi.fn()
const mockRecordLedger = vi.fn()

vi.mock('@platform-pub/shared/db/client.js', () => ({
  loadConfig: (...a: any[]) => mockLoadConfig(...a),
  pool: { query: vi.fn() },
}))

vi.mock('@platform-pub/shared/lib/ledger.js', () => ({
  applyLedgerDelta: (...a: any[]) => mockApplyLedgerDelta(...a),
  recordLedger: (...a: any[]) => mockRecordLedger(...a),
}))

import { logSubscriptionCharge } from '../src/routes/subscriptions/shared.js'

const READER = 'reader-1'
const WRITER = 'writer-1'
const PUB = 'pub-1'
const SUB = 'sub-1'
const START = new Date('2026-03-01T00:00:00.000Z')
const END = new Date('2026-04-01T00:00:00.000Z')

interface Call { sql: string; params: any[] }

/** A client whose `query` answers from the SQL it is handed, and records both
 *  the statement and its params so the order and the references can be read
 *  back. The two INSERTs differ by their `settled_at` column, which is the
 *  discriminator the production statements actually carry. */
function makeClient() {
  const calls: Call[] = []
  const client = {
    query: vi.fn(async (sql: string, params: any[]) => {
      calls.push({ sql, params })
      if (/INSERT INTO subscription_events/.test(sql)) {
        return {
          rows: [{ id: /settled_at/.test(sql) ? 'earning-event-1' : 'charge-event-1' }],
        }
      }
      throw new Error(`unexpected statement: ${sql.slice(0, 80)}`)
    }),
  }
  return { client, calls }
}

beforeEach(() => {
  mockLoadConfig.mockReset()
  mockApplyLedgerDelta.mockReset()
  mockRecordLedger.mockReset()
  mockLoadConfig.mockResolvedValue({ platformFeeBps: 800 })
  // Default: the charge left the tab in debt, so nothing is collected yet.
  mockApplyLedgerDelta.mockResolvedValue({ ledgerId: 'l1', balancePence: 500, tabId: 't1', quarantined: null })
})

describe('the platform fee floors', () => {
  it('takes the floor, not the round, of price x bps', async () => {
    // 1310p at 800bps = 104.8p. Floor 104 (net 1206); round 105 (net 1205).
    // The two differ, which is the only reason this case can tell them apart.
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 1310, START, END)

    const earning = calls.find(c => /settled_at/.test(c.sql))!
    expect(earning.params[4]).toBe(1206)
    expect(mockRecordLedger.mock.calls[0][1].amountPence).toBe(1206)
  })

  it('never rounds a sub-penny fee up to a penny', async () => {
    // 10p at 800bps = 0.8p. Floor 0 — the writer keeps all 10.
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 10, START, END)
    expect(calls.find(c => /settled_at/.test(c.sql))!.params[4]).toBe(10)
  })
})

describe('the reader leg', () => {
  it('debits the FULL price through applyLedgerDelta, referencing the charge event', async () => {
    const { client } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)

    expect(mockApplyLedgerDelta).toHaveBeenCalledOnce()
    const [passedClient, input] = mockApplyLedgerDelta.mock.calls[0]
    // The CALLER'S client, so the movement rides whatever transaction the call
    // site opened — the same identity assertion the relay-outbox invariant makes.
    expect(passedClient).toBe(client)
    expect(input.accountId).toBe(READER)
    expect(input.counterpartyId).toBe(WRITER)
    // Positive: a debt on the tab. The mirror entry's sign is DERIVED from this
    // by the primitive, which is what stops the two disagreeing.
    expect(input.deltaPence).toBe(500)
    expect(input.triggerType).toBe('subscription_charge')
    expect(input.refTable).toBe('subscription_events')
    // The charge row, never the earning row: a ledger entry that references the
    // wrong side is a reconciliation orphan.
    expect(input.refId).toBe('charge-event-1')
  })

  it('creates the charge event BEFORE moving the tab, so the entry has something to reference', async () => {
    const { client, calls } = makeClient()
    let deltaAtCall = -1
    mockApplyLedgerDelta.mockImplementation(async () => {
      deltaAtCall = calls.length
      return { ledgerId: 'l1', balancePence: 500, tabId: 't1' }
    })
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)
    expect(deltaAtCall).toBe(1)
    expect(calls[0].sql).toMatch(/INSERT INTO subscription_events/)
    expect(calls[0].sql).not.toMatch(/settled_at/)
  })

  it('runs for a PUBLICATION subscription too — collection is not the writer leg', async () => {
    const { client } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, null, 500, START, END, PUB)
    expect(mockApplyLedgerDelta).toHaveBeenCalledOnce()
    expect(mockApplyLedgerDelta.mock.calls[0][1].deltaPence).toBe(500)
    expect(mockApplyLedgerDelta.mock.calls[0][1].counterpartyId).toBeNull()
  })
})

describe('the collection gate', () => {
  // A SETTLEMENT SETTLES AN EARNING, AND A SIGN TEST NEVER DOES (L3.2,
  // migration 206).
  //
  // This was `chargeCollected = balancePence <= 0`, on the reading that a
  // post-charge balance at or below zero meant the charge had been funded by
  // pre-paid credit and was therefore already collected — so it stamped the
  // writer's earning `settled_at` there and then, and the payout cycle paid it.
  // The money that "covered" it was a CREDIT: money the platform over-collected
  // from that reader and owes back. A reader's credit was settling a writer's
  // earning, which is 4.3 ("we will not … let you spend it") and 11.1 (reading
  // and writing are separate) broken by one comparison.
  //
  // THE OLD BOUNDARY CASES ARE KEPT AND THEIR EXPECTATION INVERTED, rather than
  // deleted. They are unreachable now — `applyLedgerDelta` quarantines a credit
  // the moment it would exist, so the balance comes back at zero or above, and a
  // charge on a tab that cannot be negative always leaves a positive one — but
  // a test that simply stopped feeding the old shapes would no longer say
  // anything about them. Feeding them and demanding NULL is what makes
  // reinstating the sign test a red suite rather than a silent regression.
  it('leaves settled_at NULL while the tab is in debt', async () => {
    mockApplyLedgerDelta.mockResolvedValue({ ledgerId: 'l1', balancePence: 1, tabId: 't1', quarantined: null })
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)
    expect(calls.find(c => /settled_at/.test(c.sql))!.params[8]).toBeNull()
  })

  it('leaves settled_at NULL even if the balance comes back NEGATIVE', async () => {
    // The shape that used to stamp. A negative balance here would mean the
    // quarantine did not happen — a broken invariant, not a collected charge —
    // and paying a writer out of it is the last thing to do about that.
    mockApplyLedgerDelta.mockResolvedValue({ ledgerId: 'l1', balancePence: -250, tabId: 't1', quarantined: null })
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)
    expect(calls.find(c => /settled_at/.test(c.sql))!.params[8]).toBeNull()
  })

  it('leaves settled_at NULL at exactly zero — the old boundary, now just a tab with nothing on it', async () => {
    mockApplyLedgerDelta.mockResolvedValue({ ledgerId: 'l1', balancePence: 0, tabId: 't1', quarantined: null })
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)
    expect(calls.find(c => /settled_at/.test(c.sql))!.params[8]).toBeNull()
  })

  it('leaves settled_at NULL when the charge itself produced a quarantine', async () => {
    // Nothing produces this today, and if something ever does, the earning is
    // the one thing that must NOT be settled by it.
    mockApplyLedgerDelta.mockResolvedValue({
      ledgerId: 'l1',
      balancePence: 0,
      tabId: 't1',
      quarantined: { creditId: 'c1', ledgerId: 'l2', amountPence: 250 },
    })
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)
    expect(calls.find(c => /settled_at/.test(c.sql))!.params[8]).toBeNull()
  })
})

describe('the writer leg is writer-subscriptions only', () => {
  it('posts subscription_earning for a WRITER subscription', async () => {
    const { client } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, WRITER, 500, START, END)

    expect(mockRecordLedger).toHaveBeenCalledOnce()
    const [passedClient, entry] = mockRecordLedger.mock.calls[0]
    expect(passedClient).toBe(client)
    expect(entry.accountId).toBe(WRITER)
    expect(entry.counterpartyId).toBe(READER)
    expect(entry.triggerType).toBe('subscription_earning')
    expect(entry.refTable).toBe('subscription_events')
    expect(entry.refId).toBe('earning-event-1')
    expect(entry.amountPence).toBe(460) // 500 − floor(500 * 800 / 10000)
  })

  it('posts NO ledger entry for a PUBLICATION subscription', async () => {
    const { client, calls } = makeClient()
    await logSubscriptionCharge(client as any, SUB, READER, null, 500, START, END, PUB)

    // The earning EVENT is still written — the pool cycle claims it via
    // publication_payout_id — but it must not enter the ledger here, or the
    // split entries at payout time count the same money a second time.
    const earning = calls.find(c => /settled_at/.test(c.sql))!
    expect(earning.params[3]).toBe(PUB)
    expect(earning.params[4]).toBe(460)
    expect(mockRecordLedger).not.toHaveBeenCalled()
  })
})
