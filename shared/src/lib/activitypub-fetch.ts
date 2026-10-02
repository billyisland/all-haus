import { safeFetch, type SafeFetchResult } from "./http-client.js";
import {
  apSigningConfigured,
  signedGetHeaders,
} from "./http-signature.js";
import { isSignedFetchRefusal } from "./mastodon-api.js";
import logger from "./logger.js";

// =============================================================================
// Fetching an ActivityPub document — the one home, and the third arm
//
// THREE ARMS, IN THIS ORDER, AND THE ORDER IS THE DESIGN.
//
//   1. UNSIGNED ActivityPub. What the platform has always done, and what the
//      overwhelming majority of the fediverse still answers.
//   2. SIGNED ActivityPub (this module + `http-signature.ts`). Tried only
//      after (1) has been refused 401/403, which is the instance saying in so
//      many words that it wants a signature.
//   3. The Mastodon client API (`mastodon-api.ts`), the caller's own fallback
//      after this module reports a refusal it could not get past.
//
// WHY NOT SIGN EVERYTHING. Signing every request is what a fediverse server
// does, and it was the first design. Two things argued it down, and both are
// about failure rather than about correctness.
//
//   A signature is an IDENTITY. A domain block on the receiving instance keys
//   on the signing actor's host, so signing unconditionally would hand every
//   instance that has blocked us the ability to refuse reads an unsigned
//   request is served. That is their decision to make — but it should be made
//   where they made it, on a secure-mode instance, not extended by us to every
//   instance that never asked.
//
//   And a signature can be WRONG in ways an absent one cannot. Our key, our
//   actor document and the nginx location in front of it are three things that
//   land at three moments; a verifier that cannot fetch `keyId` refuses the
//   request, and several implementations refuse a present-but-unverifiable
//   signature where they would have served an unsigned read. Signing first
//   would therefore make a half-finished deploy WORSE than no deploy at all,
//   across the whole fediverse rather than the secure-mode part of it. Signing
//   second cannot: with the key absent, misconfigured or unreachable, every
//   caller behaves exactly as it did the day before.
//
// SO THE COST IS ONE EXTRA ROUND TRIP PER SECURE-MODE HOST, and the memo below
// is what stops it being one per request.
// =============================================================================

export const AP_ACCEPT =
  'application/activity+json, application/ld+json;profile="https://www.w3.org/ns/activitystreams", application/json;q=0.9';

// -----------------------------------------------------------------------------
// Which hosts have asked us to sign
//
// Per process and in memory deliberately: it is an optimisation and never a
// fact anything depends on. A cold process pays one extra GET per host and
// then behaves identically, which is the property that makes it safe to have
// no invalidation story beyond the TTL.
//
// BOUNDED, because the key space is attacker-steerable — a host here comes
// from a `source_uri` a member pasted, and an outbox `next` link ultimately
// comes off the wire. The cap is generous next to the number of instances a
// closed beta subscribes to, and hitting it CLEARS rather than evicts one
// entry: the whole thing is rebuildable from one extra round trip per host, so
// the simplest correct behaviour is the right one.
// -----------------------------------------------------------------------------

const MEMO_TTL_MS = 12 * 60 * 60 * 1000;
const MEMO_MAX_HOSTS = 4096;

const requiresSignature = new Map<string, number>();

function hostRequiresSignature(host: string): boolean {
  const until = requiresSignature.get(host);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    requiresSignature.delete(host);
    return false;
  }
  return true;
}

function noteRequiresSignature(host: string): void {
  if (requiresSignature.size >= MEMO_MAX_HOSTS) requiresSignature.clear();
  requiresSignature.set(host, Date.now() + MEMO_TTL_MS);
}

/** Only for tests, which drive the same host through several postures. */
export function resetSignedFetchMemo(): void {
  requiresSignature.clear();
}

// -----------------------------------------------------------------------------
// The fetch
// -----------------------------------------------------------------------------

export interface ApDocumentResult {
  /** The response the caller should read. `res.url` remains the §2.9 authority. */
  res: SafeFetchResult;
  /** Was the response above produced by a SIGNED request? */
  signed: boolean;
  /**
   * Is this refusal a fact about US rather than about the source?
   *
   * True when the final answer was 401/403 — i.e. the instance wants a
   * signature and either we have none, or the one we sent did not satisfy it.
   * The caller must not spend the source's error budget on this; it is the
   * whole reason `isSignedFetchRefusal` exists.
   */
  signedFetchRefused: boolean;
}

/**
 * GET an ActivityPub document, escalating to a signed request if the instance
 * refuses an unsigned one.
 *
 * Throws what `safeFetch` throws — a transport fault or a timeout is not a
 * verdict and must not be turned into one here.
 */
export async function fetchApDocument(
  url: string,
  opts: { timeout?: number } = {},
): Promise<ApDocumentResult> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    // safeFetch will refuse it in a moment and say why; nothing to memoise.
    host = "";
  }

  const canSign = apSigningConfigured();
  const signFirst = canSign && host !== "" && hostRequiresSignature(host);

  if (signFirst) {
    const res = await getAp(url, opts, true);
    if (res.ok || !isSignedFetchRefusal(res.status)) {
      return { res, signed: true, signedFetchRefused: false };
    }
    // Our memo said this host wants a signature and it refused the one we
    // sent. Forget it, so the next poll starts over from an unsigned read
    // rather than inheriting a verdict that is no longer true — an instance
    // that has turned secure mode OFF again would otherwise stay signed-only
    // for as long as the process lives.
    requiresSignature.delete(host);
    return { res, signed: true, signedFetchRefused: true };
  }

  const unsigned = await getAp(url, opts, false);
  if (unsigned.ok || !isSignedFetchRefusal(unsigned.status)) {
    return { res: unsigned, signed: false, signedFetchRefused: false };
  }

  if (host !== "") noteRequiresSignature(host);

  if (!canSign) {
    return { res: unsigned, signed: false, signedFetchRefused: true };
  }

  const signed = await getAp(url, opts, true);
  const stillRefused = !signed.ok && isSignedFetchRefusal(signed.status);
  if (stillRefused) {
    // A signature this host will not accept. Either it has blocked us, or it
    // cannot read our actor document — and the two are indistinguishable from
    // here, so the log line says what we know rather than guessing.
    logger.info(
      { url, status: signed.status },
      "ActivityPub read refused a signed request too — the instance has blocked us, or cannot reach our actor document",
    );
    if (host !== "") requiresSignature.delete(host);
  }
  return { res: signed, signed: true, signedFetchRefused: stillRefused };
}

function getAp(
  url: string,
  opts: { timeout?: number },
  sign: boolean,
): Promise<SafeFetchResult> {
  return safeFetch(url, {
    headers: { Accept: AP_ACCEPT },
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    // `signedGetHeaders` is handed the hop's own URL by the client, not this
    // one — see `SafeFetchOptions.signRequest`.
    ...(sign ? { signRequest: (req) => signedGetHeaders(req.url) } : {}),
  });
}
