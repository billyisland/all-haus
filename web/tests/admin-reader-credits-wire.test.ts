import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// The reader-credits panel must read fields that actually cross the wire.
//
// The value travels three services: `readerCreditsReport` in the payment
// service builds it, the gateway proxies it and staples on the names, and the
// overview page renders it. `AdminReaderCredits` is a hand-written claim about
// all three, and `tsc` confirms the page agrees with the interface, never that
// the interface agrees with any server — which is how the admin Reports page
// read five fields off a response that has never carried one of them, for its
// whole life, typechecking and linting clean throughout.
//
// It matters more here than on most surfaces. The panel's whole job is to say
// how much money the platform owes readers it should not be holding; a field
// that arrives `undefined` renders as £0.00 or as an empty list, and BOTH of
// those read as an all-clear. A surface that says "nobody is in credit" when it
// simply could not read the answer is the exact silence PAYMENT-PERIMETER-ADR
// W1 exists to end.
//
// Reads both sources rather than importing them: there is no module path
// between the workspaces (same shape as `admin-report-wire.test.ts`).
// =============================================================================

const PAYMENT_RECONCILE = join(__dirname, '../../payment-service/src/services/reconcile-ledger.ts')
const GATEWAY_ADMIN = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
const WEB_TYPES = join(__dirname, '../src/lib/api/admin-dashboard.ts')
const OVERVIEW = join(__dirname, '../src/app/admin/overview/page.tsx')

describe('reader credits — parity across the three services', () => {
  const payment = readFileSync(PAYMENT_RECONCILE, 'utf8')
  const gateway = readFileSync(GATEWAY_ADMIN, 'utf8')
  const web = readFileSync(WEB_TYPES, 'utf8')

  it('the payment service really returns the shape', () => {
    const iface = payment.match(/export interface ReaderCreditsReport \{([\s\S]*?)\n\}/)
    // Assert we FOUND it: a renamed interface would otherwise make every
    // assertion below pass by comparing nothing against nothing.
    expect(iface, 'ReaderCreditsReport not found — was it renamed?').toBeTruthy()
    for (const field of ['count', 'totalCreditPence', 'sampleLimit', 'truncated', 'accounts']) {
      expect(iface![1], field).toContain(field)
    }
  })

  it('the gateway proxies that route and enriches it with the names', () => {
    const route = gateway.match(
      /'\/admin\/dashboard\/reader-credits',[\s\S]*?\n {2}\)/,
    )
    expect(route, 'the reader-credits route not found — was it moved?').toBeTruthy()
    // The proxy path: a second definition of "who is in credit" in the gateway
    // is how two surfaces start disagreeing about an incident.
    expect(route![0]).toContain("callPaymentService('/reader-credits', 'GET')")
    // The gateway's own contribution, and the only one.
    expect(route![0]).toMatch(/username:\s*names\.get\(a\.accountId\)\?\.username/)
    expect(route![0]).toMatch(/displayName:\s*names\.get\(a\.accountId\)\?\.displayName/)
    // An upstream refusal must not reach the browser as an empty report.
    expect(route![0]).toMatch(/502/)
  })

  it('the gateway never retypes the credit predicate', () => {
    // The one home is `READER_CREDIT_OPEN_PREDICATE` in the payment service. A
    // credit predicate written here would be a second definition of the same
    // question, in the service that does not own it — which is what the
    // overview's old "Reader credit" stat card was, and why it read as a metric
    // rather than as the thing with a runbook.
    //
    // Comment lines are cut: the code around this change explains the ban in
    // the words it bans, and a rule whose own explanation trips it is a rule
    // somebody deletes.
    const code = gateway
      .split('\n')
      .filter((line) => {
        const t = line.trimStart()
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
      })
      .join('\n')
    expect(code).not.toMatch(/balance_pence\s*<\s*0/)
    expect(code).not.toMatch(/pending_refund/)
    // The control: the gateway still asks the accrual questions, so this is a
    // tree it really scanned.
    expect(code).toMatch(/balance_pence\s*>\s*0/)
  })

  it('the payable really crosses the wire, field for field (L3.1)', () => {
    // The refund button acts on ONE payable, and every field it reads has to
    // exist on the response. The Reports page read five fields off a response
    // that never carried one of them, for its whole life, typechecking clean —
    // and here an `undefined` creditId would send a refund request for nothing
    // while the row still offered a button.
    const iface = payment.match(/export interface ReaderCreditPayable \{([\s\S]*?)\n\}/)
    expect(iface, 'ReaderCreditPayable not found — was it renamed?').toBeTruthy()
    for (const field of [
      'creditId',
      'amountPence',
      'createdAt',
      'sourceRefTable',
      'refundInFlight',
      'refundFailureReason',
    ]) {
      expect(iface![1], field).toContain(field)
    }
    // And the report attaches them to each reader, or the list renders empty.
    const report = payment.match(/export interface ReaderCreditRow \{([\s\S]*?)\n\}/)
    expect(report![1]).toContain('payables: ReaderCreditPayable[]')
  })

  it('the refund OUTCOME union is the same one the service answers with', () => {
    // A hand-written union is a claim about a server nothing checks. The web
    // switches on `kind` to pick the operator's sentence, and a member the
    // service can return but the client does not name falls through every arm
    // — which on this surface means a refund whose outcome is not reported.
    const service = readFileSync(
      join(__dirname, '../../payment-service/src/services/refund.ts'),
      'utf8',
    )
    const union = service.match(/export type RefundAttempt =([\s\S]*?)\n\n/)
    expect(union, 'RefundAttempt not found — was it renamed?').toBeTruthy()
    const serviceKinds = [...union![1].matchAll(/kind: "([a-z_]+)"/g)].map((m) => m[1]).sort()
    expect(serviceKinds.length, 'a regex that matched nothing must not pass').toBeGreaterThan(3)

    const clientUnion = web.match(/export type AdminRefundResult =([\s\S]*?)\n\n/)
    expect(clientUnion, 'AdminRefundResult not found — was it renamed?').toBeTruthy()
    const clientKinds = [...clientUnion![1].matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]).sort()

    // The client carries exactly the service's members plus `unknown`, which is
    // the gateway's own: the service never RETURNS ambiguity (it throws, and the
    // route answers 502), so the one extra member is where that lands.
    expect(clientKinds).toEqual([...serviceKinds, 'unknown'].sort())
  })

  it('the panel offers a refund on each payable, and says what it does not cover', () => {
    const page = readFileSync(OVERVIEW, 'utf8')
    expect(page).toMatch(/a\.payables\.map/)
    expect(page).toMatch(/refundReaderCredit\(/)
    // The reason is not optional at the press: a blank one is refused here as
    // well as by the gateway, the service and the column's own CHECK.
    expect(page).toMatch(/refundReason\.trim\(\) === ''/)
    // The old "there is no refund button here yet" copy must be gone — a
    // surface that denies the action beside the action is worse than either.
    expect(page).not.toMatch(/no refund button here yet/)
  })

  it('the outcome line survives the banner it empties', () => {
    // FOUND BY DRIVING IT. The outcome sat inside the `credits.count > 0`
    // block, and a successful refund of the last payable is exactly the press
    // that takes that count to zero — so the banner and the confirmation went
    // together, on the one path where the confirmation matters most. The
    // operator sent money back and the page said nothing.
    //
    // A fact about the PRESS does not belong inside a block gated on the
    // POPULATION. Asserted structurally: the `refundOutcome` render must sit
    // after the banner's closing `)}`, not within it.
    const page = readFileSync(OVERVIEW, 'utf8')
    const bannerOpen = page.indexOf('{credits && credits.count > 0 && (')
    expect(bannerOpen, 'the credits banner was not found — was it renamed?').toBeGreaterThan(-1)
    const outcome = page.indexOf('{refundOutcome && (')
    expect(outcome, 'the refund outcome render was not found').toBeGreaterThan(-1)
    // The banner block ends at the first `\n          )}` after it opens (the
    // page's own indentation for a top-level conditional).
    const bannerClose = page.indexOf('\n          )}', bannerOpen)
    expect(bannerClose).toBeGreaterThan(bannerOpen)
    expect(outcome, 'the refund outcome must render OUTSIDE the credits banner').toBeGreaterThan(
      bannerClose,
    )
  })

  it('the web interface names exactly what is sent', () => {
    const iface = web.match(/export interface AdminReaderCredits \{([\s\S]*?)\n\}\n/)
    expect(iface, 'AdminReaderCredits not found — was it renamed?').toBeTruthy()
    const body = iface![1]
    expect(body).toMatch(/count: number/)
    expect(body).toMatch(/totalCreditPence: number/)
    expect(body).toMatch(/truncated: boolean/)
    expect(body).toMatch(/payableCount: number/)
    // The two the gateway adds, and nothing else may be assumed of them.
    expect(body).toMatch(/username: string \| null/)
    expect(body).toMatch(/displayName: string \| null/)
  })

  it('the panel renders the uncapped count, never the sample length', () => {
    const page = readFileSync(OVERVIEW, 'utf8')
    // `credits.accounts.length` as the headline would report a capped sample as
    // a total — the silence the detector exists to end, rebuilt in the UI.
    expect(page).toMatch(/credits\.count > 0/)
    expect(page).toMatch(/\{credits\.count\} reader/)
    // No Math.abs: the payable is a positive quantity on the wire, and an abs()
    // here would quietly render a sign error as a plausible figure.
    expect(page).toMatch(/formatPence\(credits\.totalCreditPence\)/)
    expect(page).not.toMatch(/Math\.abs\(credits\./)
    // And it says so when the list is short of the count.
    expect(page).toMatch(/credits\.truncated &&/)
  })

  it('a failed read renders as a failed read, not as an all-clear', () => {
    const page = readFileSync(OVERVIEW, 'utf8')
    expect(page).toMatch(/creditsError && \(/)
    expect(page).toMatch(/not a report that nobody is owed money/i)
  })
})
