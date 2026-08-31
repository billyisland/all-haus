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
const withTransactionImpl = vi.fn(async (cb: (client: any) => Promise<any>) => {
  const client = {
    query: (sql: string, params: any[] = []) => {
      txCalls.push({ sql, params })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
  }
  return cb(client)
})

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
vi.mock('@platform-pub/shared/lib/subscription-emails.js', () => ({
  sendSubscriptionRenewedEmail: (...a: any[]) => sendSubscriptionRenewedEmail(...a),
  sendSubscriptionExpiryWarningEmail: (...a: any[]) => sendSubscriptionExpiryWarningEmail(...a),
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
    period_anchor_day: 1,
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
    withTransactionImpl.mockClear()
    signSubscriptionEvent.mockClear()
    enqueueRelayPublish.mockClear()
    sendSubscriptionRenewedEmail.mockClear()
    logSubscriptionCharge.mockClear()
    txCalls = []
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
})
