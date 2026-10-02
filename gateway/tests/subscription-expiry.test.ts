import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — the worker pulls in the DB pool, a transaction helper, Nostr signing,
// the relay outbox, subscription emails, the charge-logger, and the logger.
// We replace all of them so the unit test exercises pure renewal logic.
// ---------------------------------------------------------------------------

const mockPoolQuery = vi.fn()
// Per-transaction recorded client.query calls live here so assertions can read
// exactly what the renewal transaction issued.
let txCalls: Array<{ sql: string; params: any[] }> = []
const runTransaction = async (cb: (client: any) => Promise<any>) => {
  const client = {
    query: (sql: string, params: any[] = []) => {
      txCalls.push({ sql, params })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
  }
  return cb(client)
}
const withTransactionImpl = vi.fn(runTransaction)

vi.mock('@platform-pub/shared/db/client.js', () => ({
  pool: { query: (...args: any[]) => mockPoolQuery(...args) },
  withTransaction: (cb: any) => withTransactionImpl(cb),
}))

const signSubscriptionEvent = vi.fn(() => ({ id: 'evt-mock' }))
vi.mock('../src/lib/nostr-publisher.js', () => ({
  signSubscriptionEvent: (...args: any[]) => signSubscriptionEvent(...args),
}))

const enqueueRelayPublish = vi.fn(async () => undefined)
vi.mock('@platform-pub/shared/lib/relay-outbox.js', () => ({
  enqueueRelayPublish: (...args: any[]) => enqueueRelayPublish(...args),
}))

const sendSubscriptionRenewedEmail = vi.fn(async () => undefined)
const sendSubscriptionExpiryWarningEmail = vi.fn(async () => undefined)
const sendSubscriptionLapsedNotForSaleEmail = vi.fn(async () => undefined)
vi.mock('@platform-pub/shared/lib/subscription-emails.js', () => ({
  sendSubscriptionRenewedEmail: (...a: any[]) => sendSubscriptionRenewedEmail(...a),
  sendSubscriptionExpiryWarningEmail: (...a: any[]) => sendSubscriptionExpiryWarningEmail(...a),
  sendSubscriptionLapsedNotForSaleEmail: (...a: any[]) => sendSubscriptionLapsedNotForSaleEmail(...a),
}))

const logSubscriptionCharge = vi.fn(async () => undefined)
vi.mock('../src/routes/subscriptions/index.js', () => ({
  logSubscriptionCharge: (...a: any[]) => logSubscriptionCharge(...a),
}))

vi.mock('@platform-pub/shared/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { expireAndRenewSubscriptions } from '../src/workers/subscription-expiry.js'

// A renewable row as the SELECT would shape it (writer_pubkey already COALESCEd
// over the publication in SQL).
function writerSub(overrides: Record<string, any> = {}) {
  return {
    id: 'sub-w',
    reader_id: 'reader-1',
    writer_id: 'writer-1',
    publication_id: null,
    price_pence: 500,
    current_period_end: new Date('2026-01-01T00:00:00Z'),
    reader_pubkey: 'rpk',
    writer_pubkey: 'wpk',
    subscription_period: 'monthly',
    offer_periods_remaining: null,
    writer_standard_price: 500,
    writer_annual_discount_pct: 15,
    reader_stripe_customer_id: 'cus_test',
    reader_card_action_required_at: null,
    period_anchor_day: 1,
    // COALESCE(w.status, p.status) — the target the reader is paying for.
    target_status: 'active',
    // Writer 9.3 (§0z item 10): set, and the renewal is a sale we no longer make.
    writer_paid_access_withdrawn_at: null,
    ...overrides,
  }
}

// Route pool.query by SQL: the renewable SELECT returns the given rows; the
// Phase-2 expire UPDATE and Phase-3 expiring-soon SELECT return empty.
function routePool(renewableRows: any[]) {
  mockPoolQuery.mockImplementation((sql: string) => {
    if (/FROM subscriptions s/.test(sql) && /auto_renew = TRUE/.test(sql)) {
      return Promise.resolve({ rows: renewableRows })
    }
    if (/SET status = 'expired'/.test(sql)) {
      return Promise.resolve({ rowCount: 0 })
    }
    // Phase 3 expiring-soon SELECT and any expire-on-failure UPDATE
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
}

describe('expireAndRenewSubscriptions — renewal', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    // mockClear alone leaves a previous test's mockImplementation in place: the
    // both-attempts-fail case installs a throwing transaction, and every later
    // test that needs a working one then silently exercises the failure path
    // instead. Restore the default explicitly.
    withTransactionImpl.mockReset()
    withTransactionImpl.mockImplementation(runTransaction)
    signSubscriptionEvent.mockClear()
    enqueueRelayPublish.mockClear()
    sendSubscriptionRenewedEmail.mockClear()
    sendSubscriptionLapsedNotForSaleEmail.mockClear()
    logSubscriptionCharge.mockClear()
    txCalls = []
  })

  it("lapses, uncharged, when the writer's paid access is withdrawn — and the reader is told why (Writer 9.3)", async () => {
    routePool([writerSub({ writer_paid_access_withdrawn_at: new Date('2026-08-01T00:00:00Z') })])
    await expireAndRenewSubscriptions()

    // Pre-fix: charged and renewed — a sale to a writer we cannot pay, which
    // then opened the pieces the stamp refuses to sell.
    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()
    const expire = mockPoolQuery.mock.calls.find(
      (c) => /SET status = 'expired'/.test(c[0] as string) && (c[1] as any[])[0] === 'sub-w',
    )
    expect(expire).toBeDefined()
    expect(sendSubscriptionLapsedNotForSaleEmail).toHaveBeenCalledWith('reader-1', 'writer-1')
  })

  it('charges the full renewal price via logSubscriptionCharge (F1: tab, not free_allowance)', async () => {
    routePool([writerSub()])
    await expireAndRenewSubscriptions()

    // F1: the worker no longer decrements the dead free_allowance column — the
    // charge is now a reading-tab debit inside logSubscriptionCharge (mocked
    // here), so the worker issues no free_allowance UPDATE at all.
    expect(txCalls.find((c) => /free_allowance_remaining_pence/.test(c.sql))).toBeUndefined()
    expect(logSubscriptionCharge).toHaveBeenCalledOnce()
    // The full renewal price (500) is passed as the charge amount (arg index 4),
    // unfloored (the D-fix: no GREATEST clamp).
    expect(logSubscriptionCharge.mock.calls[0][4]).toBe(500)
    // writer subscription: writer_id arg set, publication_id arg null
    expect(logSubscriptionCharge.mock.calls[0][3]).toBe('writer-1')
    expect(logSubscriptionCharge.mock.calls[0][7]).toBeNull()
    expect(sendSubscriptionRenewedEmail).toHaveBeenCalledOnce()
  })

  it('rolls the period to the STORED anchor day, not the previous end (§1.5)', async () => {
    // The subscription hangs off the 31st; the period being renewed ends
    // 28 Feb because January's advance had to borrow. The pre-fix worker
    // advanced that clamped end with setUTCMonth and landed on 28 March,
    // permanently short — and next cycle would advance 28 March again. The
    // anchor puts it back on the 31st.
    routePool([
      writerSub({
        current_period_end: new Date('2026-02-28T09:00:00Z'),
        period_anchor_day: 31,
      }),
    ])
    await expireAndRenewSubscriptions()

    const roll = txCalls.find((c) => /SET current_period_start/.test(c.sql))
    expect(roll).toBeDefined()
    // $1 = new period start (the old end), $2 = new period end.
    expect((roll!.params[0] as Date).toISOString()).toBe('2026-02-28T09:00:00.000Z')
    expect((roll!.params[1] as Date).toISOString()).toBe('2026-03-31T09:00:00.000Z')

    // Paired control: what the pre-fix advance produced from the same row.
    const preFix = new Date('2026-02-28T09:00:00Z')
    preFix.setUTCMonth(preFix.getUTCMonth() + 1)
    expect(preFix.toISOString()).toBe('2026-03-28T09:00:00.000Z')
  })

  it('renews a publication subscription and routes the earning to the publication', async () => {
    // Publications are SUSPENDED by default (2026-08-31), and renewal darks
    // with them — so this case is driven with the flag ON. That is deliberate
    // (PUBLICATIONS-SUSPENSION-PLAN.md D5): the suspension is a brake, not
    // a deletion, and the code behind it has to keep being proved correct or it
    // cannot be reinstated with any confidence. The dark behaviour has its own
    // test directly below.
    process.env.PUBLICATIONS_ENABLED = '1'
    routePool([
      writerSub({
        id: 'sub-p',
        writer_id: null,
        publication_id: 'pub-1',
        writer_standard_price: null,
        writer_annual_discount_pct: null,
      }),
    ])
    await expireAndRenewSubscriptions()

    expect(logSubscriptionCharge).toHaveBeenCalledOnce()
    // publication subscription: writer_id arg null, publication_id arg set
    expect(logSubscriptionCharge.mock.calls[0][3]).toBeNull()
    expect(logSubscriptionCharge.mock.calls[0][7]).toBe('pub-1')
    expect(enqueueRelayPublish).toHaveBeenCalledOnce()
    // No account writer → no reader-facing renewal email
    expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()
    delete process.env.PUBLICATIONS_ENABLED
  })

  it('EXPIRES a publication subscription instead of charging it while publications are suspended', async () => {
    // The H2 hazard (PUBLICATIONS-SUSPENSION-PLAN.md §1). A publication
    // subscription is recurring TAB DEBT and the surface it buys 404s while the
    // system is dark, so renewing one bills a reader for pages they cannot open.
    //
    // Expire, don't skip: a skipped row stays 'active' past its period end, so
    // it is re-selected every hour forever and silently resumes charging the
    // moment the flag flips back — a reader billed for months nobody served.
    delete process.env.PUBLICATIONS_ENABLED
    routePool([
      writerSub({
        id: 'sub-p',
        writer_id: null,
        publication_id: 'pub-1',
        writer_standard_price: null,
        writer_annual_discount_pct: null,
      }),
    ])
    await expireAndRenewSubscriptions()

    // No money moved, and no renewal event was published.
    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(enqueueRelayPublish).not.toHaveBeenCalled()
    expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()

    // The row reached its terminal state rather than being left to re-fire.
    const expiry = mockPoolQuery.mock.calls.find((c: any[]) =>
      /SET status = 'expired'/.test(c[0]),
    )
    expect(expiry).toBeDefined()
    expect(expiry![1][0]).toBe('sub-p')
    // The period roll must NOT have happened.
    expect(txCalls.find((c) => /SET current_period_start/.test(c.sql))).toBeUndefined()
  })

  it('reverts an expiring annual offer to the writer-configured discount, not a hardcode', async () => {
    routePool([
      writerSub({
        subscription_period: 'annual',
        offer_periods_remaining: 1,
        price_pence: 100, // promo price
        writer_standard_price: 500,
        writer_annual_discount_pct: 20,
      }),
    ])
    await expireAndRenewSubscriptions()

    // 500 * 12 * (1 - 0.20) = 4800 — uses annual_discount_pct, not 0.85
    expect(logSubscriptionCharge.mock.calls[0][4]).toBe(4800)
    const subUpdate = txCalls.find((c) => /offer_id = NULL/.test(c.sql))
    expect(subUpdate).toBeDefined()
    expect(subUpdate!.params).toContain(4800)
  })

  it('retries once on a transient failure before succeeding (no expire)', async () => {
    routePool([writerSub()])
    let attempts = 0
    withTransactionImpl.mockImplementationOnce(async () => {
      attempts++
      throw new Error('transient deadlock')
    })
    await expireAndRenewSubscriptions()

    expect(withTransactionImpl).toHaveBeenCalledTimes(2)
    // never expired
    const expired = mockPoolQuery.mock.calls.find((c) =>
      /SET status = 'expired'/.test(c[0]) && /WHERE id = \$1/.test(c[0]),
    )
    expect(expired).toBeUndefined()
  })

  it('skips the charge when the period was already rolled (idempotency guard, D4)', async () => {
    routePool([writerSub()])
    // Simulate a commit-ambiguous retry: the period-roll UPDATE now matches 0
    // rows because a prior (committed-but-unacked) attempt already moved
    // current_period_end into the future.
    withTransactionImpl.mockImplementationOnce(async (cb: (client: any) => Promise<any>) => {
      const client = {
        query: (sql: string, params: any[] = []) => {
          txCalls.push({ sql, params })
          const isRoll = /UPDATE subscriptions/.test(sql) && /current_period_end < now\(\)/.test(sql)
          return Promise.resolve({ rows: [], rowCount: isRoll ? 0 : 1 })
        },
      }
      return cb(client)
    })
    await expireAndRenewSubscriptions()

    // Guard matched 0 rows → no tab deduction, no ledger entry, no signing/publish.
    expect(txCalls.find((c) => /free_allowance_remaining_pence/.test(c.sql))).toBeUndefined()
    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(enqueueRelayPublish).not.toHaveBeenCalled()
  })

  it('expires the subscription when both attempts fail', async () => {
    routePool([writerSub()])
    withTransactionImpl.mockImplementation(async () => {
      throw new Error('persistent failure')
    })
    await expireAndRenewSubscriptions()

    expect(withTransactionImpl).toHaveBeenCalledTimes(2)
    const expired = mockPoolQuery.mock.calls.find(
      (c) => /SET status = 'expired'/.test(c[0]) && /WHERE id = \$1/.test(c[0]),
    )
    expect(expired).toBeDefined()
    expect(expired![1]).toEqual(['sub-w'])
  })

  it('expires a card-less renewal without charging (P0 collection gate)', async () => {
    routePool([writerSub({ reader_stripe_customer_id: null })])
    await expireAndRenewSubscriptions()

    // No renewal transaction at all: the charge would be uncollectible tab
    // debt (settlement skips card-less accounts) while the writer earned.
    expect(withTransactionImpl).not.toHaveBeenCalled()
    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(enqueueRelayPublish).not.toHaveBeenCalled()
    expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()
    // Expired instead, guarded on still being due + active.
    const expired = mockPoolQuery.mock.calls.find(
      (c) =>
        /SET status = 'expired'/.test(c[0]) &&
        /current_period_end < now\(\)/.test(c[0]) &&
        /status = 'active'/.test(c[0]),
    )
    expect(expired).toBeDefined()
    expect(expired![1]).toEqual(['sub-w'])
  })

  it('expires a renewal whose card has terminally declined, without charging', async () => {
    // Reader Terms 6.1, the renewal half. The card is on file and settlement
    // has already backed off it, so a renewal charge would be tab debt we have
    // been told we cannot collect — landing on a reader who is being shown
    // "your reading tab is paused". The card-less arm above catches a reader
    // with no card at all; this is the one whose card is there and dead.
    routePool([writerSub({ reader_card_action_required_at: new Date() })])
    await expireAndRenewSubscriptions()

    expect(withTransactionImpl).not.toHaveBeenCalled()
    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()
    const expired = mockPoolQuery.mock.calls.find(
      (c) =>
        /SET status = 'expired'/.test(c[0]) &&
        /current_period_end < now\(\)/.test(c[0]) &&
        /status = 'active'/.test(c[0]),
    )
    expect(expired).toBeDefined()
    expect(expired![1]).toEqual(['sub-w'])
  })

  it('the renewable SELECT reads the card-action flag at all', async () => {
    // The gate above can only work if the column is in the query. A fixture
    // carries whatever field the test author typed, so the flag would "work"
    // in this suite while production selected nothing to read.
    routePool([writerSub()])
    await expireAndRenewSubscriptions()

    const select = mockPoolQuery.mock.calls.find(
      (c) => /FROM subscriptions s/.test(c[0]) && /auto_renew = TRUE/.test(c[0]),
    )
    expect(select).toBeDefined()
    expect(select![0]).toMatch(/card_action_required_at/)
  })

  // ---------------------------------------------------------------------------
  // The target must still be live (S14). Every one of these renewed and charged
  // before the gate: the SELECT left-joins both targets and read neither status.
  // ---------------------------------------------------------------------------

  it.each([['suspended'], ['deleted'], ['deactivated'], ['moderated']])(
    'expires rather than charges when the writer account is %s',
    async (status) => {
      routePool([writerSub({ target_status: status })])
      await expireAndRenewSubscriptions()

      expect(withTransactionImpl).not.toHaveBeenCalled()
      expect(logSubscriptionCharge).not.toHaveBeenCalled()
      expect(sendSubscriptionRenewedEmail).not.toHaveBeenCalled()
      const expired = mockPoolQuery.mock.calls.find(
        (c) =>
          /SET status = 'expired'/.test(c[0]) &&
          /current_period_end < now\(\)/.test(c[0]),
      )
      expect(expired).toBeDefined()
      expect(expired![1]).toEqual(['sub-w'])
    },
  )

  it('expires when the target row is absent entirely (LEFT JOIN gave NULL)', async () => {
    routePool([writerSub({ target_status: null })])
    await expireAndRenewSubscriptions()

    expect(logSubscriptionCharge).not.toHaveBeenCalled()
    expect(
      mockPoolQuery.mock.calls.find((c) => /SET status = 'expired'/.test(c[0])),
    ).toBeDefined()
  })

  it('the SELECT reads a status for BOTH targets, not just the writer', async () => {
    // A structural pin, and it is the half a row fixture cannot state: the gate
    // above is driven by `target_status`, which only means anything if the query
    // that feeds it COALESCEs the publication's status in beside the writer's.
    // Without the publication arm a publication subscription reads NULL and
    // would expire every live publication sub the day publications come back.
    routePool([])
    await expireAndRenewSubscriptions()

    const select = mockPoolQuery.mock.calls.find(
      (c) => /FROM subscriptions s/.test(c[0]) && /auto_renew = TRUE/.test(c[0]),
    )
    expect(select).toBeDefined()
    expect(select![0]).toMatch(/COALESCE\(w\.status::text, p\.status\) AS target_status/)
  })

  it('renews normally for an active writer (the control)', async () => {
    routePool([writerSub({ target_status: 'active' })])
    await expireAndRenewSubscriptions()
    expect(logSubscriptionCharge).toHaveBeenCalledOnce()
  })
})
