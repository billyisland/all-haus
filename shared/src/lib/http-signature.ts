import { createSign, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { requireRsaPrivateKeyB64 } from "./env.js";

// =============================================================================
// HTTP Signatures (draft-cavage-12) for outbound ActivityPub reads
//
// WHAT THIS IS FOR. An instance running in secure mode — Mastodon's
// `AUTHORIZED_FETCH`, and the equivalent in Akkoma, Misskey, GoToSocial and
// hardened Lemmy — answers every UNSIGNED ActivityPub GET with 401. The
// Mastodon client-API fallback shipped 2026-09-18 covers Mastodon-compatible
// servers, which is nearly everything a member will paste, and NOTHING else:
// on any other secure-mode implementation a pasted handle still resolves to no
// match, a follow still answers 422, and a source still polls for ever without
// delivering. This module is the answer those servers actually asked for.
//
// THE SIGNATURE PROVES NOTHING ABOUT US EXCEPT WHO WE ARE. It is not a
// credential and it carries no authorisation: the receiving instance fetches
// our actor document, reads the public half out of it, and verifies. So the
// private key here is a SECRET in the ordinary sense — anyone holding it can
// make requests that appear to come from all.haus — but losing it discloses
// nothing about any member, and rotating it costs nothing but the time remote
// caches take to expire.
//
// WHY THE KEY IS OPTIONAL. Signing is a capability, not a requirement: with no
// key configured every caller behaves exactly as it did before this module
// existed. That is deliberate and it is the deploy story — the key, the actor
// document and the nginx location can land in any order, and until all three
// are in place the platform reads the fediverse exactly as well as it did the
// day before. What is NOT optional is a key that is set and wrong: that throws
// at boot (`requireRsaPrivateKeyB64`), because a fallback is for an absent
// value and never for a malformed one, and a signature built from a broken key
// would present as "this instance refuses us" — the very symptom this exists
// to end, wearing the same clothes.
//
// THE KEY ID IS A URL AND IT MUST RESOLVE. `keyId` names the actor document
// the verifier will GET; if it 404s the verification fails and the request is
// refused. So this module derives it from `APP_URL` and the gateway serves the
// document at exactly that path (`gateway/src/index.ts`, `/actor`) — one
// spelling, in `instanceActorId()`, imported by both, because two copies of a
// URL disagree silently and the symptom is "signing does not work".
// =============================================================================

const KEY_ENV = "AP_INSTANCE_PRIVATE_KEY_B64";

/**
 * Mastodon refuses a key below 2048 bits, and so does every other verifier
 * worth naming. Stated here rather than at the generator so a key generated
 * elsewhere is held to the same bar.
 */
const MIN_KEY_BITS = 2048;

/** The fragment Mastodon, Akkoma and friends all use. Ours matches for no
 *  reason but familiarity — a verifier reads the document, not the fragment. */
const KEY_FRAGMENT = "#main-key";

/** Path of the instance actor document, relative to `APP_URL`. */
export const INSTANCE_ACTOR_PATH = "/actor";

/** Path of the instance actor's inbox. See the route for what it does. */
export const INSTANCE_ACTOR_INBOX_PATH = "/actor/inbox";

/** The `preferredUsername` of the instance actor, and the only name our
 *  WebFinger answers for. */
export const INSTANCE_ACTOR_USERNAME = "allhaus";

// -----------------------------------------------------------------------------
// The key
// -----------------------------------------------------------------------------

interface InstanceKey {
  privateKey: KeyObject;
  /** SPKI PEM, which is what `publicKeyPem` in an actor document holds. */
  publicKeyPem: string;
}

// `undefined` = not yet looked at; `null` = looked at, not configured. The
// distinction is what stops an unconfigured deployment re-reading and
// re-warning on every outbound fetch.
let cachedKey: InstanceKey | null | undefined;

/**
 * Is a signing key configured at all?
 *
 * Deliberately a test of the RAW variable rather than of the parsed key: a
 * malformed value is CONFIGURED, and must reach `instanceKey()` so it throws
 * rather than reading as "signing is off".
 */
export function apSigningConfigured(): boolean {
  const raw = process.env[KEY_ENV];
  return raw !== undefined && raw !== "";
}

/**
 * The parsed key, or null when none is configured.
 *
 * Throws when one IS configured and does not parse — see the header. The parse
 * happens once; `assertApSigningKeyUsable()` is what makes that once happen at
 * boot instead of at the first fetch.
 */
export function instanceKey(): InstanceKey | null {
  if (cachedKey !== undefined) return cachedKey;
  if (!apSigningConfigured()) {
    cachedKey = null;
    return null;
  }
  const pem = requireRsaPrivateKeyB64(KEY_ENV, MIN_KEY_BITS);
  const privateKey = createPrivateKey(pem);
  // DERIVED, never a second environment variable. Two halves of one keypair
  // given as two values is two things that can disagree, and the disagreement
  // is silent in the worst direction: we publish a public key nothing we sign
  // can be verified against, every remote refuses us, and the document looks
  // perfectly well-formed to anyone reading it.
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  cachedKey = { privateKey, publicKeyPem };
  return cachedKey;
}

/**
 * The boot check. A no-op when no key is configured; throws when one is
 * configured and unusable, before `listen()`.
 *
 * Called at module scope in the two services that sign (`gateway`,
 * `feed-ingest`). A key that only fails at the first outbound fetch fails
 * inside a poll, is caught by the poll's own error handling, and spends a
 * source's error budget on our own misconfiguration — which is the exact
 * failure this whole line of work exists to stop.
 */
export function assertApSigningKeyUsable(): void {
  instanceKey();
}

/** Only for tests, which set and unset the variable between cases. */
export function resetApSigningKeyCache(): void {
  cachedKey = undefined;
}

// -----------------------------------------------------------------------------
// Identity
// -----------------------------------------------------------------------------

function appOrigin(): string | null {
  const raw = process.env.APP_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** `https://all.haus/actor` — the document a verifier fetches. */
export function instanceActorId(): string | null {
  const origin = appOrigin();
  return origin ? `${origin}${INSTANCE_ACTOR_PATH}` : null;
}

/** `https://all.haus/actor#main-key` — what goes in `keyId`. */
export function instanceActorKeyId(): string | null {
  const id = instanceActorId();
  return id ? `${id}${KEY_FRAGMENT}` : null;
}

/** The public half, as an actor document's `publicKeyPem`. Null when unconfigured. */
export function instanceActorPublicKeyPem(): string | null {
  return instanceKey()?.publicKeyPem ?? null;
}

// -----------------------------------------------------------------------------
// Signing
// -----------------------------------------------------------------------------

/**
 * Headers that sign a GET of `url` as the instance actor, or null when signing
 * is not configured (no key, or no usable `APP_URL` to name ourselves with).
 *
 * THE SIGNED SET IS `(request-target) host date`, which is the floor every
 * implementation verifies and the most any of them require of a bodyless GET.
 * `digest` is for bodies and is deliberately absent.
 *
 * THE DATE IS RETURNED AS WELL AS SIGNED. A signature over a `Date` the
 * request does not carry verifies against nothing; receivers additionally
 * refuse a date more than a few minutes off their own clock, so this is a
 * per-request value and never a cached one.
 *
 * THE HOST IS THE URL'S, NOT A HEADER WE SET. undici derives `Host` from the
 * URL and ignores an explicit one, so signing anything else would sign a value
 * the receiver never sees. `URL.host` carries the port when it is non-default,
 * which is what the receiver reconstructs too.
 */
export function signedGetHeaders(url: string): Record<string, string> | null {
  const key = instanceKey();
  const keyId = instanceActorKeyId();
  if (!key || !keyId) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const date = new Date().toUTCString();
  // `(request-target)` is the method lowercased, a space, then path AND query
  // — a signature over the path alone verifies against a different request on
  // every paged outbox read.
  const requestTarget = `get ${parsed.pathname}${parsed.search}`;
  const signingString = [
    `(request-target): ${requestTarget}`,
    `host: ${parsed.host}`,
    `date: ${date}`,
  ].join("\n");

  const signature = createSign("RSA-SHA256")
    .update(signingString)
    .sign(key.privateKey, "base64");

  return {
    Date: date,
    Signature:
      `keyId="${keyId}",algorithm="rsa-sha256",` +
      `headers="(request-target) host date",signature="${signature}"`,
  };
}
