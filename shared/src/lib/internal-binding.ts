import { createHash, createHmac, timingSafeEqual } from "crypto";

// =============================================================================
// Per-request binding for the internal secret (MIRROR-AUDIT §3 *Security*, S15)
//
// `X-Internal-Secret` is a BEARER credential: it says only "somebody holds the
// secret". key-custody signs any kind for any account and exports any account's
// nsec, and it granted all of that on the bearer alone — so one captured request
// off the (plaintext, un-TLS'd) compose network yielded the secret itself, and
// with it every other request an attacker cared to compose. Retargeting
// `/keypairs/export` from the account that was captured to any other account was
// a field edit.
//
// This binds a request to ITSELF. The gateway HMACs the tuple that identifies
// what it is asking for — version, timestamp, method, path, signer, body hash —
// and sends the tag rather than (only) the secret. Four things follow, and each
// is one of the holes above:
//
//   * The secret never crosses the wire in a form a capture can reuse. An
//     HMAC tag is not the key, so capturing a request no longer lets you forge
//     a DIFFERENT one.
//   * The PATH is inside the tag, so a captured `/keypairs/sign` cannot be
//     escalated into a `/keypairs/export`.
//   * The BODY HASH is inside the tag, so an in-flight edit invalidates it —
//     which is also what stops a captured export being RETARGETED, since the
//     signer is a field of the body. An earlier draft named the signer in the
//     tuple as well; no mutation could distinguish it (drop it and both suites
//     stay green, because changing the signer necessarily changes the hash), so
//     it went, rather than stand as a term whose comment claimed a job it did
//     not have. If a future route ever takes its subject somewhere other than
//     the body, put that somewhere in the tuple.
//   * The TIMESTAMP is inside the tag — restating it in the header without
//     re-minting the tag fails as a mismatch — so replay of the request AS SENT
//     is bounded to `BINDING_MAX_SKEW_MS`.
//
// It is the same secret on both sides, so this is not defence against a leaked
// env file; it is defence against everything short of one, which is what a
// bearer header had none of.
//
// THE BODY HASH IS OVER RAW BYTES, never over a re-serialisation. `JSON.parse`
// → `JSON.stringify` is not the identity function (number formatting, escape
// forms), so a receiver that re-stringifies would reject perfectly good requests
// at a rate nobody could reproduce. key-custody keeps the raw string off its
// content-type parser and hashes that; the gateway hashes the exact string it
// sends. One home for the tuple, here, because two spellings of it would
// disagree silently and the symptom would be "publishing is broken".
//
// `GET /api/v1/auth-check` is deliberately NOT bound and stays on the bare
// secret: it is the shared boot-time parity probe (gateway/src/lib/
// internal-parity.ts) that also runs against payment-service and key-service,
// reaching it IS the proof, and it discloses nothing. Binding it would make the
// one probe three probes.
// =============================================================================

export const BINDING_HEADER = "x-internal-binding";
export const SIGNER_HEADER = "x-signer-id";

/** How far a binding's timestamp may sit from the receiver's clock, either way.
 *  Wide enough for container clock drift, narrow enough that a captured request
 *  is not a standing capability. */
export const BINDING_MAX_SKEW_MS = 5 * 60_000;

const VERSION = "v1";

function tupleFor(parts: {
  timestampMs: number;
  method: string;
  path: string;
  rawBody: string;
  subject: readonly string[];
}): string {
  return [
    VERSION,
    String(parts.timestampMs),
    parts.method.toUpperCase(),
    parts.path,
    createHash("sha256").update(parts.rawBody, "utf8").digest("hex"),
    // The subject terms, NUL-joined so no two different lists can spell the
    // same string. Empty for key-custody, which takes its subject from the body
    // the hash above already covers.
    parts.subject.join("\u0000"),
  ].join("\n");
}

export interface BindingInput {
  method: string;
  /** The path as the RECEIVER will see it — `req.url`, query string included. */
  path: string;
  /** The exact bytes sent as the body; the empty string for a bodyless request. */
  rawBody: string;
  /**
   * Values that carry the request's SUBJECT when the body does not — the case
   * the header above anticipated ("if a future route ever takes its subject
   * somewhere other than the body, put that somewhere in the tuple"), and
   * key-service is it.
   *
   * key-custody names its signer in the body, so the body hash already covers a
   * retarget and this stays empty there. key-service names it in HEADERS
   * (`x-reader-id` / `x-reader-pubkey` / `x-writer-id`) against a body that is
   * frequently `{}` or absent: `POST /articles/:id/key` is a paywalled-content
   * key issue whose reader is a header, and `GET /writers/export-keys` exports
   * every vault key a writer holds with no body at all. Without these terms a
   * captured request could be pointed at a different reader or a different
   * writer by editing one header, and path-plus-body-hash would not notice —
   * which is precisely the escalation the binding exists to stop.
   *
   * Both sides pass the values they READ off the request, in a fixed order per
   * route; a receiver that took them from the binding would be asserting the
   * thing it is meant to prove. A missing header is the empty string, so an
   * omitted one cannot silently collapse into an absent term.
   */
  subject?: readonly string[];
}

/** Produce the `x-internal-binding` value for a request. */
export function signInternalRequest(
  secret: string,
  input: BindingInput,
  now: number = Date.now(),
): string {
  const tag = createHmac("sha256", secret)
    .update(
      tupleFor({ ...input, subject: input.subject ?? [], timestampMs: now }),
      "utf8",
    )
    .digest("hex");
  return `${VERSION}.${now}.${tag}`;
}

export type BindingFailure =
  | "missing"
  | "malformed"
  | "bad_version"
  | "stale"
  | "mismatch";

export type BindingVerdict = { ok: true } | { ok: false; reason: BindingFailure };

/**
 * Verify a binding against the request the receiver actually got.
 *
 * The caller passes the values it read off the request, never values it took
 * from the header — a binding that supplied its own path would be asserting the
 * thing it is meant to prove.
 */
export function verifyInternalRequest(
  secret: string,
  header: string | string[] | undefined,
  input: BindingInput,
  now: number = Date.now(),
): BindingVerdict {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "missing" };

  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, tsRaw, tag] = parts;
  if (version !== VERSION) return { ok: false, reason: "bad_version" };

  const timestampMs = Number(tsRaw);
  if (!Number.isSafeInteger(timestampMs)) return { ok: false, reason: "malformed" };
  if (Math.abs(now - timestampMs) > BINDING_MAX_SKEW_MS) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", secret)
    .update(
      tupleFor({ ...input, subject: input.subject ?? [], timestampMs }),
      "utf8",
    )
    .digest("hex");

  if (!timingSafeEqualStrings(tag, expected)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** `timingSafeEqual` throws on a length mismatch, and a length mismatch is
 *  already a non-match. Both operands here are fixed-width hex digests, so no
 *  length is disclosed that the algorithm did not already publish. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// =============================================================================
// key-service's subject terms — ONE spelling
//
// The tuple rule at the top of this file applies to the subject just as it does
// to the rest of it: two spellings would disagree silently, and the symptom
// would be "paywalled publishing is broken" with a 401 nobody can reproduce. So
// the ORDER lives here, imported by the sender
// (gateway/src/lib/key-service-client.ts) and by the receiver
// (key-service/src/routes/keys.ts) alike.
//
// A missing header contributes the empty string rather than being skipped, so
// no two different identity sets can spell the same tuple — `{writerId: "x"}`
// and `{readerId: "x"}` must not collapse into the same one-element list.
// =============================================================================

export interface KeyServiceIdentity {
  readerId?: string;
  readerPubkey?: string;
  writerId?: string;
  writerPubkey?: string;
}

export function keyServiceSubject(id: KeyServiceIdentity): string[] {
  return [
    id.readerId ?? "",
    id.readerPubkey ?? "",
    id.writerId ?? "",
    id.writerPubkey ?? "",
  ];
}
