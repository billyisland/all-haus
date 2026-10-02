import {
  BINDING_HEADER,
  keyServiceSubject,
  signInternalRequest,
  type KeyServiceIdentity,
} from "@platform-pub/shared/lib/internal-binding.js";
import { internalSecret } from "@platform-pub/shared/lib/env.js";

// =============================================================================
// Key-service request headers — one home
//
// key-service issues and stores the content keys for every paywalled article:
// it encrypts a body into the vault, hands a paying reader the NIP-44-wrapped
// key for one, returns a writer's own paywalled draft, and exports every vault
// key a writer holds. Until now all of that was granted on `X-Internal-Secret`
// alone — a BEARER, on a plaintext compose network — exactly as key-custody's
// was before S15, and with the same consequence: one captured request yields the
// credential, and with it every other request an attacker cares to compose.
//
// So key-service gets the same per-request binding key-custody got, from the
// same one home (shared/lib/internal-binding.ts). Read that file for what the
// tag closes; two things are specific to this service.
//
// THE SUBJECT IS IN THE HEADERS HERE, NOT THE BODY. key-custody names its signer
// in the body, so hashing the body covers a retarget. key-service takes its
// reader and its writer from `x-reader-id` / `x-reader-pubkey` / `x-writer-id`
// against a body that is often `{}` and sometimes absent entirely — so without
// the identity headers in the tuple, a captured `POST /articles/:id/key` could
// be pointed at a different reader, and a captured `GET /writers/export-keys` at
// a different writer, by editing one header the tag says nothing about. Every
// call below therefore names its identity headers as `subject`, and the receiver
// re-reads them off the request it actually got — through the SAME
// `keyServiceSubject` in `shared`, so the order cannot drift between them.
//
// THE BODY IS STRINGIFIED ONCE. The binding is over raw bytes and a second
// `JSON.stringify` is not guaranteed to reproduce the first, so every caller
// hands us the exact string it is going to send and we hash that.
//
// `GET /api/v1/auth-check` is deliberately NOT bound and keeps the bare secret:
// it is the boot-time parity probe (lib/internal-parity.ts) that runs against
// all three peers, reaching it IS the proof, and a 401 there exits the gateway.
// =============================================================================

export interface KeyServiceRequest {
  method: string;
  /** The path as key-service will see it, `/api/v1` prefix included. */
  path: string;
  /** The exact bytes that will be sent; the empty string for a bodyless call. */
  rawBody?: string;
  identity: KeyServiceIdentity;
  /** Set when a body is being sent, so the caller need not repeat itself. */
  json?: boolean;
}

/** Build the full header set for one key-service call, binding included. */
export function keyServiceHeaders(req: KeyServiceRequest): Record<string, string> {
  const secret = internalSecret();
  const rawBody = req.rawBody ?? "";
  const headers: Record<string, string> = {
    "x-internal-secret": secret,
    [BINDING_HEADER]: signInternalRequest(secret, {
      method: req.method,
      path: req.path,
      rawBody,
      subject: keyServiceSubject(req.identity),
    }),
  };
  if (req.json) headers["Content-Type"] = "application/json";
  if (req.identity.readerId) headers["x-reader-id"] = req.identity.readerId;
  if (req.identity.readerPubkey)
    headers["x-reader-pubkey"] = req.identity.readerPubkey;
  if (req.identity.writerId) headers["x-writer-id"] = req.identity.writerId;
  if (req.identity.writerPubkey)
    headers["x-writer-pubkey"] = req.identity.writerPubkey;
  return headers;
}
