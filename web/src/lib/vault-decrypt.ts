import { xchacha20poly1305 } from '@noble/ciphers/chacha'

// =============================================================================
// Vault decryption — the ONE home for turning a paywalled body's ciphertext
// into its markdown, with the content key in hand.
//
// It runs in TWO places, and both import it from here:
//
//   1. The full site, in the READER'S BROWSER (`ArticleReader`, via
//      `lib/vault.ts`): the gate pass hands back the ciphertext and a NIP-44
//      wrapped content key, the gateway unwraps the key with the reader's
//      custodial key (`POST /unwrap-key`), and this decrypts locally.
//   2. The plain register, ON THE WEB SERVER (`modernhaus/unlock.ts`), because
//      a page with no JavaScript cannot decrypt anything. The same three steps
//      run inside the unlock's POST handler, and the plaintext goes out in that
//      one response — `no-store`, never cached, never logged (MODERNHAUS-ADR
//      Decision 1, §D1.3). A later visit is a new press, and the re-issue is
//      free.
//
// So the plaintext of a paid piece DOES reach a server of ours on the second
// path. (The platform already holds the ciphertext, the wrapped keys and the
// writer's own draft; the browser path was never a promise that it could not.)
//
// Pure: `@noble/ciphers` is plain JS and `crypto.subtle` is a global in both a
// browser and Node 20, so nothing here reaches `window`, `fetch` or a store.
//
// Supported algorithms:
//   xchacha20poly1305  — current (new articles post spec §III.2)
//   aes-256-gcm        — legacy (articles published before the migration)
// =============================================================================

export type VaultAlgorithm = 'xchacha20poly1305' | 'aes-256-gcm'

/** The algorithm a gate pass named, or the legacy default when it named none
 *  (the full site's fallback, in one place). */
export function vaultAlgorithm(value: unknown): VaultAlgorithm {
  return value === 'xchacha20poly1305' ? 'xchacha20poly1305' : 'aes-256-gcm'
}

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
  algorithm: VaultAlgorithm = 'aes-256-gcm'
): Promise<string> {
  if (algorithm === 'xchacha20poly1305') {
    return decryptVaultContentXChaCha(ciphertextBase64, contentKeyBase64)
  }
  return decryptVaultContentAesGcm(ciphertextBase64, contentKeyBase64)
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
