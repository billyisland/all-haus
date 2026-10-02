import { decryptVaultContent, vaultAlgorithm } from '../lib/vault-decrypt'
import { renderMarkdown } from '../lib/markdown'
import { PAYWALL_NO_CIPHERTEXT, PAYWALL_AFTER_PAYMENT } from '../content/paywall'
import { call, GatewayFault, type GatewayContext } from './gateway'
import { stripOrnament } from './html-pass'

// =============================================================================
// modernhaus — the paid half, delivered on the SERVER (MODERNHAUS-ADR
// Decision 1, §D1.3).
//
// A page with no script cannot decrypt, so the web server runs the three steps
// the full site's browser runs: the gate pass has already answered (the caller
// made it — a press, or the arrival landing), then `POST /unwrap-key` unwraps
// the content key with the reader's custodial key, then `lib/vault-decrypt.ts`
// (the ONE decrypt, which the browser imports too) opens the body, and
// `renderMarkdown` renders it.
//
// THE PLAINTEXT GOES OUT IN ONE RESPONSE AND NOWHERE ELSE. It is never cached
// (every modernhaus response is `private, no-store`), never logged — the catch
// below logs the failure's kind and nothing of the body or the key — and never
// put in a URL. A later visit is a new press; the re-issue is free.
//
// Every failure here comes AFTER the gate pass recorded the read, so the
// sentence is the full site's post-payment one: try again, you will not be
// charged twice.
// =============================================================================

/** The part of the gate pass's success body the delivery reads. */
export interface GatePassBody {
  encryptedKey?: unknown
  algorithm?: unknown
  ciphertext?: unknown
  allowanceJustExhausted?: unknown
}

export type Delivered =
  | { kind: 'open'; html: string }
  /** The read is recorded; its body could not be handed over. Retrying is free. */
  | { kind: 'undelivered'; sentence: string }

export async function deliverPaidHalf(gw: GatewayContext, pass: GatePassBody): Promise<Delivered> {
  if (typeof pass.ciphertext !== 'string' || pass.ciphertext === '') {
    return { kind: 'undelivered', sentence: PAYWALL_NO_CIPHERTEXT }
  }
  if (typeof pass.encryptedKey !== 'string' || pass.encryptedKey === '') {
    return { kind: 'undelivered', sentence: PAYWALL_AFTER_PAYMENT }
  }
  try {
    const key = await call<{ contentKeyBase64?: unknown }>(gw, 'POST', '/unwrap-key', {
      json: { encryptedKey: pass.encryptedKey },
    })
    if (key.status !== 200 || typeof key.body?.contentKeyBase64 !== 'string') {
      console.error('[modernhaus] unwrap refused after gate pass', key.status)
      return { kind: 'undelivered', sentence: PAYWALL_AFTER_PAYMENT }
    }
    const markdown = await decryptVaultContent(pass.ciphertext, key.body.contentKeyBase64, vaultAlgorithm(pass.algorithm))
    return { kind: 'open', html: stripOrnament(await renderMarkdown(markdown)) }
  } catch (err) {
    // The KIND of failure only: an error from the cipher or the renderer can
    // carry a fragment of what it was handed.
    console.error(
      '[modernhaus] paid half not delivered after gate pass',
      err instanceof GatewayFault ? err.message : err instanceof Error ? err.name : 'unknown',
    )
    return { kind: 'undelivered', sentence: PAYWALL_AFTER_PAYMENT }
  }
}
