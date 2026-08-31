import type { EventTemplate } from 'nostr-tools'

// =============================================================================
// Key Custody Client
//
// Internal HTTP client for the key-custody service. All private-key operations
// (keypair generation, event signing, NIP-44 unwrapping) are delegated here.
// =============================================================================

function baseUrl(): string {
  const url = process.env.KEY_CUSTODY_URL
  if (!url) throw new Error('KEY_CUSTODY_URL not set')
  return url
}

function secret(): string {
  const s = process.env.INTERNAL_SECRET
  if (!s) throw new Error('INTERNAL_SECRET not set')
  return s
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Internal-Secret': secret(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw Object.assign(new Error(`key-custody ${path} failed: ${res.status}`), { upstream: err })
  }

  return res.json() as Promise<T>
}

export async function generateKeypair(): Promise<{ pubkeyHex: string; privkeyEncrypted: string }> {
  return post('/api/v1/keypairs/generate')
}

export async function signEvent(
  signerId: string,
  eventTemplate: EventTemplate,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ id: string; pubkey: string; sig: string; kind: number; content: string; tags: string[][]; created_at: number }> {
  return post('/api/v1/keypairs/sign', { signerId, signerType, event: eventTemplate })
}

export async function unwrapKey(
  signerId: string,
  encryptedKey: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ contentKeyBase64: string }> {
  return post('/api/v1/keypairs/unwrap', { signerId, signerType, encryptedKey })
}

// Export the owner's decrypted Nostr secret key (hex + nsec) for migration.
// The caller MUST have already authorised the requester as the owner of
// signerId — key-custody trusts the internal secret and does not re-check.
export async function exportSecretKey(
  signerId: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ privkeyHex: string; nsec: string }> {
  return post('/api/v1/keypairs/export', { signerId, signerType })
}

// Batch variant — encrypts the same plaintext for N recipients in one HTTP
// hop, used by the DM send path. The order of returned ciphertexts mirrors
// the order of `recipientPubkeys`.
export async function nip44EncryptBatch(
  signerId: string,
  recipientPubkeys: string[],
  plaintext: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ ciphertexts: string[] }> {
  return post('/api/v1/keypairs/nip44-encrypt-batch', { signerId, signerType, recipientPubkeys, plaintext })
}

export async function nip44Decrypt(
  signerId: string,
  senderPubkey: string,
  ciphertext: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ plaintext: string }> {
  return post('/api/v1/keypairs/nip44-decrypt', { signerId, signerType, senderPubkey, ciphertext })
}
