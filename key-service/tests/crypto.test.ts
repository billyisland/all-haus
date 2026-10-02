import { describe, it, expect, beforeAll } from 'vitest'
import {
  encryptArticleBody,
  decryptArticleBody,
  encryptArticleBodyXChaCha,
  decryptArticleBodyXChaCha,
} from '../src/lib/crypto.js'
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

  // THIS TEST USED TO ASSERT NOTHING. Its matcher was
  // `.toSatisfy((r) => r === undefined || r instanceof Error || true)` — the
  // trailing `|| true` makes the predicate a tautology, so the case passed
  // whatever happened inside, INCLUDING reader 2 unwrapping reader 1's key
  // exactly. A test of a cross-reader confidentiality boundary that cannot
  // fail is worse than none: it is a green tick standing where the check
  // should be. NIP-44 is authenticated, so the real outcome is a THROW — and
  // that is what is asserted, with a paired control proving the same call
  // succeeds for the reader it was wrapped for (or "it throws" would pass
  // against a wrapper that is simply broken for everyone).
  it("a reader cannot unwrap a key wrapped for somebody else", () => {
    const reader1Privkey = generateSecretKey()
    const reader1Pubkey = getPublicKey(reader1Privkey)
    const reader1PrivkeyHex = Buffer.from(reader1Privkey).toString('hex')

    const reader2Privkey = generateSecretKey()
    const reader2PrivkeyHex = Buffer.from(reader2Privkey).toString('hex')

    const contentKey = generateContentKey()
    const wrappedForReader1 = wrapKeyForReader(contentKey, reader1Pubkey)

    // The control: the intended reader gets the key back byte for byte.
    expect(
      unwrapKeyFromService(wrappedForReader1, reader1PrivkeyHex).equals(contentKey),
    ).toBe(true)

    // The finding: anyone else is refused by the MAC, not merely given garbage.
    expect(() =>
      unwrapKeyFromService(wrappedForReader1, reader2PrivkeyHex),
    ).toThrow()
  })
})

// =============================================================================
// XChaCha20-Poly1305 — THE ALGORITHM `vault.ts` ACTUALLY USES.
//
// The suite above tests `encryptArticleBody`, which is the LEGACY aes-256-gcm
// path, kept only so pieces published before the migration still decrypt.
// Every article published since is `encryptArticleBodyXChaCha`, and it had no
// test at all — so the paywall's live encryption was the one part of this file
// nothing exercised. `algorithm` is stored per row in `vault_keys` and the
// reader branches on it, which is why the cross-algorithm cases below are part
// of the contract rather than curiosities.
// =============================================================================

describe('encryptArticleBodyXChaCha / decryptArticleBodyXChaCha', () => {
  it('round-trips plaintext correctly', () => {
    const key = generateContentKey()
    const body = 'This is the paywalled article body. It contains the good stuff.'
    expect(decryptArticleBodyXChaCha(encryptArticleBodyXChaCha(body, key), key)).toBe(body)
  })

  it('round-trips multi-byte text without mangling it', () => {
    // The two paths differ here: AES goes through Buffer.from(s, 'utf8') and
    // XChaCha through TextEncoder. A body is prose, so this is not exotic.
    const key = generateContentKey()
    const body = '— “quoted” · £8 · naïve · 日本語 · 🔑'
    expect(decryptArticleBodyXChaCha(encryptArticleBodyXChaCha(body, key), key)).toBe(body)
  })

  it('produces a different ciphertext each time (random 24-byte nonce)', () => {
    const key = generateContentKey()
    const c1 = encryptArticleBodyXChaCha('Same plaintext', key)
    const c2 = encryptArticleBodyXChaCha('Same plaintext', key)
    expect(c1).not.toBe(c2)
    // And the difference is in the nonce prefix, not merely somewhere.
    expect(Buffer.from(c1, 'base64').subarray(0, 24)).not.toEqual(
      Buffer.from(c2, 'base64').subarray(0, 24),
    )
  })

  it('fails to decrypt with the wrong key', () => {
    const body = 'Secret article body'
    const ciphertext = encryptArticleBodyXChaCha(body, generateContentKey())
    expect(() => decryptArticleBodyXChaCha(ciphertext, generateContentKey())).toThrow()
  })

  it('rejects tampered ciphertext (Poly1305 tag check)', () => {
    const key = generateContentKey()
    const ciphertext = encryptArticleBodyXChaCha('Authentic article', key)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[30] ^= 0xff // past the 24-byte nonce, inside the ciphertext+tag
    expect(() => decryptArticleBodyXChaCha(buf.toString('base64'), key)).toThrow()
  })

  it('rejects a tampered NONCE as well as a tampered body', () => {
    const key = generateContentKey()
    const ciphertext = encryptArticleBodyXChaCha('Authentic article', key)
    const buf = Buffer.from(ciphertext, 'base64')
    buf[0] ^= 0xff // inside the nonce
    expect(() => decryptArticleBodyXChaCha(buf.toString('base64'), key)).toThrow()
  })

  it('throws on wrong key size, at both ends', () => {
    const shortKey = Buffer.alloc(16)
    expect(() => encryptArticleBodyXChaCha('body', shortKey)).toThrow('Content key must be 32 bytes')
    expect(() => decryptArticleBodyXChaCha('AAAA', shortKey)).toThrow('Content key must be 32 bytes')
  })
})

describe('the two algorithms are not interchangeable', () => {
  // `vault_keys.algorithm` is stored per row and read back by every unlock
  // path, so "which algorithm" is data rather than a constant. These pin that
  // reading a row with the wrong value REFUSES rather than returning plausible
  // rubbish — the failure a paywalled reader must never be handed silently.
  it('an XChaCha ciphertext does not decrypt as AES-GCM', () => {
    const key = generateContentKey()
    const ciphertext = encryptArticleBodyXChaCha('The paid section', key)
    expect(() => decryptArticleBody(ciphertext, key)).toThrow()
  })

  it('an AES-GCM ciphertext does not decrypt as XChaCha', () => {
    const key = generateContentKey()
    const ciphertext = encryptArticleBody('The paid section', key)
    expect(() => decryptArticleBodyXChaCha(ciphertext, key)).toThrow()
  })
})

describe('full vault round-trip (encrypt → store key → decrypt)', () => {
  it('simulates publish-then-read on the CURRENT algorithm', () => {
    // The same walk as the legacy case below, on the path `vault.ts` takes for
    // every article published since the migration.
    const contentKey = generateContentKey()
    const paywallBody = '## The Paywalled Section\n\nThis is what readers pay for.'
    const ciphertext = encryptArticleBodyXChaCha(paywallBody, contentKey)

    const storedKey = encryptContentKey(contentKey)
    const retrievedKey = decryptContentKey(storedKey)

    const readerPrivkey = generateSecretKey()
    const readerPubkey = getPublicKey(readerPrivkey)
    const readerPrivkeyHex = Buffer.from(readerPrivkey).toString('hex')
    const wrappedKey = wrapKeyForReader(retrievedKey, readerPubkey)
    const unwrappedKey = unwrapKeyFromService(wrappedKey, readerPrivkeyHex)

    expect(decryptArticleBodyXChaCha(ciphertext, unwrappedKey)).toBe(paywallBody)
  })

  it('simulates publish-then-read on the LEGACY algorithm', () => {
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
