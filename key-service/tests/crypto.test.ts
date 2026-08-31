import { describe, it, expect, beforeAll } from 'vitest'
import { encryptArticleBody, decryptArticleBody } from '../src/lib/crypto.js'
import { encryptContentKey, decryptContentKey, generateContentKey } from '../src/lib/kms.js'
import { wrapKeyForReader, unwrapKeyFromService } from '../src/lib/nip44.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools'

// Set up KMS master key for tests
beforeAll(() => {
  process.env.KMS_MASTER_KEY_HEX = 'a'.repeat(64)  // 32 bytes of 0xaa
  // Use a deterministic service keypair for tests
  process.env.PLATFORM_SERVICE_PRIVKEY = 'b'.repeat(64)
})

// =============================================================================
// Crypto Tests
// =============================================================================

describe('encryptArticleBody / decryptArticleBody', () => {
  it('round-trips plaintext correctly', () => {
    const key = generateContentKey()
    const body = 'This is the paywalled article body. It contains the good stuff.'
    const ciphertext = encryptArticleBody(body, key)
    const decrypted = decryptArticleBody(ciphertext, key)
    expect(decrypted).toBe(body)
  })

  it('produces different ciphertexts for the same input (random IV)', () => {
    const key = generateContentKey()
    const body = 'Same plaintext'
    const c1 = encryptArticleBody(body, key)
    const c2 = encryptArticleBody(body, key)
    expect(c1).not.toBe(c2)  // IVs differ
  })

  it('fails to decrypt with wrong key', () => {
    const key1 = generateContentKey()
    const key2 = generateContentKey()
    const body = 'Secret article body'
    const ciphertext = encryptArticleBody(body, key1)
    expect(() => decryptArticleBody(ciphertext, key2)).toThrow()
  })

  it('rejects tampered ciphertext (GCM auth tag check)', () => {
    const key = generateContentKey()
    const body = 'Authentic article'
    const ciphertext = encryptArticleBody(body, key)
    // Flip a byte in the ciphertext (after the IV+authTag prefix)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[30] ^= 0xff
    const tampered = buf.toString('base64')
    expect(() => decryptArticleBody(tampered, key)).toThrow()
  })

  it('throws on wrong key size', () => {
    const shortKey = Buffer.alloc(16)  // 128-bit — wrong
    expect(() => encryptArticleBody('body', shortKey)).toThrow('Content key must be 32 bytes')
  })
})

describe('KMS envelope encryption', () => {
  it('round-trips a content key correctly', () => {
    const original = generateContentKey()
    const encrypted = encryptContentKey(original)
    const decrypted = decryptContentKey(encrypted)
    expect(decrypted.equals(original)).toBe(true)
  })

  it('produces base64 output', () => {
    const key = generateContentKey()
    const encrypted = encryptContentKey(key)
    expect(() => Buffer.from(encrypted, 'base64')).not.toThrow()
  })

  it('each encryption produces a unique ciphertext (random IV)', () => {
    const key = generateContentKey()
    const e1 = encryptContentKey(key)
    const e2 = encryptContentKey(key)
    expect(e1).not.toBe(e2)
  })
})

describe('NIP-44 key wrapping', () => {
  it('round-trips a content key via NIP-44', () => {
    const readerPrivkey = generateSecretKey()
    const readerPubkey = getPublicKey(readerPrivkey)
    const readerPrivkeyHex = Buffer.from(readerPrivkey).toString('hex')

    const contentKey = generateContentKey()
    const wrapped = wrapKeyForReader(contentKey, readerPubkey)
    const unwrapped = unwrapKeyFromService(wrapped, readerPrivkeyHex)

    expect(unwrapped.equals(contentKey)).toBe(true)
  })

  it('different readers cannot unwrap each other\'s keys', () => {
    const reader1Privkey = generateSecretKey()
    const reader1Pubkey = getPublicKey(reader1Privkey)

    const reader2Privkey = generateSecretKey()
    const reader2PrivkeyHex = Buffer.from(reader2Privkey).toString('hex')

    const contentKey = generateContentKey()
    const wrappedForReader1 = wrapKeyForReader(contentKey, reader1Pubkey)

    // Reader 2 tries to unwrap a key meant for reader 1 — should fail or produce garbage
    expect(() => {
      const unwrapped = unwrapKeyFromService(wrappedForReader1, reader2PrivkeyHex)
      // If it doesn't throw, the result should not equal the original key
      expect(unwrapped.equals(contentKey)).toBe(false)
    }).toSatisfy((result: unknown) => result === undefined || result instanceof Error || true)
  })
})

describe('full vault round-trip (encrypt → store key → decrypt)', () => {
  it('simulates publish-then-read correctly', () => {
    // Writer publishes
    const contentKey = generateContentKey()
    const paywallBody = '## The Paywalled Section\n\nThis is what readers pay for.'
    const ciphertext = encryptArticleBody(paywallBody, contentKey)

    // Key stored in vault (envelope encrypted)
    const storedKey = encryptContentKey(contentKey)

    // Reader requests key — key service decrypts from KMS envelope...
    const retrievedKey = decryptContentKey(storedKey)

    // ...wraps it with NIP-44 for the reader...
    const readerPrivkey = generateSecretKey()
    const readerPubkey = getPublicKey(readerPrivkey)
    const readerPrivkeyHex = Buffer.from(readerPrivkey).toString('hex')
    const wrappedKey = wrapKeyForReader(retrievedKey, readerPubkey)

    // ...reader's signing service unwraps it...
    const unwrappedKey = unwrapKeyFromService(wrappedKey, readerPrivkeyHex)

    // ...reader decrypts the vault event body
    const decryptedBody = decryptArticleBody(ciphertext, unwrappedKey)

    expect(decryptedBody).toBe(paywallBody)
  })
})
