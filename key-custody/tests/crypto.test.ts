import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeypair } from '../src/lib/crypto.js'
import { getPublicKey } from 'nostr-tools'
import { createDecipheriv } from 'crypto'

// =============================================================================
// Keypair Tests
//
// Tests the custodial keypair generation and private key encryption.
// Verifies that:
//   - Generated keypairs are valid Nostr keypairs
//   - Private keys are encrypted at rest (not stored in plaintext)
//   - Encrypted privkeys can be decrypted back to valid keys
//   - Each generation produces unique keypairs
// =============================================================================

beforeAll(() => {
  process.env.ACCOUNT_KEY_HEX = 'c'.repeat(64) // 32 bytes of 0xcc
})

describe('generateKeypair', () => {
  it('produces a valid Nostr keypair', () => {
    const { pubkeyHex, privkeyEncrypted } = generateKeypair()

    expect(pubkeyHex).toMatch(/^[0-9a-f]{64}$/)

    const decoded = Buffer.from(privkeyEncrypted, 'base64')
    // iv(12) + authTag(16) + ciphertext(32) = 60 bytes
    expect(decoded.length).toBe(60)
  })

  it('produces unique keypairs on each call', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()

    expect(kp1.pubkeyHex).not.toBe(kp2.pubkeyHex)
    expect(kp1.privkeyEncrypted).not.toBe(kp2.privkeyEncrypted)
  })

  it('encrypted privkey decrypts to a key that matches the pubkey', () => {
    const { pubkeyHex, privkeyEncrypted } = generateKeypair()

    const accountKey = Buffer.from(process.env.ACCOUNT_KEY_HEX!, 'hex')
    const combined = Buffer.from(privkeyEncrypted, 'base64')
    const iv = combined.subarray(0, 12)
    const authTag = combined.subarray(12, 28)
    const ciphertext = combined.subarray(28)

    const decipher = createDecipheriv('aes-256-gcm', accountKey, iv)
    decipher.setAuthTag(authTag)
    const privkeyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    const derivedPubkey = getPublicKey(new Uint8Array(privkeyBytes))
    expect(derivedPubkey).toBe(pubkeyHex)
  })

  it('privkey is exactly 32 bytes when decrypted', () => {
    const { privkeyEncrypted } = generateKeypair()

    const accountKey = Buffer.from(process.env.ACCOUNT_KEY_HEX!, 'hex')
    const combined = Buffer.from(privkeyEncrypted, 'base64')
    const iv = combined.subarray(0, 12)
    const authTag = combined.subarray(12, 28)
    const ciphertext = combined.subarray(28)

    const decipher = createDecipheriv('aes-256-gcm', accountKey, iv)
    decipher.setAuthTag(authTag)
    const privkeyBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()])

    expect(privkeyBytes.length).toBe(32)
  })

  it('rejects decryption with wrong key', () => {
    const { privkeyEncrypted } = generateKeypair()

    const wrongKey = Buffer.from('d'.repeat(64), 'hex')
    const combined = Buffer.from(privkeyEncrypted, 'base64')
    const iv = combined.subarray(0, 12)
    const authTag = combined.subarray(12, 28)
    const ciphertext = combined.subarray(28)

    const decipher = createDecipheriv('aes-256-gcm', wrongKey, iv)
    decipher.setAuthTag(authTag)

    expect(() => {
      Buffer.concat([decipher.update(ciphertext), decipher.final()])
    }).toThrow()
  })
})
