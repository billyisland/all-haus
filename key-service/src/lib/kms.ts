import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

// =============================================================================
// KMS (Key Management Service) wrapper
//
// In production this wraps an external KMS (AWS KMS, GCP KMS, or HashiCorp
// Vault). For local dev it uses a master key from env.
//
// The content key (32 random bytes) is never stored in plaintext.
// It is envelope-encrypted: the content key is encrypted with the KMS master
// key before being written to vault_keys.content_key_enc.
//
// Envelope encryption means:
//   - DB compromise alone does not expose content keys
//   - Master key rotation only requires re-encrypting vault_keys rows, not
//     re-encrypting all article ciphertext
// =============================================================================

// AES-256-GCM envelope encryption of a content key
// Output format: base64(iv[12] + authTag[16] + ciphertext[32])
export function encryptContentKey(contentKeyBytes: Buffer): string {
  const masterKey = getMasterKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv)

  const encrypted = Buffer.concat([cipher.update(contentKeyBytes), cipher.final()])
  const authTag = cipher.getAuthTag()

  const combined = Buffer.concat([iv, authTag, encrypted])
  return combined.toString('base64')
}

export function decryptContentKey(encryptedBase64: string): Buffer {
  const masterKey = getMasterKey()
  const combined = Buffer.from(encryptedBase64, 'base64')

  const iv = combined.subarray(0, 12)
  const authTag = combined.subarray(12, 28)
  const ciphertext = combined.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function getMasterKey(): Buffer {
  const keyHex = process.env.KMS_MASTER_KEY_HEX
  if (!keyHex) throw new Error('KMS_MASTER_KEY_HEX not set')
  const key = Buffer.from(keyHex, 'hex')
  if (key.length !== 32) throw new Error('KMS_MASTER_KEY_HEX must be 32 bytes (64 hex chars)')
  return key
}

// ---------------------------------------------------------------------------
// Generate a fresh random content key — called once per published article
// ---------------------------------------------------------------------------

export function generateContentKey(): Buffer {
  return randomBytes(32)  // 256 bits — AES-256-GCM key
}
