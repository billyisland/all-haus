import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// The age gate reads a field off `/auth/me`, and nothing else checks it exists
//
// L6.1. `MeResponse` is a hand-written interface and `tsc` will confirm every
// caller agrees with IT whether or not the server does — which is how the
// admin Reports page rendered `undefined` for five fields for its whole life
// while typechecking, linting and building clean (root CLAUDE.md, *a type is
// not a contract*).
//
// HERE THE FAILURE IS SILENT AND FAILS OPEN. `AgeGate` renders only when
// `user.ageDeclaredAt === null`. A response that has never carried the field
// gives `undefined`, `undefined !== null`, and the gate NEVER SHOWS — for
// every member, for ever, with nothing on any screen and nothing in any log to
// say the platform stopped asking. A test that exercised the component would
// pass on a fixture it wrote itself.
//
// So it reads the gateway's source. There is no module path between the two
// workspaces, and every match is asserted FOUND — a renamed constant otherwise
// makes the suite pass by testing nothing.
//
// It also pins the ROUTE and the BODY: a required zod field the client never
// sends is a 400 on every attempt to answer the one question that closes the
// gate, on a surface that cannot be dismissed.
// =============================================================================

const GATEWAY_AUTH = join(__dirname, '../../gateway/src/routes/auth.ts')
const SHARED_ACCOUNTS = join(__dirname, '../../shared/src/auth/accounts.ts')
const WEB_AUTH = join(__dirname, '../src/lib/api/auth.ts')
const AGE_GATE = join(__dirname, '../src/components/legal/AgeGate.tsx')
const LAYOUT_SHELL = join(__dirname, '../src/components/layout/LayoutShell.tsx')

describe('/auth/me age declaration — parity with the gateway', () => {
  const gateway = readFileSync(GATEWAY_AUTH, 'utf8')

  it('sends ageDeclaredAt off the account', () => {
    expect(gateway).toMatch(/ageDeclaredAt: account\.ageDeclaredAt/)
  })

  it('getAccount selects the column and maps it', () => {
    const shared = readFileSync(SHARED_ACCOUNTS, 'utf8')
    const select = shared.match(/SELECT id, nostr_pubkey[\s\S]*?FROM accounts WHERE id = \$1/)
    expect(select, 'the getAccount SELECT not found — was it rewritten?').toBeTruthy()
    expect(select![0]).toContain('age_declared_at')
    expect(shared).toMatch(/ageDeclaredAt: r\.age_declared_at\?\.toISOString\(\) \?\? null/)
  })

  it('does NOT ship the date of birth itself', () => {
    // A value on the session payload is a value on every page, and no surface
    // needs it. L7.1's export reads the column directly. If this ever has to
    // change, it is a disclosure decision and not a convenience.
    expect(gateway).not.toMatch(/dateOfBirth: account\./)
    const shared = readFileSync(SHARED_ACCOUNTS, 'utf8')
    const iface = shared.match(/export interface AccountInfo \{([\s\S]*?)\n\}/)
    expect(iface, 'AccountInfo not found — was it renamed?').toBeTruthy()
    expect(iface![1]).not.toMatch(/^\s*dateOfBirth/m)
  })

  it('the web interface names the field the gate reads', () => {
    const web = readFileSync(WEB_AUTH, 'utf8')
    const iface = web.match(/export interface MeResponse \{([\s\S]*?)\n\}/)
    expect(iface, 'MeResponse not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/ageDeclaredAt: string \| null/)
  })

  it('the gate tests it against null, never falsily', () => {
    // `!user.ageDeclaredAt` would be true for `undefined` as well, which is
    // the same bug wearing a different mask — it would show the gate to
    // everybody the moment the field went missing rather than to nobody.
    const gate = readFileSync(AGE_GATE, 'utf8')
    expect(gate).toMatch(/user\.ageDeclaredAt !== null/)
  })

  it('is MOUNTED, sitewide', () => {
    // A gate nobody renders is the same as no gate. It goes in LayoutShell
    // rather than the workspace because a Google arrival lands on
    // `/article/<dTag>` as readily as on `/reader`.
    const shell = readFileSync(LAYOUT_SHELL, 'utf8')
    expect(shell).toMatch(/<AgeGate \/>/)
    expect(shell).toMatch(/import \{ AgeGate \}/)
  })
})

describe('the declaration route — body parity', () => {
  const gateway = readFileSync(GATEWAY_AUTH, 'utf8')

  it('the route exists and takes the field the web sends', () => {
    expect(gateway).toContain('"/auth/declare-age"')
    expect(gateway).toMatch(/dateOfBirth: dateOfBirthSchema\(new Date\(\)\)/)

    const web = readFileSync(WEB_AUTH, 'utf8')
    expect(web).toContain("'/auth/declare-age'")
    expect(web).toMatch(/JSON\.stringify\(\{ dateOfBirth \}\)/)
  })

  it('signup sends the same field, and the schema is built PER REQUEST', () => {
    // A schema frozen at module load closes over the boot-time clock and goes
    // on refusing somebody who turned 18 while the process was up.
    expect(gateway).toMatch(/signupSchema\(new Date\(\)\)\.safeParse/)

    const web = readFileSync(WEB_AUTH, 'utf8')
    const iface = web.match(/interface SignupInput \{([\s\S]*?)\n\}/)
    expect(iface, 'SignupInput not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/dateOfBirth: string/)
  })

  it('the age refusal answers in the MEMBER\'s words, under its own code', () => {
    // `zodValidationError`'s `message` is prefixed with the field name, so the
    // first cut showed a blocked member `dateOfBirth: You have to be 18 or
    // over…` on a surface with no way past it. Found by RENDERING it — it
    // compiled, linted, built and passed every test.
    const decl = gateway.match(/AGE_DECLARATION_REFUSED = "([^"]+)"/)
    expect(decl, 'AGE_DECLARATION_REFUSED not found — was it renamed?').toBeTruthy()

    // Both doors take the refusal, not just the one that is easy to reach.
    const hits = gateway.match(/ageRefusal\(parsed\.error\) \?\? zodValidationError/g) ?? []
    expect(hits.length, 'signup and declare-age must BOTH use it').toBe(2)

    // And it is scoped: a body that is also missing an email stays an ordinary
    // validation failure, so this cannot swallow unrelated refusals.
    const fn = gateway.match(/function ageRefusal\([\s\S]*?\n\}/)
    expect(fn, 'ageRefusal not found').toBeTruthy()
    expect(fn![0]).toMatch(/keys\.length !== 1/)
  })

  it('the web does NO age arithmetic of its own', () => {
    // `shared/src/lib/age.ts` is the one home and the route parses with it. A
    // client-side copy is a second rule to keep in step, and the one that
    // drifts is always the half nobody is testing.
    for (const f of [AGE_GATE, join(__dirname, '../src/app/auth/signup/page.tsx')]) {
      const src = readFileSync(f, 'utf8')
      expect(src, `${f} computes an age`).not.toMatch(/\b18\b\s*\*|getFullYear\(\)\s*-/)
    }
  })
})
