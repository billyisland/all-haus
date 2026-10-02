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

// The GCM tag is always 16 bytes here. Without `authTagLength` Node accepts a
// 4–16 byte tag on decrypt, so a truncated stored blob would verify against a
// weaker tag than the one written; pinned, a short tag throws (CA-F14c).
const GCM_TAG = { authTagLength: 16 } as const;

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
// signEventsBatch — N events, ONE key decryption (CA-A8, 2026-09-29)
//
// A suspension tombstones every piece a member published, one kind-5 per
// piece, all signed as that member — and the per-signer budget on the single
// route is 120/min, so a member with 121 pieces could not be suspended at all:
// the 121st sign answered 429, the gateway threw, and the route 500'd with the
// status never written. A batch is one request against its own budget, and it
// opens the key once rather than N times. Positional: result[i] signs
// templates[i]. All-or-nothing, because signing is local arithmetic over
// validated input — the only way one item fails is a way every item fails.
// ---------------------------------------------------------------------------

export async function signEventsBatch(
  signerId: string,
  templates: EventTemplate[],
  signerType: "account" | "publication" = "account",
): Promise<Array<ReturnType<typeof finalizeEvent>>> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const privkeyCopy = new Uint8Array(privkeyBytes);
  try {
    // `finalizeEvent` mutates the template it is handed (it stamps `id`,
    // `pubkey`, `sig`); a copy per item keeps the caller's array as it was.
    return templates.map((t) => finalizeEvent({ ...t }, privkeyCopy));
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
  const decipher = createDecipheriv("aes-256-gcm", key, iv, GCM_TAG);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * The platform service PUBLIC key — the only half this service needs (it is
 * the counterparty to a NIP-44 unwrap, never a signer). CA-F14(b): it used to
 * be derived from `PLATFORM_SERVICE_PRIVKEY`, so the service that holds every
 * member's key also held the platform's for no reason. `PLATFORM_SERVICE_PUBKEY`
 * is preferred; the private key is still accepted so a deployment that has
 * only that keeps working, and says so once. A MALFORMED value throws — at
 * boot, via `checkServicePubkeyAtBoot` — rather than deriving a wrong key.
 */
let warnedDerivedPubkey = false;
export function getServicePubkey(): string {
  const pub = process.env.PLATFORM_SERVICE_PUBKEY;
  if (pub) {
    if (!/^[0-9a-f]{64}$/i.test(pub)) {
      throw new Error(
        `PLATFORM_SERVICE_PUBKEY must be 32 bytes as 64 hex characters (got ${pub.length} characters)`,
      );
    }
    return pub.toLowerCase();
  }
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY;
  if (!privkeyHex) throw new Error("PLATFORM_SERVICE_PUBKEY not set");
  if (!/^[0-9a-f]{64}$/i.test(privkeyHex)) {
    throw new Error(
      `PLATFORM_SERVICE_PRIVKEY must be 32 bytes as 64 hex characters (got ${privkeyHex.length} characters)`,
    );
  }
  const derived = getPublicKey(Uint8Array.from(Buffer.from(privkeyHex, "hex")));
  if (!warnedDerivedPubkey) {
    warnedDerivedPubkey = true;
    console.warn(
      `[key-custody] deriving the service pubkey from PLATFORM_SERVICE_PRIVKEY — set PLATFORM_SERVICE_PUBKEY=${derived} and remove the private key from this service`,
    );
  }
  return derived;
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

// Batch variant — decrypts the reader's private key ONCE and opens N messages
// with it. The mirror of nip44EncryptBatch, and it exists for the same reason
// one level up: the export (L7.1) hands a member back every message they have
// ever sent or received, and one HTTP hop per message walks straight into this
// service's own per-signer budget (120/min, `lib/rate-limit.ts`) — so a member
// with two hundred messages would have received an archive whose tail was a
// column of decryption failures, which is worse than no archive at all.
//
// A failure is PER MESSAGE and does not abort the batch: one unreadable
// ciphertext (a legacy row, a counterparty whose key has moved) is a fact about
// that message, and the caller is told which one rather than losing the rest.
// The audit rows are the ROUTE's business, not this function's — the caller
// writes one per message it is about to hand over, exactly as the single
// variant does.
export async function nip44DecryptBatch(
  signerId: string,
  items: { senderPubkeyHex: string; ciphertext: string }[],
  signerType: "account" | "publication" = "account",
): Promise<{ plaintext: string | null }[]> {
  const privkeyBytes = await getDecryptedPrivkey(signerId, signerType);
  const readerPrivkey = new Uint8Array(privkeyBytes);
  try {
    return items.map((item) => {
      try {
        const conversationKey = nip44.getConversationKey(
          readerPrivkey,
          item.senderPubkeyHex,
        );
        return { plaintext: nip44.decrypt(item.ciphertext, conversationKey) };
      } catch {
        return { plaintext: null };
      }
    });
  } finally {
    privkeyBytes.fill(0);
    readerPrivkey.fill(0);
  }
}
