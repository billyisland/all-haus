import type { FastifyRequest } from "fastify";
import type {
  RateLimitOptions,
  RateLimitPluginOptions,
} from "@fastify/rate-limit";
import { SIGNER_HEADER } from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// key-custody rate limiting — one bucket per signer (MIRROR-AUDIT §3, S15)
//
// This service had no limiter at all: one caller holding the internal secret
// could sign for every account, or walk `/keypairs/export` through the whole
// `accounts` table, at whatever rate the socket allowed. The binding closes
// forgery; it does nothing about VOLUME, and volume is the difference between
// one leaked nsec and all of them.
//
// Registered NON-global for the same reason key-service is (§2.13): a single
// bucket shared by every route is a bucket the busiest route spends on behalf of
// the most sensitive one. Each route declares its own budget, keyed on the
// signer the request names.
//
// TWO THINGS THE KEY CANNOT BE, and why it is the header. The limiter runs on
// `onRequest` — before the body is parsed and before the binding preHandler — so
// it cannot read `body.signerId`, and `req.ip` is the gateway container for
// every request on this service, which is the one-bucket-for-everyone bug over
// again. So the gateway lifts the signer onto `x-signer-id` and the limiter keys
// on that.
//
// SAY PLAINLY WHAT THAT HEADER IS: an UNAUTHENTICATED hint, and nothing
// authorises on it. A caller without the secret can pick its own bucket key, and
// because the limiter sits ahead of the guard, its refused requests spend a slot
// too — so the worst it buys is denial of one signer's budget, which is strictly
// better than `req.ip`, where the same caller denies every signer at once. The
// budget is the outer wall; the binding is the lock.
//
// This file is the one home for those options: `src/index.ts` registers
// `rateLimitPluginOptions`, `routes/keypairs.ts` attaches the per-route configs,
// and the test drives the real routes through the real options.
// =============================================================================

export const rateLimitPluginOptions: RateLimitPluginOptions = {
  global: false,
  max: 60,
  timeWindow: "1 minute",
  // `statusCode` is NOT decoration: @fastify/rate-limit `throw`s whatever this
  // returns and Fastify reads `err.statusCode` off it, so without it every
  // rate-limited request answers 500. That had been true on key-service for the
  // whole life of its limiter (found in S7); this one is born with it.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: ctx.ban ? 403 : 429,
    error: "RATE_LIMITED",
    message: "Too many key-custody requests — slow down",
  }),
};

function bySigner(req: FastifyRequest): string {
  const v = req.headers[SIGNER_HEADER];
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "string" && raw.length > 0 ? raw : req.ip;
}

const perMinute = (max: number): { rateLimit: RateLimitOptions } => ({
  rateLimit: { max, timeWindow: "1 minute", keyGenerator: bySigner },
});

/** Signing, unwrapping and NIP-44. Generous — a bulk archive import signs one
 *  event per piece, and a DM send batch-encrypts in a single call — and per
 *  signer, so a busy account costs nobody else. */
export const signerBudget = perMinute(120);

/** `POST /keypairs/sign-batch` — up to 500 events per call (CA-A8). Its OWN
 *  budget, not `signerBudget`'s: the batch exists so that a member with more
 *  pieces than the single route signs in a minute can still be suspended, and
 *  sharing the per-event bucket would make the batch spend what it was built
 *  to bypass. 20 calls a minute is 10,000 tombstones a minute per signer,
 *  which is one suspension of any account the platform has. */
export const signBatchBudget = perMinute(20);

/** `POST /keypairs/export` — the account's root nsec, which IS the identity and
 *  cannot be rotated. Tight, and per signer so tightness costs nobody else. The
 *  gateway already fronts it with a mailed one-use step-up (S4); this is what
 *  bounds a caller that is past that, or past the gateway entirely. */
export const exportBudget = perMinute(5);

/** `POST /keypairs/generate` names no signer, so it buckets on `req.ip` — the
 *  gateway, i.e. one bucket for the service. That is correct here: it is a
 *  signup-rate ceiling and there is nothing per-account to key it on. */
export const generateBudget = perMinute(60);
