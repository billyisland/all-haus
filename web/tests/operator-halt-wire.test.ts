import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPERATOR_HALT_CLASSES } from '../src/lib/api/admin-dashboard'

// =============================================================================
// The operator's payout freeze, pinned across all three services (D9 §4.1).
//
// A TYPE IS NOT A CONTRACT, and this act crosses two boundaries with no module
// path over either: the roster sends a class string to the gateway, the gateway
// sends it to the payment service, and the payment service writes it into the
// column an operator later reads to decide whether a halt is theirs to lift.
// `tsc` will confirm each end agrees with its own copy of the vocabulary for
// ever without ever comparing the three.
//
// BOTH DIRECTIONS OF DRIFT DO REAL DAMAGE, and neither shows up as an error:
//
//   · a class the web sends and the gateway's enum refuses is a 400 on an
//     emergency freeze — the one act in this repo taken against a clock;
//   · a class the gateway forwards and the payment service does not know is a
//     legal hold filed under a name the operator will read as a books problem,
//     and the release warning ("do not clear a row you did not write") then
//     points the wrong way.
//
// The route PATH is pinned for the same reason the admin Reports page needed
// pinning: a client calling a URL nothing serves fails as a 404 the surface
// renders as "could not freeze", which is indistinguishable from a refusal.
//
// Every regex asserts it MATCHED. A renamed constant would otherwise leave this
// file comparing an empty list against an empty list and passing.
// =============================================================================

const WEB_API = join(__dirname, '../src/lib/api/admin-dashboard.ts')
const GATEWAY_ADMIN = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
const PAYMENT_HALT = join(__dirname, '../../payment-service/src/lib/payout-halt.ts')
const PAYMENT_ROUTES = join(__dirname, '../../payment-service/src/routes/payment.ts')
const ROSTER = join(__dirname, '../src/components/admin/MemberRoster.tsx')

/** The members of an `as const` array literal named `name`, from a source. */
function classesFrom(src: string, file: string): string[] {
  const m = src.match(/OPERATOR_HALT_CLASSES\s*=\s*\[([^\]]*)\]\s*as const/)
  expect(m, `OPERATOR_HALT_CLASSES not found in ${file} — the pin is reading the wrong thing`)
    .toBeTruthy()
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
}

describe('the operator payout freeze agrees across web, gateway and payment service', () => {
  const gateway = readFileSync(GATEWAY_ADMIN, 'utf8')
  const paymentLib = readFileSync(PAYMENT_HALT, 'utf8')
  const paymentRoutes = readFileSync(PAYMENT_ROUTES, 'utf8')

  it('there is a vocabulary to compare at all', () => {
    expect(OPERATOR_HALT_CLASSES.length).toBeGreaterThan(0)
  })

  it('the three copies of the class vocabulary are the same list', () => {
    const fromGateway = classesFrom(gateway, 'gateway/src/routes/admin-dashboard.ts')
    const fromPayment = classesFrom(paymentLib, 'payment-service/src/lib/payout-halt.ts')
    expect(fromGateway).toEqual([...OPERATOR_HALT_CLASSES])
    expect(fromPayment).toEqual([...OPERATOR_HALT_CLASSES])
  })

  it('the class the web actually sends is one the vocabulary contains', () => {
    // The roster sends `OPERATOR_HALT_CLASSES[0]` rather than a literal, so the
    // one thing left to check is that it has not grown a literal since.
    const roster = readFileSync(ROSTER, 'utf8')
    // Greedy to the LAST paren on the line: the argument list contains
    // `reason.trim()`, so a lazy match stops inside it and reads the arguments
    // as "id, reason.trim(" — which would then fail against a correct call.
    const call = roster.match(/haltAccountPayouts\((.*)\)/)
    expect(call, 'the roster no longer calls haltAccountPayouts — did the surface move?')
      .toBeTruthy()
    expect(call![1]).toContain('OPERATOR_HALT_CLASSES[0]')
  })

  it('the web calls the path the gateway serves', () => {
    const web = readFileSync(WEB_API, 'utf8')
    expect(web).toContain('/admin/dashboard/halt-payouts/')
    expect(gateway).toContain("'/admin/dashboard/halt-payouts/:accountId'")
  })

  it('the gateway calls the path the payment service serves', () => {
    expect(gateway).toMatch(/`\/payouts\/halt\/\$\{accountId\}`/)
    expect(paymentRoutes).toContain("'/payouts/halt/:accountId'")
  })

  it('the gateway forwards the actor off the session, never the service token', () => {
    const route = gateway.match(
      /'\/admin\/dashboard\/halt-payouts\/:accountId',[\s\S]*?\n {2}\)/,
    )
    expect(route, 'the halt-payouts route not found — was it moved?').toBeTruthy()
    expect(route![0]).toContain('actorId: adminId')
    // The reason rides with it, because the freeze's record is refused without
    // one by the payment service's schema and by the column's own CHECK.
    expect(route![0]).toContain('reason: parsed.data.reason')
  })

  it('the refusal codes the roster branches on are the ones the services send', () => {
    // `already_halted` is the one that matters: the roster's sentence for it
    // tells the operator the freeze is not theirs to lift, and a code that
    // never arrives would leave a bare "could not freeze" in its place.
    const roster = readFileSync(ROSTER, 'utf8')
    for (const code of ['already_halted', 'no_such_account']) {
      expect(roster, `the roster does not handle ${code}`).toContain(`'${code}'`)
      expect(paymentRoutes, `the payment service does not send ${code}`).toContain(`'${code}'`)
    }
  })

  it('the roster gates the button on the field the gateway actually sends', () => {
    const roster = readFileSync(ROSTER, 'utf8')
    expect(roster).toContain('m.payoutsHalted === null')
    // A button that cannot do its job is not offered — and the gate is only
    // real if the roster response carries the field it reads.
    expect(gateway).toMatch(/payoutsHalted:\s*r\.halt_class/)
    expect(gateway).toContain('LEFT JOIN payouts_halted_accounts h ON h.account_id = a.id')
  })
})
