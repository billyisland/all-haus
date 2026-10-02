import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// `canWrite` on the session payload must be a field the gateway sends.
//
// `MeResponse` is hand-written, so `tsc` agrees with it whatever the server
// does. An absent field reads `undefined`, and every consumer asks
// `canWrite === true` — so a rename on either side would silently turn every
// writer into a reader in the web (the first-run tour's ∀ beat first, the
// writing controls after D2), with nothing failing.
//
// Reads the gateway source rather than importing it: there is no module path
// between the two workspaces (the shape of `me-terms-wire.test.ts`).
// =============================================================================

const GATEWAY_AUTH = join(__dirname, '../../gateway/src/routes/auth.ts')
const WEB_AUTH = join(__dirname, '../src/lib/api/auth.ts')

describe('/auth/me canWrite — parity with the gateway', () => {
  it('the gateway derives it from the writer gate column and sends it', () => {
    const src = readFileSync(GATEWAY_AUTH, 'utf8')
    const derive = src.match(/const canWrite = account\.writerAdmittedAt !== null/)
    expect(derive, 'canWrite derivation in /auth/me not found — was it rewritten?').toBeTruthy()
    // Sent in the /auth/me body, after the derivation.
    const send = src.slice(derive!.index!).match(/reply\.status\(200\)\.send\(\{[\s\S]*?\n {6}canWrite,/)
    expect(send, 'canWrite not found in the /auth/me reply').toBeTruthy()
  })

  it('the web interface names it as a boolean', () => {
    const web = readFileSync(WEB_AUTH, 'utf8')
    const iface = web.match(/export interface MeResponse \{([\s\S]*?)\n\}/)
    expect(iface, 'MeResponse not found — was it renamed?').toBeTruthy()
    expect(iface![1]).toMatch(/\n {2}canWrite: boolean\n/)
  })

  it('writerApplication: the gateway sends it, and the web types it', () => {
    const src = readFileSync(GATEWAY_AUTH, 'utf8')
    const send = src.match(/reply\.status\(200\)\.send\(\{[\s\S]*?\n {6}writerApplication,/)
    expect(send, 'writerApplication not found in the /auth/me reply').toBeTruthy()
    const web = readFileSync(WEB_AUTH, 'utf8')
    const iface = web.match(/export interface MeResponse \{([\s\S]*?)\n\}/)
    expect(iface![1]).toMatch(/\n {2}writerApplication: \{ appliedAt: string \} \| null\n/)
  })

  it('the apply call names the route the gateway registers', () => {
    const route = readFileSync(join(__dirname, '../../gateway/src/routes/writer-applications.ts'), 'utf8')
    expect(route).toMatch(/app\.post\("\/writer-applications"/)
    expect(route, 'the route answers appliedAt').toMatch(/send\(\{ appliedAt:/)
    const web = readFileSync(WEB_AUTH, 'utf8')
    expect(web).toMatch(/request<\{ appliedAt: string \}>\('\/writer-applications', \{ method: 'POST' \}\)/)
  })
})
