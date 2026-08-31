import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
  nip44,
  type EventTemplate,
} from "nostr-tools";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { pool } from "@platform-pub/shared/db/client.js";

// =============================================================================
// Custodial keypair crypto
//
// ACCOUNT_KEY_HEX is the master key that encrypts all user Nostr private keys
// at rest. It lives only in this service — the gateway and other services
// never see it.
//
// Format: base64(iv[12] + authTag[16] + ciphertext[32])
// =============================================================================

interface GeneratedKeypair {
  pubkeyHex: string;
  privkeyEncrypted: string;
}

// ---------------------------------------------------------------------------
// generateKeypair — called once per account at signup
// ---------------------------------------------------------------------------

export function generateKeypair(): GeneratedKeypair {
  const privkey = generateSecretKey();
  const pubkey = getPublicKey(privkey);
  const privkeyEncrypted = encryptPrivkey(Buffer.from(privkey));
  return { pubkeyHex: pubkey, privkeyEncrypted };
}

// ---------------------------------------------------------------------------
// signEvent — sign a Nostr event on behalf of an account
// ---------------------------------------------------------------------------

export async function signEvent(
  signerId: string,
  eventTemplate: EventTemplate,
  signerType: "account" | "publication" = "account",
): Promise<ReturnType<typeof finalizeEvent>> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const privkeyCopy = new Uint8Array(privkeyBytes);
  try {
    return finalizeEvent(eventTemplate, privkeyCopy);
  } finally {
    privkeyBytes.fill(0);
    privkeyCopy.fill(0);
  }
}

// ---------------------------------------------------------------------------
// unwrapKey — decrypt a NIP-44 payload using the account's private key
//
// The key-service wraps content keys with NIP-44 using the platform service
// keypair as sender and the reader's pubkey as recipient. This reverses that.
// ---------------------------------------------------------------------------

export async function unwrapKey(
  signerId: string,
  encryptedKey: string,
  signerType: "account" | "publication" = "account",
): Promise<string> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const readerPrivkey = new Uint8Array(privkeyBytes);
  try {
    const servicePubkey = getServicePubkey();
    const conversationKey = nip44.getConversationKey(
      readerPrivkey,
      servicePubkey,
    );
    return nip44.decrypt(encryptedKey, conversationKey);
  } finally {
    privkeyBytes.fill(0);
    readerPrivkey.fill(0);
  }
}

// ---------------------------------------------------------------------------
// exportSecretKey — return the owner's decrypted Nostr private key
//
// Backs the "export-mandatory" invariant (NETWORK-CONCIERGE-ADR §4 #4): every
// custodial identity must be exportable so the user can migrate off-platform.
// The gateway calls this only for the authenticated owner of `signerId`; the
// raw key is never logged. Returns both hex and bech32 nsec forms.
// ---------------------------------------------------------------------------

export async function exportSecretKey(
  signerId: string,
  signerType: "account" | "publication" = "account",
): Promise<{ privkeyHex: string; nsec: string }> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const privkeyCopy = new Uint8Array(privkeyBytes);
  try {
    return {
      privkeyHex: Buffer.from(privkeyCopy).toString("hex"),
      nsec: nip19.nsecEncode(privkeyCopy),
    };
  } finally {
    privkeyBytes.fill(0);
    privkeyCopy.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getDecryptedPrivkey(
  signerId: string,
  signerType: "account" | "publication" = "account",
): Promise<Buffer> {
  const table = signerType === "publication" ? "publications" : "accounts";
  const { rows } = await pool.query<{ nostr_privkey_enc: string | null }>(
    `SELECT nostr_privkey_enc FROM ${table} WHERE id = $1`,
    [signerId],
  );
  if (rows.length === 0)
    throw new Error(`${signerType} not found: ${signerId}`);
  const enc = rows[0].nostr_privkey_enc;
  if (!enc)
    throw new Error(`${signerType} ${signerId} has no custodial keypair`);
  return decryptPrivkey(enc);
}

function getAccountKey(): Buffer {
  const keyHex = process.env.ACCOUNT_KEY_HEX;
  if (!keyHex) throw new Error("ACCOUNT_KEY_HEX not set");
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32)
    throw new Error("ACCOUNT_KEY_HEX must be 32 bytes (64 hex chars)");
  return key;
}

function encryptPrivkey(privkeyBytes: Buffer): string {
  const key = getAccountKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privkeyBytes),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptPrivkey(encryptedBase64: string): Buffer {
  const key = getAccountKey();
  const combined = Buffer.from(encryptedBase64, "base64");
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function getServicePubkey(): string {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY;
  if (!privkeyHex) throw new Error("PLATFORM_SERVICE_PRIVKEY not set");
  return getPublicKey(Uint8Array.from(Buffer.from(privkeyHex, "hex")));
}

// ---------------------------------------------------------------------------
// NIP-44 encrypt/decrypt — general-purpose, for DM E2E encryption
//
// Unlike unwrapKey (which hardcodes the platform service pubkey as the
// counterparty), these accept an arbitrary counterparty pubkey.
// ---------------------------------------------------------------------------

export async function nip44Encrypt(
  signerId: string,
  recipientPubkeyHex: string,
  plaintext: string,
  signerType: "account" | "publication" = "account",
): Promise<string> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const senderPrivkey = new Uint8Array(privkeyBytes);
  try {
    const conversationKey = nip44.getConversationKey(
      senderPrivkey,
      recipientPubkeyHex,
    );
    return nip44.encrypt(plaintext, conversationKey);
  } finally {
    privkeyBytes.fill(0);
    senderPrivkey.fill(0);
  }
}

// Batch variant — decrypts the sender's private key once and encrypts the
// same plaintext for N recipients. Used by the DM send hot path where N=1
// is the common case but groups can be 10+; the per-recipient round-trip is
// the dominant cost at the cluster level.
export async function nip44EncryptBatch(
  signerId: string,
  recipientPubkeysHex: string[],
  plaintext: string,
  signerType: "account" | "publication" = "account",
): Promise<string[]> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const senderPrivkey = new Uint8Array(privkeyBytes);
  try {
    return recipientPubkeysHex.map((pubkey) => {
      const conversationKey = nip44.getConversationKey(senderPrivkey, pubkey);
      return nip44.encrypt(plaintext, conversationKey);
    });
  } finally {
    privkeyBytes.fill(0);
    senderPrivkey.fill(0);
  }
}

export async function nip44Decrypt(
  signerId: string,
  senderPubkeyHex: string,
  ciphertext: string,
  signerType: "account" | "publication" = "account",
): Promise<string> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const readerPrivkey = new Uint8Array(privkeyBytes);
  try {
    const conversationKey = nip44.getConversationKey(
      readerPrivkey,
      senderPubkeyHex,
    );
    return nip44.decrypt(ciphertext, conversationKey);
  } finally {
    privkeyBytes.fill(0);
    readerPrivkey.fill(0);
  }
}
