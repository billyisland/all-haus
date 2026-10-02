import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// The terms the web reads off the session must be terms the gateway sends.
//
// `MeResponse` is a hand-written interface, and `tsc` will confirm every caller
// agrees with it whether or not the server does — which is how the admin
// Reports page rendered `undefined` for five fields for its whole life while
// typechecking, linting and building clean. Here the consequences are worse
// than an empty cell: `terms.reader.current` is the version the card-setup form
// POSTS, and `terms.writer.isCurrent` is what decides whether the editor puts
// the Writer Agreement in front of a paid publish. A field the response has
// never carried makes the first send `undefined` (a 400 on every card) and the
// second read `undefined !== false` (the gate never shows, and the writer meets
// a 403 from the gateway instead).
//
// Reads the gateway source rather than importing it: there is no module path
// between the two workspaces (same shape as `admin-report-wire.test.ts`).
//
// It also pins the two REFUSAL CODES, which are strings crossing the same
// boundary with no type in common — `mapUnlockError` branches on one and the
// editor's error copy on the other.
// =============================================================================

const GATEWAY_AUTH = join(__dirname, '../../gateway/src/routes/auth.ts')
const GATE_PASS_ROUTE = join(__dirname, '../../gateway/src/routes/articles/gate-pass.ts')
const SUBSCRIBE_WRITER_ROUTE = join(__dirname, '../../gateway/src/routes/subscriptions/writer.ts')
const SUBSCRIBE_PUBLICATION_ROUTE = join(__dirname, '../../gateway/src/routes/subscriptions/publication.ts')
const TERMS_GATE = join(__dirname, '../../gateway/src/lib/terms-gate.ts')
const ADMIN_DASHBOARD = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
const WEB_AUTH = join(__dirname, '../src/lib/api/auth.ts')
const WEB_ADMIN = join(__dirname, '../src/lib/api/admin-dashboard.ts')
const UNLOCK_ERRORS = join(__dirname, '../src/lib/unlock-errors.ts')

describe('/auth/me terms — parity with the gateway', () => {
  const src = readFileSync(GATEWAY_AUTH, 'utf8')

  it('sends the four fields the web reads, under both kinds', () => {
    const block = src.match(/terms: \{[\s\S]*?\n {6}\},/)
    // Assert we FOUND the block: a rewritten /auth/me would otherwise make
    // this suite pass by testing nothing.
    expect(block, 'the terms block in /auth/me not found — was it rewritten?').toBeTruthy()
    for (const kind of ['reader', 'writer']) {
      expect(block![0]).toContain(`${kind}: {`)
    }
    for (const field of ['acceptedAt:', 'version:', 'current:', 'isCurrent:']) {
      expect(block![0]).toContain(field)
    }
  })

  it('the web interface names the same four fields', () => {
    const web = readFileSync(WEB_AUTH, 'utf8')
    const iface = web.match(/export interface TermsState \{([\s\S]*?)\n\}/)
    expect(iface, 'TermsState not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/acceptedAt: string \| null/)
    expect(iface![1]).toMatch(/version: string \| null/)
    expect(iface![1]).toMatch(/current: string/)
    expect(iface![1]).toMatch(/isCurrent: boolean/)
  })

  it('the connect-card body carries the field the route requires', () => {
    // A required zod field the client never sends is a 400 on every card.
    const schema = src.match(/const ConnectCardSchema = z\.object\(\{[\s\S]*?\}\);/)
    expect(schema, 'ConnectCardSchema not found — was it renamed?').toBeTruthy()
    expect(schema![0]).toContain('readerTermsVersion')

    const web = readFileSync(WEB_AUTH, 'utf8')
    expect(web).toMatch(/JSON\.stringify\(\{ setupIntentId, readerTermsVersion \}\)/)
  })

  it('the accept-terms body carries the two fields the route parses', () => {
    const schema = src.match(/const AcceptTermsSchema = z\.object\(\{[\s\S]*?\}\);/)
    expect(schema, 'AcceptTermsSchema not found — was it renamed?').toBeTruthy()
    expect(schema![0]).toContain('kind')
    expect(schema![0]).toContain('version')

    const web = readFileSync(WEB_AUTH, 'utf8')
    expect(web).toMatch(/JSON\.stringify\(\{ kind, version \}\)/)
  })
})

describe('the refusal codes — pinned against the gateway that mints them', () => {
  it('reader_terms_required is what the gate-pass route sends', () => {
    // The constant lives in terms-gate.ts and the route sends it by name, so
    // the string itself is asserted where it is DEFINED, and its use in the
    // route asserted separately — a renamed constant would otherwise make this
    // pass by testing nothing.
    const gate = readFileSync(TERMS_GATE, 'utf8')
    const decl = gate.match(/READER_TERMS_REQUIRED = "([^"]+)"/)
    expect(decl, 'READER_TERMS_REQUIRED not found').toBeTruthy()
    expect(readFileSync(GATE_PASS_ROUTE, 'utf8')).toContain('error: READER_TERMS_REQUIRED')
    // …and what both subscribe routes send since §0z item 5 (2026-09-18): a
    // subscription is a sale under the same text, and the two web surfaces
    // that press it branch on the same string.
    expect(readFileSync(SUBSCRIBE_WRITER_ROUTE, 'utf8')).toContain('error: READER_TERMS_REQUIRED')
    expect(readFileSync(SUBSCRIBE_PUBLICATION_ROUTE, 'utf8')).toContain('error: READER_TERMS_REQUIRED')

    // And the web branches on that exact string — declared ONCE, in
    // unlock-errors.ts. The subscribe surfaces reach it through the one
    // subscribe mapper (W5 / walkthrough A9), which every one of them imports.
    const web = readFileSync(UNLOCK_ERRORS, 'utf8')
    expect(web).toContain(`export const READER_TERMS_REQUIRED_CODE = '${decl![1]}'`)
    expect(readFileSync(join(__dirname, '../src/lib/subscribe-errors.ts'), 'utf8')).toContain(
      'code === READER_TERMS_REQUIRED_CODE',
    )
    for (const surface of [
      '../src/components/profile/NativeProfileBody.tsx',
      '../src/components/profile/FollowingTab.tsx',
      '../src/app/subscribe/[code]/page.tsx',
    ]) {
      expect(readFileSync(join(__dirname, surface), 'utf8')).toContain('mapSubscribeError(')
    }
  })

  it('terms_version_mismatch is what both refusing routes send', () => {
    const src = readFileSync(GATEWAY_AUTH, 'utf8')
    // Twice: /auth/accept-terms and /auth/connect-card. One is not enough —
    // the card path is the one that would otherwise fail with no copy for it.
    const hits = src.match(/error: "terms_version_mismatch"/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the admin overview totals — parity with the gateway', () => {
  it('sends the two outstanding counts the tiles read', () => {
    const src = readFileSync(ADMIN_DASHBOARD, 'utf8')
    expect(src).toMatch(/readerTermsOutstanding: num\(t\.reader_terms_outstanding\)/)
    expect(src).toMatch(/writerTermsOutstanding: num\(t\.writer_terms_outstanding\)/)

    const web = readFileSync(WEB_ADMIN, 'utf8')
    const iface = web.match(/export interface AdminUsers \{([\s\S]*?)\n\}/)
    expect(iface, 'AdminUsers not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/readerTermsOutstanding: number/)
    expect(iface![1]).toMatch(/writerTermsOutstanding: number/)
  })
})
