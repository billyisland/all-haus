import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { buildUnsubscribeUrl } from '../src/lib/publish-email-template.js'

// =============================================================================
// APP_URL HAS NO PRIVATE FALLBACK IN `shared/` (§0ab residual, 2026-09-25).
//
// Nine sends built their links from `process.env.APP_URL ?? …` — the magic
// link's defaulting to `localhost:3000`, the GATEWAY's port rather than the
// web's. An absent APP_URL in production is a misconfiguration
// (`ops-and-config.md` › *A fallback is for an absent value*), and the fallback
// turned it into an email whose every link pointed at localhost, delivered and
// counted as sent. Now each reads `requireEnv('APP_URL')` at SEND time, so an
// absent value throws into the send's own catch and is counted unsent.
//
// Two halves: the grep (no fallback anywhere, and the consumers FOUND reading
// it the new way — a pin that matches nothing proves nothing), and the
// behaviour (read at call time, not frozen into a module constant at import).
// =============================================================================

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return tsFiles(p)
    return e.name.endsWith('.ts') ? [p] : []
  })
}

const CONSUMERS = [
  'lib/email.ts',
  'lib/publish-emails.ts',
  'lib/publish-email-template.ts',
  // Every template builds its links through `siteUrl`, so the email modules
  // above that no longer read APP_URL themselves are covered here.
  'lib/email/format.ts',
]

describe('APP_URL in shared/ — no private fallback', () => {
  it('no file under shared/src defaults APP_URL', () => {
    const files = tsFiles(SRC)
    expect(files.length).toBeGreaterThan(20)
    const offenders = files.filter((f) =>
      /process\.env\.APP_URL\s*(\?\?|\|\|)/.test(fs.readFileSync(f, 'utf8')),
    )
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([])
  })

  it.each(CONSUMERS)('%s reads it through requireEnv', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8')
    expect(src).toMatch(/requireEnv\(\s*['"]APP_URL['"]\s*\)/)
  })
})

describe('APP_URL is read at send time', () => {
  const saved = process.env.APP_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL
    else process.env.APP_URL = saved
  })

  const build = () =>
    buildUnsubscribeUrl('acc-1', 'tgt-1', 'subscription', 'k'.repeat(64))

  it('follows the environment after import, not a module constant', () => {
    process.env.APP_URL = 'https://one.example'
    expect(build().startsWith('https://one.example/api/v1/email/unsubscribe?')).toBe(true)
    process.env.APP_URL = 'https://two.example'
    expect(build().startsWith('https://two.example/api/v1/email/unsubscribe?')).toBe(true)
  })

  it('throws when APP_URL is absent, rather than linking to localhost', () => {
    delete process.env.APP_URL
    expect(build).toThrow(/APP_URL/)
  })
})
