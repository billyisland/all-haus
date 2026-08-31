import { xchacha20poly1305 } from '@noble/ciphers/chacha'

// =============================================================================
// Vault Decryption (Client-Side)
//
// After the key service issues a NIP-44 wrapped content key, the client
// decrypts the article's encrypted body. The flow:
//
//   1. Key service returns encryptedKey (NIP-44 wrapped content key) + algorithm
//   2. Client asks the gateway's signing service to unwrap the NIP-44 payload
//      (the reader's private key is custodial — held server-side)
//   3. Client receives the raw content key (base64)
//   4. Client extracts the ciphertext:
//        NEW format — ciphertext is in the NIP-23 event's ['payload', ...] tag
//        OLD format — ciphertext is fetched from a separate kind 39701 vault event
//   5. Client decrypts ciphertext locally using the correct algorithm
//   6. Decrypted markdown is rendered in the article view
//
// Supported algorithms:
//   xchacha20poly1305  — current (new articles post spec §III.2)
//   aes-256-gcm        — legacy (articles published before the migration)
//
// Step 5 runs entirely in the browser — the plaintext article body never
// touches the server after decryption.
// =============================================================================

// Use relative URLs so requests go through the Next.js rewrite (same origin).
// Using NEXT_PUBLIC_GATEWAY_URL here would make a cross-origin request that
// fails in production and hits CORS/cookie issues in dev.
const API_BASE = '/api/v1'

// =============================================================================
// Decryption — XChaCha20-Poly1305 (current algorithm)
// Format: base64(nonce[24] + ciphertext_with_tag)
// =============================================================================

export async function decryptVaultContentXChaCha(
  ciphertextBase64: string,
  contentKeyBase64: string
): Promise<string> {
  const combined = base64ToUint8Array(ciphertextBase64)
  const nonce = combined.slice(0, 24)
  const ciphertextWithTag = combined.slice(24)

  const key = base64ToUint8Array(contentKeyBase64)

  const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertextWithTag)
  return new TextDecoder().decode(plaintext)
}

// =============================================================================
// Decryption — AES-256-GCM (legacy algorithm)
// Format: base64(iv[12] + authTag[16] + ciphertext)
// =============================================================================

export async function decryptVaultContentAesGcm(
  ciphertextBase64: string,
  contentKeyBase64: string
): Promise<string> {
  const keyBytes = base64ToArrayBuffer(contentKeyBase64)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  const combined = base64ToArrayBuffer(ciphertextBase64)
  const iv = combined.slice(0, 12)
  const authTag = combined.slice(12, 28)
  const encrypted = combined.slice(28)

  // Web Crypto API expects authTag appended to ciphertext
  const ciphertextWithTag = new Uint8Array(encrypted.byteLength + authTag.byteLength)
  ciphertextWithTag.set(new Uint8Array(encrypted), 0)
  ciphertextWithTag.set(new Uint8Array(authTag), encrypted.byteLength)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    cryptoKey,
    ciphertextWithTag
  )

  return new TextDecoder().decode(decrypted)
}

// =============================================================================
// decryptVaultContent — dispatches on algorithm
// =============================================================================

export async function decryptVaultContent(
  ciphertextBase64: string,
  contentKeyBase64: string,
  algorithm: 'xchacha20poly1305' | 'aes-256-gcm' = 'aes-256-gcm'
): Promise<string> {
  if (algorithm === 'xchacha20poly1305') {
    return decryptVaultContentXChaCha(ciphertextBase64, contentKeyBase64)
  }
  return decryptVaultContentAesGcm(ciphertextBase64, contentKeyBase64)
}

// =============================================================================
// unwrapContentKey — asks the signing service to unwrap a NIP-44 key
// =============================================================================

export async function unwrapContentKey(
  encryptedKey: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/unwrap-key`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedKey }),
  })

  if (!res.ok) {
    throw new Error(`Key unwrapping failed: ${res.status}`)
  }

  const { contentKeyBase64 } = await res.json()
  return contentKeyBase64
}

// =============================================================================
// Helpers
// =============================================================================

export function base64ToUint8Array(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer
}
