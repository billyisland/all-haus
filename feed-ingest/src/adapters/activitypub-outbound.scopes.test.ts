import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MASTODON_SCOPE_LIST } from '@platform-pub/shared/lib/mastodon-scopes.js'

// =============================================================================
// A TYPE IS NOT A CONTRACT (testing rule): which scope a Mastodon endpoint needs
// is a fact about Mastodon, and which endpoints we call is a fact about the
// adapter's SOURCE. Our tokens once held neither `read:search` nor
// `write:favourites`, so every remote reply's lookup and every like failed —
// and the reply then posted without its parent (CROSS-NETWORK-ROUNDTRIP-ADR F5).
//
// So: read the adapter, find every endpoint it spells, and require that each is
// in the table below (from Mastodon's documented scopes), that its scope is one
// we ASK for, and that the adapter CHECKS that scope before calling. An
// endpoint added to the adapter without a row here fails the first assertion.
// =============================================================================

const ENDPOINT_SCOPE: Record<string, string> = {
  '/api/v1/statuses': 'write:statuses',
  '/api/v2/search': 'read:search',
  '/api/v1/statuses/:id': 'read:statuses',
  '/api/v1/statuses/:id/favourite': 'write:favourites',
  '/api/v1/statuses/:id/reblog': 'write:statuses',
  '/api/v1/polls/:id/votes': 'write:statuses',
  // The linked-notification poller's reads (CROSS-NETWORK-ROUNDTRIP-ADR C1).
  '/api/v1/notifications': 'read:notifications',
}

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const adapter = read('./activitypub-outbound.ts')

function endpointsIn(src: string): string[] {
  const found = new Set<string>()
  for (const m of src.matchAll(/\/api\/v\d\/[A-Za-z0-9_/${}.]+/g)) {
    found.add(m[0].replace(/\$\{[^}]+\}/g, ':id').replace(/\/$/, ''))
  }
  return [...found]
}

describe('Mastodon outbound scopes', () => {
  const endpoints = endpointsIn(adapter)

  it('finds the endpoints (the scan is not silently empty)', () => {
    expect(endpoints.length).toBeGreaterThanOrEqual(5)
    expect(endpoints).toContain('/api/v2/search')
  })

  it('every endpoint the adapter calls has a known scope', () => {
    for (const e of endpoints) expect(ENDPOINT_SCOPE, e).toHaveProperty([e])
  })

  it('every scope the adapter needs is one we ask for', () => {
    for (const e of endpoints) expect(MASTODON_SCOPE_LIST as readonly string[]).toContain(ENDPOINT_SCOPE[e])
  })

  it('the adapter checks every scope it needs before calling', () => {
    for (const e of endpoints) {
      expect(adapter, `${e} → requireScope(…, "${ENDPOINT_SCOPE[e]}")`).toContain(
        `requireScope(credentials, "${ENDPOINT_SCOPE[e]}")`,
      )
    }
  })

  it('the gateway asks for the shared set and spells no scope of its own', () => {
    const gw = read('../../../gateway/src/routes/linked-accounts.ts')
    expect(gw).toMatch(/import \{[^}]*\bMASTODON_SCOPES\b[^}]*\} from "@platform-pub\/shared\/lib\/mastodon-scopes\.js"/)
    expect(gw).not.toMatch(/["'`](read|write):[a-z]+/)
    // Registration, authorize and token exchange all send it.
    expect(gw.match(/scopes?: MASTODON_SCOPES|"scope", MASTODON_SCOPES/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
