import type { EventTemplate } from 'nostr-tools'
import {
  BINDING_HEADER,
  SIGNER_HEADER,
  signInternalRequest,
} from '@platform-pub/shared/lib/internal-binding.js'

// =============================================================================
// Key Custody Client
//
// Internal HTTP client for the key-custody service. All private-key operations
// (keypair generation, event signing, NIP-44 unwrapping) are delegated here.
//
// Every call carries a per-request binding alongside the bearer secret — see
// shared/lib/internal-binding.ts for what it closes. Two things matter here.
// The body is stringified ONCE and both hashed and sent, because the binding is
// over raw bytes and a second `JSON.stringify` is not guaranteed to reproduce
// the first. And the signer id is lifted out of the body onto its own header
// purely so key-custody's limiter — which runs on `onRequest`, before any body —
// has a bucket key; nothing AUTHORISES on that header, and the guard reads the
// signer off the body it verified.
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
  const rawBody = body !== undefined ? JSON.stringify(body) : ''
  const signerId =
    body !== null && typeof body === 'object'
      ? ((body as { signerId?: string; accountId?: string }).signerId ??
         (body as { signerId?: string; accountId?: string }).accountId)
      : undefined
  const s = secret()

  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Internal-Secret': s,
      [BINDING_HEADER]: signInternalRequest(s, { method: 'POST', path, rawBody }),
      ...(signerId ? { [SIGNER_HEADER]: signerId } : {}),
    },
    body: body !== undefined ? rawBody : undefined,
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

export type SignedEventJson = Awaited<ReturnType<typeof signEvent>>

/** key-custody's `sign-batch` cap (its zod `max(500)`); larger lists go over
 *  in chunks of this size, each chunk one call against the batch budget. */
export const SIGN_BATCH_MAX = 500

// N templates, ONE signer, one hop per 500 (CA-A8). The suspension and
// account-deletion paths tombstone every piece a member published, signed as
// that member, and at a `/sign` per piece they walked into key-custody's
// 120/min per-signer budget on the 121st piece: the throw below fired, the
// route 500'd, and the member with the most to remove was the one who could
// not be suspended. The batch route has its own budget (20 calls/min). The
// result is positional — `signed[i]` is `templates[i]` — and a chunk that
// fails throws for the whole call: signing is all-or-nothing on the far side,
// and a caller that wants a counted shortfall counts at ITS grain.
export async function signEvents(
  signerId: string,
  templates: EventTemplate[],
  signerType: 'account' | 'publication' = 'account'
): Promise<SignedEventJson[]> {
  const out: SignedEventJson[] = []
  for (let i = 0; i < templates.length; i += SIGN_BATCH_MAX) {
    const chunk = templates.slice(i, i + SIGN_BATCH_MAX)
    const { signed } = await post<{ signed: SignedEventJson[] }>(
      '/api/v1/keypairs/sign-batch',
      { signerId, signerType, events: chunk },
    )
    if (signed.length !== chunk.length) {
      throw new Error(
        `key-custody sign-batch returned ${signed.length} events for ${chunk.length} templates`,
      )
    }
    out.push(...signed)
  }
  return out
}

// `actorAccountId` is who ASKED, as against `signerId`, whose key is used
// (L6.6). It is a REQUIRED argument on the two calls that open something
// already written, so a caller cannot leave the audit row unattributed by
// omission — `key_access_log` exists to answer "who opened this", and a
// default would answer "somebody".
export async function unwrapKey(
  signerId: string,
  encryptedKey: string,
  actorAccountId: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ contentKeyBase64: string }> {
  return post('/api/v1/keypairs/unwrap', { signerId, signerType, actorAccountId, encryptedKey })
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

// Batch variant — N ciphertexts, one key decryption, one hop. The export
// (L7.1) opens a member's whole message history in one go, and at a hop per
// message that walks into key-custody's per-signer budget partway through, so
// the tail of the archive would arrive as decryption failures.
//
// The result is positional and each entry may be null: a ciphertext that will
// not open is a fact about that message (a legacy row, a counterparty whose key
// has moved), not about the batch. `actorAccountId` — see `unwrapKey` (L6.6);
// the audit rows are written one per PLAINTEXT on the far side.
export async function nip44DecryptBatch(
  signerId: string,
  items: { senderPubkey: string; ciphertext: string }[],
  actorAccountId: string,
  signerType: 'account' | 'publication' = 'account'
): Promise<{ results: { plaintext: string | null }[] }> {
  return post('/api/v1/keypairs/nip44-decrypt-batch', { signerId, signerType, actorAccountId, items })
}
