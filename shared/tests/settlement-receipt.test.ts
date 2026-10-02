import { describe, it, expect, vi, beforeEach } from 'vitest'
// Every link in these emails is built from APP_URL at SEND time, with no
// fallback (§0ab residual) — a suite that leaves it unset throws, by design.
process.env.APP_URL = 'https://test.all.haus'

// =============================================================================
// The per-settlement receipt (Reader Terms 5.2; compliance audit 4.5).
//
// "We will give you a receipt for every charge, itemising the pieces it covers,
// the Writers concerned and what you paid for each." Nothing of that shape
// existed: no email at settlement, no `receipt_email` on the PaymentIntent, and
// a statement row reading "Balance settled £X" that linked to nothing and named
// nobody.
//
// HOW THE MOCK ANSWERS. Per the standing rule, a mocked `pool.query` answers
// from what it is HANDED wherever it can. The two statements here are told apart
// by the table they name, and the settlement lookup is answered from its PARAMS
// — id AND reader — because the whole point of that statement is that somebody
// else's settlement and a non-existent one are the same answer. Rows are handed
// out as copies.
//
// WHAT THE MOCK CANNOT ANSWER, AND WHERE IT IS SAID OUT LOUD. `chargeable_pence`
// is a Postgres GENERATED column: only Postgres can evaluate it, so no mock can
// prove the read arm reads the right one. That half is a STRUCTURAL pin on the
// exported SQL — the read arm names `chargeable_pence` and does not name
// `amount_pence` — and is behavioural only in the DB-backed suites. The pin is
// still worth having: it is what catches the rewrite that "simplifies" the
// column back to the list price, which is the regression the whole gift rule
// exists to stop.
// =============================================================================

const sendEmail = vi.fn(async () => {})
const query = vi.fn()

vi.mock('../src/lib/email.js', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }))
vi.mock('../src/db/client.js', () => ({ pool: { query: (...a: unknown[]) => query(...(a as [])) } }))
vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  loadSettlementReceipt,
  sendSettlementReceiptEmail,
  RECEIPT_ITEMS_SQL,
  DISCHARGE_SENTENCE,
  GAP_CARRIED_PHRASE,
  GAP_UNCOVERED_PHRASE,
} = await import('../src/lib/settlement-receipt.js')

const SETTLEMENT = 'settlement-1'
const READER = 'reader-1'
const OTHER_READER = 'reader-2'

const settlementRow = {
  id: SETTLEMENT,
  amount_pence: 800,
  settled_at: new Date('2026-09-17T10:00:00Z'),
  trigger_type: 'threshold',
  reversed_at: null as Date | null,
}

type ItemRow = {
  kind: 'read' | 'subscription'
  description: string
  writer_name: string | null
  writer_username: string | null
  price_pence: number
  link: string | null
  at: Date
}

const read = (over: Partial<ItemRow> = {}): ItemRow => ({
  kind: 'read',
  description: 'The Piece',
  writer_name: 'Vita Sackville-West',
  writer_username: 'vita',
  price_pence: 300,
  link: '/article/the-piece',
  at: new Date('2026-09-16T09:00:00Z'),
  ...over,
})

/**
 * Answer from the SQL for WHICH statement, and from the PARAMS for WHOSE row.
 * The ownership term lives in the settlement statement's WHERE clause, so a mock
 * that ignored the reader id would report every receipt as everyone's — which is
 * the one thing this route must never do.
 */
function stub(opts: {
  settlement?: typeof settlementRow | null
  account?: { email: string | null } | null
  /** The address stamped on the settlement at reserve (migration 227). */
  receiptEmail?: string | null
  items?: ItemRow[]
}) {
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    // The recipient read: COALESCE(ts.receipt_email, a.email), evaluated here
    // the way Postgres would — from the params it was handed, and only if the
    // SQL actually asks for the settlement's column.
    if (/FROM accounts a/.test(sql) && /COALESCE\(ts\.receipt_email, a\.email\)/.test(sql)) {
      const acc = opts.account
      if (!acc) return { rows: [] }
      const [readerId, settlementId] = params as [string, string]
      const stamped =
        settlementId === SETTLEMENT && readerId === READER ? (opts.receiptEmail ?? null) : null
      return {
        rows: [{ email: stamped ?? acc.email, display_name: 'A Reader', username: 'areader' }],
      }
    }
    if (/FROM tab_settlements/.test(sql)) {
      const [id, readerId] = params as [string, string]
      const row = opts.settlement === undefined ? settlementRow : opts.settlement
      if (!row) return { rows: [] }
      // EVALUATE THE STATEMENT'S PREDICATE, DO NOT ASSUME IT. Applying the
      // reader term unconditionally would make this mock the thing under test:
      // deleting `reader_id = $2` from the SQL would still come back empty for a
      // stranger, and the case below would pass against a route that hands one
      // reader's receipt to anybody who guesses the id. So the term is applied
      // only if the query asks for it — mutate the SQL and the case goes red.
      if (id !== row.id) return { rows: [] }
      if (/reader_id = \$2/.test(sql) && readerId !== READER) return { rows: [] }
      return { rows: [{ ...row }] }
    }
    if (/FROM read_events/.test(sql)) {
      return { rows: (opts.items ?? [read()]).map((r) => ({ ...r })) }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
}

beforeEach(() => {
  sendEmail.mockClear()
  query.mockReset()
})

// ---------------------------------------------------------------------------

describe('the receipt reads the amount the reader actually paid', () => {
  it('takes reads from chargeable_pence and never from the list price', () => {
    const readArm = RECEIPT_ITEMS_SQL.split('UNION ALL')[0]
    expect(readArm).toMatch(/chargeable_pence/)
    // The list price has no place on a receipt: the free allowance is a gift,
    // and a read it covered cost the reader nothing (migration 164).
    expect(readArm).not.toMatch(/re\.amount_pence/)
  })

  it('shows a wholly-gifted read at £0.00, itemised beside the piece it bought', async () => {
    stub({ items: [read({ description: 'A Gift', price_pence: 0 })] })
    const receipt = await loadSettlementReceipt(SETTLEMENT, READER)
    expect(receipt!.items[0].pricePence).toBe(0)
  })
})

describe('the Writer is named as the seller (Reader Terms 1.1)', () => {
  it('carries the Writer on every item', async () => {
    stub({})
    const receipt = await loadSettlementReceipt(SETTLEMENT, READER)
    expect(receipt!.items[0].writerName).toBe('Vita Sackville-West')
    expect(receipt!.items[0].writerUsername).toBe('vita')
  })

  it('puts the Writer’s name in the email body', async () => {
    stub({ account: { email: 'reader@example.com' } })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string; htmlBody: string }
    expect(sent.textBody).toContain('Vita Sackville-West')
    expect(sent.htmlBody).toContain('Vita Sackville-West')
  })

  it('says a £0.00 line was covered by the allowance rather than leaving it bare', async () => {
    stub({
      account: { email: 'reader@example.com' },
      items: [read({ price_pence: 0 })],
    })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toMatch(/free allowance/)
  })

  it('states the discharge (Reader Terms 1.4) in the clause’s own terms', async () => {
    stub({ account: { email: 'reader@example.com' } })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toContain(DISCHARGE_SENTENCE)
  })
})

describe('what the charge covered, and what it did not', () => {
  it('reports the charged amount as the authoritative figure', async () => {
    stub({ items: [read({ price_pence: 300 }), read({ price_pence: 300 })] })
    const receipt = await loadSettlementReceipt(SETTLEMENT, READER)
    expect(receipt!.amountPence).toBe(800)
    expect(receipt!.itemisedPence).toBe(600)
  })

  it('names the gap rather than leaving two totals to be reconciled', async () => {
    // confirmSettlement stamps every accrued read at or before the snapshot,
    // including one that landed between reserve and confirm whose penny the NEXT
    // charge collects. The attribution is approximate by design.
    stub({ items: [read({ price_pence: 900 })] })
    const receipt = await loadSettlementReceipt(SETTLEMENT, READER)
    expect(receipt!.unitemisedPence).toBe(-100)
  })

  it('is zero on an ordinary receipt', async () => {
    stub({ items: [read({ price_pence: 800 })] })
    const receipt = await loadSettlementReceipt(SETTLEMENT, READER)
    expect(receipt!.unitemisedPence).toBe(0)
  })

  it('tells the reader in words when the itemised reading EXCEEDS the charge', async () => {
    stub({ account: { email: 'reader@example.com' }, items: [read({ price_pence: 900 })] })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toContain('£1.00 more than this charge')
    expect(sent.textBody).toContain(GAP_UNCOVERED_PHRASE)
    expect(sent.textBody).not.toContain(GAP_CARRIED_PHRASE)
  })

  it('names a POSITIVE gap as carried balance, never as reading on a receipt to come (§0z 19b)', async () => {
    // A charge whose locked balance carried a restored settlement or a
    // released credit: itemised 300 of an 800 charge. Pre-fix the sentence
    // promised "your next receipt", which never comes.
    stub({ account: { email: 'reader@example.com' }, items: [read({ price_pence: 300 })] })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toContain('£5.00 of this charge is balance')
    expect(sent.textBody).toContain(GAP_CARRIED_PHRASE)
    expect(sent.textBody).not.toMatch(/next receipt/)
  })

  it('says nothing about a gap when there is none', async () => {
    stub({ account: { email: 'reader@example.com' }, items: [read({ price_pence: 800 })] })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).not.toContain(GAP_CARRIED_PHRASE)
    expect(sent.textBody).not.toContain(GAP_UNCOVERED_PHRASE)
  })

  it('itemises a PUBLICATION subscription — the SQL joins the publication, not only the writer (§0z 19b)', () => {
    // Structural pin: only Postgres evaluates the join. An INNER JOIN on
    // accounts dropped every publication line, and the charge then read as
    // a positive gap.
    expect(RECEIPT_ITEMS_SQL).toMatch(/LEFT JOIN accounts w ON w\.id = se\.writer_id/)
    expect(RECEIPT_ITEMS_SQL).toMatch(/LEFT JOIN publications p ON p\.id = se\.publication_id/)
    expect(RECEIPT_ITEMS_SQL).toContain("COALESCE(w.display_name, w.username, p.name)")
  })
})

describe('the receipt is the reader’s own and nobody else’s', () => {
  it('is absent for another reader’s settlement — not refused, absent', async () => {
    stub({})
    expect(await loadSettlementReceipt(SETTLEMENT, OTHER_READER)).toBeNull()
  })

  it('is absent for a settlement that does not exist', async () => {
    stub({ settlement: null })
    expect(await loadSettlementReceipt(SETTLEMENT, READER)).toBeNull()
  })

  it('asks only for a completed settlement — a pending or failed one charged nobody', async () => {
    let seen = ''
    query.mockImplementation(async (sql: string) => {
      if (/FROM tab_settlements/.test(sql)) { seen = sql; return { rows: [] } }
      return { rows: [] }
    })
    await loadSettlementReceipt(SETTLEMENT, READER)
    expect(seen).toMatch(/status = 'completed'/)
    expect(seen).toMatch(/reader_id = \$2/)
  })
})

describe('an account with nowhere to send to', () => {
  it('sends nothing and does not throw', async () => {
    stub({ account: { email: null } })
    await expect(sendSettlementReceiptEmail(SETTLEMENT, READER)).resolves.toBeUndefined()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when the settlement is not this reader’s', async () => {
    stub({ account: { email: 'reader@example.com' } })
    await sendSettlementReceiptEmail(SETTLEMENT, OTHER_READER)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('the closure receipt goes to the address the reader HAD (§0z item 9)', () => {
  // Reader 12.1 settles the tab before the account closes, and the same
  // closure rewrites the address to the tombstone. The receipt fires on the
  // confirm, later — so it reads the address stamped on the settlement at
  // reserve, and never sends to `deleted-<id>@deleted`.
  it('sends to receipt_email when the account row now carries the tombstone', async () => {
    stub({
      account: { email: 'deleted-reader-1@deleted' },
      receiptEmail: 'departed@example.com',
    })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    expect(sendEmail).toHaveBeenCalledOnce()
    expect((sendEmail.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe('departed@example.com')
  })

  it('refuses the tombstone when nothing was stamped — a receipt to nobody is not sent', async () => {
    stub({ account: { email: 'deleted-reader-1@deleted' }, receiptEmail: null })
    await sendSettlementReceiptEmail(SETTLEMENT, READER)
    // Pre-fix: sent, to the placeholder, and counted.
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
