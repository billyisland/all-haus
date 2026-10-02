import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRITER_GRANT_EMAILED, WRITER_GRANT_REFUSALS } from '../src/lib/api/admin-dashboard'

// =============================================================================
// The Writers section must read what the gateway sends and send what it reads
// (READER-WRITER-SPLIT-ADR §8, reshape D3).
//
// `AdminWriterApplications` and the grant result are hand-written claims about
// `gateway/src/routes/admin-dashboard.ts`, and `tsc` checks the page against
// the claim, never the claim against the route. The failure this pins is the
// quiet one: a field that arrives `undefined` renders a row with no name, and
// an `emailed` value the page has no words for leaves a failed email unsaid —
// a member who can publish and does not know it. There is no module path
// between the workspaces, so this READS the gateway file and asserts every
// match was FOUND (testing.md › A TYPE IS NOT A CONTRACT).
// =============================================================================

const GATEWAY_ADMIN = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
const WRITER_GATE = join(__dirname, '../../gateway/src/lib/writer-gate.ts')
const PAGE = join(__dirname, '../src/app/admin/waitlist/page.tsx')

const gateway = readFileSync(GATEWAY_ADMIN, 'utf8')

function routeBody(path: string): string {
  const start = gateway.indexOf(`app.${path.startsWith('POST') ? 'post' : 'get'}('${path.split(' ')[1]}'`)
  expect(start, `${path} not found in admin-dashboard.ts — was it moved?`).toBeGreaterThan(-1)
  const end = gateway.indexOf('\n  })\n', start)
  return gateway.slice(start, end)
}

describe('writer applications — web ↔ gateway', () => {
  it('the list route sends every field the page reads', () => {
    const body = routeBody('GET /admin/dashboard/writer-applications')
    for (const field of [
      'accountId:',
      'username:',
      'displayName:',
      'status:',
      'memberSince:',
      'appliedAt:',
      'grantedAt:',
      'grantedBy:',
      'truncated',
      'pending:',
      'granted:',
    ]) {
      expect(body, field).toContain(field)
    }
  })

  it('the grant route reads the body the web sends', () => {
    const body = routeBody('POST /admin/dashboard/writer-applications/grant')
    const schema = gateway.match(/const GrantWriterSchema = z\.object\(\{([\s\S]*?)\}\)/)
    expect(schema, 'GrantWriterSchema not found').toBeTruthy()
    expect(schema![1]).toMatch(/accountId:/)
    expect(schema![1]).toMatch(/reason:/)
    expect(body).toContain('GrantWriterSchema')
  })

  it('every emailed value the route can send has words on the page', () => {
    const body = routeBody('POST /admin/dashboard/writer-applications/grant')
    const declared = body.match(/let emailed: ([^=]+)=/)
    expect(declared, "the route's `emailed` union not found").toBeTruthy()
    const sent = [...declared![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent).toEqual([...WRITER_GRANT_EMAILED].sort())
  })

  it('every refusal the route chooses is one the page words', () => {
    const body = routeBody('POST /admin/dashboard/writer-applications/grant')
    const gate = readFileSync(WRITER_GATE, 'utf8')
    const outcomes = gate.match(/WRITER_GRANT_OUTCOMES = \[([^\]]+)\]/)
    expect(outcomes, 'WRITER_GRANT_OUTCOMES not found in writer-gate.ts').toBeTruthy()
    const refusals = [...outcomes![1].matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .filter((o) => o !== 'granted')
    // The route's own refusal, beside the function's.
    expect(body).toContain("'no_application'")
    const all = [...refusals, 'no_application'].sort()
    expect(all).toEqual([...WRITER_GRANT_REFUSALS].sort())

    const page = readFileSync(PAGE, 'utf8')
    for (const code of WRITER_GRANT_REFUSALS) {
      expect(page, `the page has no sentence for ${code}`).toContain(`case '${code}':`)
    }
  })
})
