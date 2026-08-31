import { describe, it, expect } from 'vitest'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import {
  decryptVaultContentXChaCha,
  base64ToUint8Array,
} from '../src/lib/vault'

// Helper: encrypt with XChaCha20-Poly1305 in the same format the server produces
function encryptXChaCha(plaintext: string, keyBytes: Uint8Array): string {
  const nonce = randomBytes(24)
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertextWithTag = xchacha20poly1305(keyBytes, nonce).encrypt(encoded)

  // Format: base64(nonce[24] + ciphertext_with_tag)
  const combined = new Uint8Array(24 + ciphertextWithTag.length)
  combined.set(nonce, 0)
  combined.set(ciphertextWithTag, 24)

  return Buffer.from(combined).toString('base64')
}

describe('decryptVaultContentXChaCha', () => {
  it('round-trips plaintext correctly', async () => {
    const key = randomBytes(32)
    const keyBase64 = Buffer.from(key).toString('base64')
    const plaintext = 'This is the paywalled article body.'

    const ciphertext = encryptXChaCha(plaintext, key)
    const result = await decryptVaultContentXChaCha(ciphertext, keyBase64)
    expect(result).toBe(plaintext)
  })

  it('handles unicode content', async () => {
    const key = randomBytes(32)
    const keyBase64 = Buffer.from(key).toString('base64')
    const plaintext = '日本語テキスト — emojis 🎉 and special chars £€¥'

    const ciphertext = encryptXChaCha(plaintext, key)
    const result = await decryptVaultContentXChaCha(ciphertext, keyBase64)
    expect(result).toBe(plaintext)
  })

  it('fails with wrong key', async () => {
    const key1 = randomBytes(32)
    const key2 = randomBytes(32)
    const plaintext = 'Secret content'

    const ciphertext = encryptXChaCha(plaintext, key1)
    const wrongKeyBase64 = Buffer.from(key2).toString('base64')

    await expect(
      decryptVaultContentXChaCha(ciphertext, wrongKeyBase64)
    ).rejects.toThrow()
  })

  it('fails with tampered ciphertext', async () => {
    const key = randomBytes(32)
    const keyBase64 = Buffer.from(key).toString('base64')
    const plaintext = 'Authentic content'

    const ciphertext = encryptXChaCha(plaintext, key)
    const bytes = Buffer.from(ciphertext, 'base64')
    bytes[30] ^= 0xff // Flip a byte in the ciphertext
    const tampered = bytes.toString('base64')

    await expect(
      decryptVaultContentXChaCha(tampered, keyBase64)
    ).rejects.toThrow()
  })
})

describe('base64ToUint8Array', () => {
  it('decodes standard base64', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5])
    const b64 = Buffer.from(original).toString('base64')
    const result = base64ToUint8Array(b64)
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5])
  })

  it('decodes URL-safe base64 (- and _ chars)', () => {
    // URL-safe base64 uses - instead of + and _ instead of /
    const original = new Uint8Array([251, 239, 190]) // produces +/chars in standard base64
    const standard = Buffer.from(original).toString('base64')
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    const result = base64ToUint8Array(urlSafe)
    expect(Array.from(result)).toEqual([251, 239, 190])
  })

  it('handles unpadded base64', () => {
    const original = new Uint8Array([1, 2])
    const b64 = Buffer.from(original).toString('base64').replace(/=/g, '')
    const result = base64ToUint8Array(b64)
    expect(Array.from(result)).toEqual([1, 2])
  })
})
