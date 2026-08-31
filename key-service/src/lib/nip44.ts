import { nip44, getPublicKey } from 'nostr-tools'

// =============================================================================
// NIP-44 Key Wrapping
//
// Before the content key is sent to the reader, it is encrypted with NIP-44
// using the platform's service keypair (sender) and the reader's public key
// (recipient). Only the reader's private key can decrypt it.
//
// This is per ADR §II.4a:
//   "Key service issues the content key encrypted to the reader's public key
//    using NIP-44."
//
// The reader's custodially-managed keypair is held by the platform's signing
// service. The signing service decrypts the NIP-44 payload on the reader's
// behalf — readers never interact with cryptography directly.
// =============================================================================

function getServiceKeypair(): { privkey: Uint8Array; pubkey: string } {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  const pubkey = getPublicKey(privkey)
  return { privkey, pubkey }
}

// Encrypt a content key (32 bytes) to a reader's pubkey using NIP-44
// Returns base64-encoded NIP-44 ciphertext
export function wrapKeyForReader(
  contentKeyBytes: Buffer,
  readerPubkeyHex: string
): string {
  const { privkey } = getServiceKeypair()

  // NIP-44 conversation key derivation
  const conversationKey = nip44.getConversationKey(privkey, readerPubkeyHex)

  // Encrypt — NIP-44 expects a string payload
  const contentKeyBase64 = contentKeyBytes.toString('base64')
  const encrypted = nip44.encrypt(contentKeyBase64, conversationKey)

  return encrypted
}

// Decrypt a NIP-44 wrapped key — used in tests and by the signing service
export function unwrapKeyFromService(
  encryptedPayload: string,
  readerPrivkeyHex: string
): Buffer {
  const serviceKeypair = getServiceKeypair()
  const readerPrivkey = Uint8Array.from(Buffer.from(readerPrivkeyHex, 'hex'))

  // Conversation key is symmetric — same from either side
  const conversationKey = nip44.getConversationKey(readerPrivkey, serviceKeypair.pubkey)
  const contentKeyBase64 = nip44.decrypt(encryptedPayload, conversationKey)

  return Buffer.from(contentKeyBase64, 'base64')
}
