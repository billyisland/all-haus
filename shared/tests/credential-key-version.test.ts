import { describe, it, expect, afterEach } from 'vitest'
import { encryptCredentials, decryptCredentials } from '../src/lib/crypto.js'

// =============================================================================
// A missing ROTATION KEY is a configuration fault, not a corrupt credential.
//
// `decryptCredentials` wraps a versioned blob's whole read in one `catch` that
// falls through to the legacy (v0) path. Two unrelated causes shared it:
//
//   • `getKeyForVersion` throwing, because `LINKED_ACCOUNT_KEY_HEX_V{n}` is not
//     set for a version that is IN THE DATA. The legacy path cannot recover
//     from that — a versioned blob read at v0 offsets has its iv and tag one
//     byte out by construction — so falling through only replaces a precise
//     diagnosis with `Unsupported state or unable to authenticate data`, which
//     says the stored credential is corrupt. It is not. Meeting that message
//     just after rotating a key is exactly when somebody concludes the
//     rollover destroyed the rows.
//   • the DECRYPTION throwing, which is the ambiguous case the fall-through is
//     for: a v0 blob whose random first byte happened to look like a version.
//
// Same terminal-vs-ambiguous split as the Stripe and outbound classifiers, and
// the fall-through must survive it — which is what the last case here pins.
// =============================================================================

const K1 = '11'.repeat(32)
const K2 = '22'.repeat(32)

const saved = {
  hex: process.env.LINKED_ACCOUNT_KEY_HEX,
  version: process.env.LINKED_ACCOUNT_KEY_VERSION,
  v1: process.env.LINKED_ACCOUNT_KEY_HEX_V1,
}
afterEach(() => {
  for (const [k, v] of [
    ['LINKED_ACCOUNT_KEY_HEX', saved.hex],
    ['LINKED_ACCOUNT_KEY_VERSION', saved.version],
    ['LINKED_ACCOUNT_KEY_HEX_V1', saved.v1],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('versioned credential decryption', () => {
  it('round-trips at the current version', () => {
    process.env.LINKED_ACCOUNT_KEY_HEX = K1
    process.env.LINKED_ACCOUNT_KEY_VERSION = '1'
    expect(decryptCredentials(encryptCredentials('a-refresh-token'))).toBe('a-refresh-token')
  })

  it('reads a v1 row after rotation to v2, given the retained key', () => {
    process.env.LINKED_ACCOUNT_KEY_HEX = K1
    process.env.LINKED_ACCOUNT_KEY_VERSION = '1'
    const blob = encryptCredentials('a-refresh-token')

    // Operator rotates: new key becomes current at v2, old key retained as _V1.
    process.env.LINKED_ACCOUNT_KEY_HEX = K2
    process.env.LINKED_ACCOUNT_KEY_VERSION = '2'
    process.env.LINKED_ACCOUNT_KEY_HEX_V1 = K1

    expect(decryptCredentials(blob)).toBe('a-refresh-token')
  })

  it('names the MISSING KEY when the retained version was not configured', () => {
    process.env.LINKED_ACCOUNT_KEY_HEX = K1
    process.env.LINKED_ACCOUNT_KEY_VERSION = '1'
    const blob = encryptCredentials('a-refresh-token')

    // Rotation without retaining the old key — the operator error this is for.
    process.env.LINKED_ACCOUNT_KEY_HEX = K2
    process.env.LINKED_ACCOUNT_KEY_VERSION = '2'
    delete process.env.LINKED_ACCOUNT_KEY_HEX_V1

    // What matters is the WORDS, not that it throws: the old behaviour threw
    // too, with a message accusing the data.
    expect(() => decryptCredentials(blob)).toThrow(/LINKED_ACCOUNT_KEY_HEX_V1/)
    expect(() => decryptCredentials(blob)).toThrow(/version-1/)
    expect(() => decryptCredentials(blob)).toThrow(/intact/)
    expect(() => decryptCredentials(blob)).not.toThrow(/unable to authenticate/)
  })

  it('still falls through to the legacy path when the DECRYPTION is what failed', () => {
    // The fall-through's real case, and the reason key resolution had to be
    // lifted out of the try rather than the catch simply being removed: a v0
    // blob whose random first byte happens to look like a known version.
    process.env.LINKED_ACCOUNT_KEY_HEX = K1
    process.env.LINKED_ACCOUNT_KEY_VERSION = '1'
    const versioned = Buffer.from(encryptCredentials('legacy-shaped'), 'base64url')

    // Strip the version byte: a genuine v0 layout, iv ‖ tag ‖ ct. Its first
    // byte is the iv's first byte, which is random — force it to 1 so the
    // versioned branch is entered and must fall through.
    const legacy = Buffer.from(versioned.subarray(1))
    legacy[0] = 1
    // Re-encrypt at v0 with that iv so the blob is genuinely decryptable.
    const { createCipheriv } = require('crypto') as typeof import('crypto')
    const key = Buffer.from(K1, 'hex')
    const iv = legacy.subarray(0, 12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update('legacy-shaped', 'utf8'), cipher.final()])
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')

    expect(decryptCredentials(blob)).toBe('legacy-shaped')
  })
})
