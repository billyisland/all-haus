import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { USERNAME_RE } from '../src/auth/username-rule.js'
import {
  RESERVED_USERNAMES,
  RESERVED_USERNAME_PREFIXES,
  isReservedUsername,
} from '../src/auth/reserved-usernames.js'

// =============================================================================
// THE RESERVED USERNAMES ARE DERIVED FROM WHAT TAKES A TOP-LEVEL PATH
// (MODERNHAUS-ADR §R2.10).
//
// A profile is `/<username>`, the web app's root `[username]` route, and three
// things answer a top-level path before it can:
//   1. a web page — every segment directly under `web/src/app`;
//   2. `web/next.config.js` — a redirect or rewrite `source`;
//   3. `nginx.conf` — a location that sends the path somewhere other than the
//      web app. An exact location, or a PROXIED trailing-slash prefix, shadows
//      ONE name (nginx 301s a bare `/api` to `/api/`); a prefix written WITHOUT the
//      slash shadows every name that starts with it, unless its block proxies
//      to the web app anyway (`/modernhaus`), which then decides for itself.
// Each is read here, filtered to what `USERNAME_RE` admits (a name nobody can
// hold needs no reserving), and must equal the lists in
// `reserved-usernames.ts` exactly — a new page is a red test until it is
// added, and a name nothing shadows any more is a red test until it is freed.
// Each source asserts it FOUND something, so a moved file cannot pass by
// testing nothing.
// =============================================================================

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')
const holdable = (n: string) => USERNAME_RE.test(n)

function appSegments(): string[] {
  const dir = path.join(ROOT, 'web/src/app')
  return readdirSync(dir).filter(
    (n) => statSync(path.join(dir, n)).isDirectory() && !/^[[(_@]/.test(n),
  )
}

function nextConfigSegments(): string[] {
  const src = read('web/next.config.js')
  return [...src.matchAll(/source:\s*'\/([^/':]+)/g)].map((m) => m[1])
}

function nginxShadows(): { exact: string[]; prefix: string[] } {
  const src = read('nginx.conf')
  const exact: string[] = []
  const prefix: string[] = []
  // `location [=] /path {` and the block up to its closing brace at that indent.
  for (const m of src.matchAll(/^(\s*)location\s+(=\s*)?(\/[^\s{]*)\s*\{([\s\S]*?)^\1\}/gm)) {
    const [, , eq, p, body] = m
    const seg = p.split('/')[1]
    if (!seg) continue // `location /`
    const bare = p === `/${seg}`
    if (eq) {
      if (bare) exact.push(seg) // `= /x/deeper` shadows only that deeper path
    } else if (p === `/${seg}/`) {
      // nginx 301s a bare `/x` to `/x/` only for a PROXIED prefix location;
      // `location /ingest/ { return 404; }` leaves `/ingest` to the web app.
      if (body.includes('proxy_pass')) exact.push(seg)
    } else if (bare) {
      if (body.includes('upstream_web')) continue // the web app answers it anyway
      prefix.push(seg)
    }
  }
  return { exact, prefix }
}

describe('the reserved usernames', () => {
  const app = appSegments()
  const next = nextConfigSegments()
  const nginx = nginxShadows()

  it('finds each of the three sources', () => {
    expect(app.length).toBeGreaterThan(30)
    expect(app).toContain('settings')
    expect(next).toContain('api')
    expect(nginx.exact).toContain('api')
    expect(nginx.prefix).toContain('relay')
  })

  it('names exactly the holdable names a fixed path shadows', () => {
    const derived = [...new Set([...app, ...next, ...nginx.exact])].filter(holdable).sort()
    expect([...RESERVED_USERNAMES].sort()).toEqual(derived)
  })

  it('names exactly the prefixes nginx sends elsewhere', () => {
    expect([...RESERVED_USERNAME_PREFIXES].sort()).toEqual([...new Set(nginx.prefix)].sort())
  })

  it('is kept sorted, so a diff shows the one name that moved', () => {
    expect([...RESERVED_USERNAMES]).toEqual([...RESERVED_USERNAMES].sort())
  })

  it('refuses an exact name and a prefixed one, and leaves an ordinary name alone', () => {
    expect(isReservedUsername('settings')).toBe(true)
    expect(isReservedUsername('Settings')).toBe(true)
    expect(isReservedUsername('rss-weekly')).toBe(true)
    expect(isReservedUsername('settingsfan')).toBe(false)
    expect(isReservedUsername('marguerite')).toBe(false)
  })
})

// A TYPE IS NOT A CONTRACT (testing.md): the settings field tells a reserved
// name from a taken one by the reason string the route sends.
describe("check-username's `Reserved` reason on the wire", () => {
  it('the gateway sends it and the web reads it', () => {
    const route = read('gateway/src/routes/auth.ts')
    expect(route).toMatch(/isReservedUsername\(username\)\)\s*\{[\s\S]{0,120}reason: "Reserved"/)
    expect(route).toMatch(/isReservedUsername\(newUsername\)\)\s*\{[\s\S]{0,80}USERNAME_RESERVED_MESSAGE/)
    const field = read('web/src/components/profile/UsernameChange.tsx')
    expect(field).toContain("result.reason === 'Reserved' ? 'reserved'")
  })
})
