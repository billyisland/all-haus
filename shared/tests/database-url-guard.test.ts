import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// =============================================================================
// A password in a URL is URL syntax, and `docker-compose.yml` interpolates it
// raw into six `DATABASE_URL`s with no escaping available at that layer.
//
// The check runs at MODULE LOAD (the one place every service builds its pool),
// which is why this suite drives it in a child process rather than importing
// it: importing `client.js` a second time in this process would not re-run it,
// and mutating `process.env` after the fact proves nothing about the boot path.
//
// The point is not that a bad password fails — it already did. It is that each
// of these fails in a way that says nothing about the password: `/` and `#`
// produce an unparseable URL and a connection error, and `@`/`%` produce an
// authentication failure against a password that is character-for-character
// correct.
// =============================================================================

const CLIENT = path.resolve(__dirname, '../src/db/client.ts')

/** Load the module in a child process and report whether it booted, plus
 *  whatever it printed on either stream (the warning goes to stdout via pino,
 *  the throw to stderr). */
function loadWith(url: string | undefined): { ok: boolean; output: string } {
  const env = { ...process.env }
  if (url === undefined) delete env.DATABASE_URL
  else env.DATABASE_URL = url
  try {
    const out = execFileSync(
      'npx',
      ['tsx', '-e', `import(${JSON.stringify(CLIENT)}).then(() => process.exit(0))`],
      { env, stdio: 'pipe', cwd: path.resolve(__dirname, '..') },
    )
    return { ok: true, output: out.toString() }
  } catch (err: any) {
    return { ok: false, output: String(err.output ?? '') + String(err.stdout ?? '') + String(err.message ?? '') }
  }
}

describe('DATABASE_URL guard', () => {
  it('accepts an ordinary URL-safe password', () => {
    expect(loadWith('postgresql://platformpub:p-a_s.s~1@postgres:5432/platformpub').ok).toBe(true)
  }, 40_000)

  it('WARNS about @ in a password without refusing to start', () => {
    // Ambiguous, not terminal: a deployment whose parsers happen to agree is
    // working right now, and turning its boot into a hard failure over a lint
    // of its password would be far worse than the confusing auth error this
    // prevents. The operator gets the diagnosis and decides.
    const r = loadWith('postgresql://platformpub:pa@ss@postgres:5432/platformpub')
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/URL syntax/)
  }, 40_000)

  it('WARNS about % — an invalid percent-escape — without refusing to start', () => {
    const r = loadWith('postgresql://platformpub:pa%ss@postgres:5432/platformpub')
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/URL syntax/)
  }, 40_000)

  it('refuses an unparseable URL and points at the password', () => {
    const r = loadWith('postgresql://platformpub:pa/ss@postgres:5432/platformpub')
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/not a parseable URL/)
    expect(r.output).toMatch(/password/)
  }, 40_000)

  it('says nothing when DATABASE_URL is absent — pg reports that clearly itself', () => {
    // Absent and malformed are different facts, and only the second is one this
    // guard can diagnose better than the driver can.
    expect(loadWith(undefined).ok).toBe(true)
  }, 40_000)
})
