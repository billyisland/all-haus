// =============================================================================
// Key Service Types
// =============================================================================

export interface VaultEncryptResult {
  ciphertext: string; // base64-encoded encrypted body
  algorithm: "xchacha20poly1305" | "aes-256-gcm";
  vaultKeyId: string; // UUID of the vault_keys row
}

export interface KeyResponse {
  encryptedKey: string; // NIP-44 wrapped content key
  articleNostrEventId: string;
  algorithm: "xchacha20poly1305" | "aes-256-gcm";
  isReissuance: boolean;
  ciphertext?: string; // base64-encoded encrypted body (from vault_keys)
}

export interface PaymentVerification {
  isVerified: boolean;
  readEventId: string | null;
  state: "accrued" | "platform_settled" | "writer_paid" | null;
  readEventExists: boolean;
}
