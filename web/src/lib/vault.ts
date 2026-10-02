// =============================================================================
// Vault — the browser's half of reading a paywalled body.
//
// The decryption itself lives in `lib/vault-decrypt.ts`, which both registers
// import: the full site runs it here in the reader's browser, the plain
// register (`/modernhaus`) on the web server. That file's header states both
// paths. What stays here is the browser's own call to the gateway.
// =============================================================================

export {
  decryptVaultContent,
  decryptVaultContentXChaCha,
  decryptVaultContentAesGcm,
  base64ToUint8Array,
  vaultAlgorithm,
  type VaultAlgorithm,
} from './vault-decrypt'

import { request } from './api/client'

// =============================================================================
// unwrapContentKey — asks the signing service to unwrap a NIP-44 key
// =============================================================================

export async function unwrapContentKey(
  encryptedKey: string
): Promise<string> {
  const { contentKeyBase64 } = await request<{ contentKeyBase64: string }>('/unwrap-key', {
    method: 'POST',
    body: JSON.stringify({ encryptedKey }),
  })
  return contentKeyBase64
}
