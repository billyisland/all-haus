import { describe, it, expect, beforeAll } from 'vitest'
import { createCipheriv, randomBytes } from 'crypto'

// =============================================================================
// The GCM tag length is PINNED on decrypt (CA-F14c).
//
// Without `authTagLength`, Node's GCM decipher accepts any tag of 4–16 bytes,
// so a stored blob whose tag was cut short verifies against the SHORTER tag —
// a 4-byte tag is a 1-in-4-billion forgery, not a 1-in-2^128 one. The layout
// here is iv(12) ‖ tag(16) ‖ ct, so the short tag is reachable exactly when the
// blob is shorter than 28 bytes. The case builds a GENUINE 4-byte-tag
// encryption of empty plaintext: unpinned it decrypts cleanly, pinned it
// must throw.
// =============================================================================

const KEY_HEX = 'a'.repeat(64)

beforeAll(() => {
  process.env.KMS_MASTER_KEY_HEX = KEY_HEX
})

function shortTagBlob(): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_HEX, 'hex'), iv, { authTagLength: 4 })
  const ct = Buffer.concat([cipher.update(Buffer.alloc(0)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

describe('decryptContentKey — GCM tag length', () => {
  it('refuses a blob carrying a 4-byte tag', async () => {
    const { decryptContentKey } = await import('../src/lib/kms.js')
    expect(() => decryptContentKey(shortTagBlob())).toThrow()
  })

  it('control: a full-length blob round-trips', async () => {
    const { encryptContentKey, decryptContentKey } = await import('../src/lib/kms.js')
    const key = randomBytes(32)
    expect(decryptContentKey(encryptContentKey(key)).equals(key)).toBe(true)
  })
})
