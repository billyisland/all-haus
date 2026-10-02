import { describe, it, expect, afterEach } from 'vitest'
import { requireHexKeyBytes, requireEnvMinLength } from '../src/lib/env.js'

// =============================================================================
// A boot check stated in the units the CIPHER uses.
//
// `ACCOUNT_KEY_HEX` and `KMS_MASTER_KEY_HEX` were checked with
// `requireEnvMinLength(name, 32)` — 32 CHARACTERS — while every consumer parses
// them as 32 BYTES, i.e. 64 hex characters. So the one value most likely to be
// wrong (somebody generated 32 chars because the check said 32) passed startup
// and threw at the first real use: the first article publish for one, the first
// paywalled unlock for the other. A fail-fast check that admits exactly the
// wrong value is worse than no check, because the deployment reads as validated.
//
// The control below drives the OLD check on the same value, so the difference
// is demonstrated rather than asserted.
// =============================================================================

const NAME = 'TEST_HEX_KEY_ENV'
afterEach(() => { delete process.env[NAME] })

describe('requireHexKeyBytes', () => {
  it('accepts exactly 32 bytes of hex', () => {
    process.env[NAME] = 'a'.repeat(64)
    expect(requireHexKeyBytes(NAME, 32)).toBe('a'.repeat(64))
  })

  it('accepts upper-case hex', () => {
    process.env[NAME] = 'AB'.repeat(32)
    expect(requireHexKeyBytes(NAME, 32)).toBe('AB'.repeat(32))
  })

  it('REFUSES the 32-character key the old check accepted', () => {
    process.env[NAME] = 'a'.repeat(32)
    // The old check passes it — that is the defect, demonstrated.
    expect(requireEnvMinLength(NAME, 32)).toBe('a'.repeat(32))
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow(/32 bytes as 64 hex characters/)
  })

  it('refuses a LONGER value too — the old check had no upper bound', () => {
    process.env[NAME] = 'a'.repeat(128)
    expect(requireEnvMinLength(NAME, 32)).toBe('a'.repeat(128))
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow()
  })

  it('refuses 64 characters that are not all hex, and says so', () => {
    // Buffer.from(s, 'hex') STOPS at the first non-hex character rather than
    // throwing, so this silently yields a SHORT key at runtime — the failure
    // the length check alone cannot see.
    process.env[NAME] = 'a'.repeat(60) + 'zzzz'
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow(/not all hex/)
  })

  it('refuses an absent variable', () => {
    delete process.env[NAME]
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow(/Missing required environment variable/)
  })

  it('refuses an empty string — a well-formed value of the wrong length', () => {
    process.env[NAME] = ''
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow()
  })

  it('is byte-length agnostic', () => {
    process.env[NAME] = 'ab'.repeat(16)
    expect(requireHexKeyBytes(NAME, 16)).toBe('ab'.repeat(16))
    expect(() => requireHexKeyBytes(NAME, 32)).toThrow()
  })
})
