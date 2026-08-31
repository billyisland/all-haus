import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

// =============================================================================
// Article Encryption
//
// Two algorithms are supported:
//
//   aes-256-gcm       — legacy format used by articles published before the
//                       XChaCha20 migration. Kept for backward-compatible
//                       decryption. Not used for new articles.
//
//   xchacha20poly1305 — current format per spec §III.2. Consistent with the
//                       ChaCha20 family used in NIP-44 key wrapping.
//                       Extended 192-bit nonce (vs 96-bit in NIP-44's ChaCha)
//                       eliminates nonce-reuse risk for large key spaces.
//
// New articles use XChaCha20-Poly1305 exclusively.
//
// Ciphertext is stored in the kind 30023 event as a ['payload', base64, algo]
// tag (new format) rather than a separate kind 39701 vault event.
//
// Ciphertext formats:
//   aes-256-gcm:       base64(iv[12] + authTag[16] + ciphertext)
//   xchacha20poly1305: base64(nonce[24] + ciphertext_with_tag)
// =============================================================================

// =============================================================================
// XChaCha20-Poly1305 — current algorithm
// =============================================================================

export function encryptArticleBodyXChaCha(
  plaintextBody: string,
  contentKeyBytes: Buffer,
): string {
  if (contentKeyBytes.length !== 32) {
    throw new Error("Content key must be 32 bytes");
  }

  const nonce = randomBytes(24);
  const key = new Uint8Array(contentKeyBytes);
  const plaintext = new TextEncoder().encode(plaintextBody);

  const ciphertextWithTag = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const combined = Buffer.concat([nonce, Buffer.from(ciphertextWithTag)]);
  return combined.toString("base64");
}

// =============================================================================
// AES-256-GCM — legacy (kept for backward-compatible decryption only)
// =============================================================================

export function encryptArticleBody(
  plaintextBody: string,
  contentKeyBytes: Buffer,
): string {
  if (contentKeyBytes.length !== 32) {
    throw new Error("Content key must be 32 bytes");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKeyBytes, iv);

  const bodyBuffer = Buffer.from(plaintextBody, "utf8");
  const encrypted = Buffer.concat([cipher.update(bodyBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

export function decryptArticleBody(
  ciphertextBase64: string,
  contentKeyBytes: Buffer,
): string {
  const combined = Buffer.from(ciphertextBase64, "base64");

  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(12, 28);
  const ciphertext = combined.subarray(28);

  const decipher = createDecipheriv("aes-256-gcm", contentKeyBytes, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function decryptArticleBodyXChaCha(
  ciphertextBase64: string,
  contentKeyBytes: Buffer,
): string {
  if (contentKeyBytes.length !== 32) {
    throw new Error("Content key must be 32 bytes");
  }

  const combined = Buffer.from(ciphertextBase64, "base64");
  const nonce = new Uint8Array(combined.subarray(0, 24));
  const ciphertextWithTag = new Uint8Array(combined.subarray(24));
  const key = new Uint8Array(contentKeyBytes);

  const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertextWithTag);
  return new TextDecoder().decode(plaintext);
}
