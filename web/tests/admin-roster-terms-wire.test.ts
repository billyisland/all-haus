import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// The roster's terms columns must be fields the gateway actually sends.
//
// `AdminMember` is a hand-written interface, and `tsc` will confirm the table
// agrees with it whether or not the server does — which is how the admin
// Reports page rendered `undefined` for five fields for its whole life while
// typechecking, linting and building clean. A field the response has never
// carried renders as an empty cell, and an empty cell here reads as "this
// member has accepted nothing", which is a claim about a person.
//
// Reads the gateway source rather than importing it: there is no module path
// between the two workspaces (same shape as `admin-report-wire.test.ts`).
// =============================================================================

const ADMIN_DASHBOARD = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
const WEB_TYPES = join(__dirname, '../src/lib/api/admin-dashboard.ts')

describe('member roster — terms fields, parity with the gateway', () => {
  const src = readFileSync(ADMIN_DASHBOARD, 'utf8')

  it('reads the two columns in the roster query', () => {
    const query = src.match(/SELECT a\.id, a\.username[\s\S]*?LIMIT \$3/)
    // Assert we FOUND the query: a rewritten roster would otherwise make this
    // suite pass by testing nothing.
    expect(query, 'roster SELECT not found — was it rewritten?').toBeTruthy()
    expect(query![0]).toContain('a.reader_terms_version')
    expect(query![0]).toContain('a.writer_terms_version')
  })

  it('sends them under the names the table reads', () => {
    // The mapping, not the query: a column selected and never mapped is the
    // same empty cell.
    expect(src).toMatch(/readerTermsVersion:\s*\(r\.reader_terms_version/)
    expect(src).toMatch(/writerTermsVersion:\s*\(r\.writer_terms_version/)
  })

  it('the web interface names the same two fields', () => {
    const web = readFileSync(WEB_TYPES, 'utf8')
    const iface = web.match(/export interface AdminMember \{([\s\S]*?)\n\}/)
    expect(iface, 'AdminMember not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/readerTermsVersion: string \| null/)
    expect(iface![1]).toMatch(/writerTermsVersion: string \| null/)
  })
})
