import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PAYOUT_CADENCES } from '../src/lib/api/account'

// =============================================================================
// A CADENCE IS A STRING CROSSING THREE BOUNDARIES AND NOTHING TYPES IT (L5.3).
//
// The settings control sends one of three words. The gateway's zod enum accepts
// a set. `accounts.payout_cadence`'s CHECK accepts a set. The payout query's
// CASE has an arm per value, and a value with no arm EXCLUDES that writer from
// every payout — silently, because an unmatched CASE yields NULL and the
// predicate simply stops being true for them.
//
// `tsc` verifies the client against its own union as happily against a lie as
// against the truth, which is how the whole admin Reports page shipped
// decorative. There is no module path between the workspaces, so the pin READS
// THE FILES — and asserts each match was FOUND, since a renamed constant
// otherwise makes this suite pass by testing nothing.
//
// The union is declared as a runtime `as const` array on both sides for exactly
// this reason: a bare TS type can be compared against nothing here.
// =============================================================================

const GATEWAY_MY_ACCOUNT = join(__dirname, '../../gateway/src/routes/my-account.ts')
const PAYOUT_SERVICE = join(__dirname, '../../payment-service/src/services/payout.ts')
const SCHEMA = join(__dirname, '../../schema.sql')

describe('payout cadence — the three spellings must agree', () => {
  it('the gateway accepts exactly the cadences the web sends', () => {
    const src = readFileSync(GATEWAY_MY_ACCOUNT, 'utf8')
    const decl = src.match(/PAYOUT_CADENCES = \[([^\]]*)\] as const/)
    expect(decl, 'PAYOUT_CADENCES not found in my-account.ts — was it renamed?').toBeTruthy()
    const gatewayValues = [...decl![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1])

    expect(gatewayValues).toEqual([...PAYOUT_CADENCES])

    // And the schema is built FROM that list, not from a second literal beside
    // it — `z.enum(['daily', …])` typed out again would drift.
    expect(src).toMatch(/z\.enum\(PAYOUT_CADENCES\)/)
  })

  it("the column's CHECK accepts exactly the same set", () => {
    const schema = readFileSync(SCHEMA, 'utf8')
    const check = schema.match(/accounts_payout_cadence_check CHECK \(\(payout_cadence = ANY \(ARRAY\[([^\]]*)\]\)\)\)/)
    expect(check, 'accounts_payout_cadence_check not found in schema.sql').toBeTruthy()
    for (const cadence of PAYOUT_CADENCES) {
      expect(check![0]).toContain(`'${cadence}'`)
    }
    // No EXTRA value the CASE below has no arm for.
    const inCheck = [...check![0].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
    expect(new Set(inCheck)).toEqual(new Set(PAYOUT_CADENCES))
  })

  it('the payout query has an arm for every cadence — one without is a silent freeze', () => {
    const src = readFileSync(PAYOUT_SERVICE, 'utf8')
    const due = src.match(/WRITER_CADENCE_DUE_SQL = `([\s\S]*?)`\n/)
    expect(due, 'WRITER_CADENCE_DUE_SQL not found — was it renamed?').toBeTruthy()
    for (const cadence of PAYOUT_CADENCES) {
      expect(due![1], `no CASE arm for '${cadence}'`).toContain(`WHEN '${cadence}'`)
    }
    // There is deliberately no ELSE: an unknown value must exclude the writer
    // rather than be paid on the most generous reading. If one is added, this
    // comment and that decision have both moved.
    expect(due![1]).not.toMatch(/\bELSE\b/)
  })

  it('the threshold floor is the platform dial on BOTH sides of the wire', () => {
    // The client must not carry its own copy of the dial: it renders the floor
    // in the refusal copy, and a stale literal there would tell a writer their
    // figure was allowed when the query will not honour it.
    const web = readFileSync(join(__dirname, '../src/components/account/PayoutPreferences.tsx'), 'utf8')
    expect(web).toContain('platformThresholdPence')
    expect(web).not.toMatch(/writerPayoutThresholdPence\s*=\s*\d/)

    const gateway = readFileSync(GATEWAY_MY_ACCOUNT, 'utf8')
    expect(gateway).toContain('platformThresholdPence: config.writerPayoutThresholdPence')

    const payout = readFileSync(PAYOUT_SERVICE, 'utf8')
    expect(payout).toContain('GREATEST(COALESCE(a.payout_threshold_pence, $1), $1)')
  })
})

// =============================================================================
// The Writer's earnings response (L5.4).
//
// `WriterEarnings` on the web is a hand-written interface, and `tsc` confirms
// the components agree with IT, never that it agrees with the service. Four new
// fields arrived with L5.4 and each renders a figure about somebody's money: a
// field the response has never carried renders as `undefined`, which the
// component's `?? 0` then turns into a confident "£0.00 given away" on a page
// where that is false.
// =============================================================================
describe('writer earnings — parity with the payment service', () => {
  const PAYMENT_TYPES = join(__dirname, '../../payment-service/src/types/index.ts')

  it('the web interface names every field the service returns', () => {
    const service = readFileSync(PAYMENT_TYPES, 'utf8')
    const serviceIface = service.match(/export interface WriterEarnings \{([\s\S]*?)\n\}/)
    expect(serviceIface, 'WriterEarnings not found in the payment service types').toBeTruthy()

    const web = readFileSync(join(__dirname, '../src/lib/api/account.ts'), 'utf8')
    const webIface = web.match(/export interface WriterEarnings \{([\s\S]*?)\n\}/)
    expect(webIface, 'WriterEarnings not found in the web api module').toBeTruthy()

    const fieldsOf = (block: string) =>
      new Set([...block.matchAll(/^\s{2}([a-zA-Z]+)[?]?:/gm)].map((m) => m[1]))

    const serviceFields = fieldsOf(serviceIface![1])
    // Assert we found something: an empty set would make this pass by testing
    // nothing, which is the exact failure the file exists to catch.
    expect(serviceFields.size).toBeGreaterThan(5)
    expect(fieldsOf(webIface![1])).toEqual(serviceFields)
  })

  it('the four L5.4 figures are on the wire', () => {
    const service = readFileSync(PAYMENT_TYPES, 'utf8')
    for (const field of ['grossPence', 'feePence', 'allowanceCoveredPence', 'allowanceReadCount']) {
      expect(service).toContain(`${field}: number`)
    }
  })
})
