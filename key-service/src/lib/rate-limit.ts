import type { FastifyRequest } from "fastify";
import type {
  RateLimitOptions,
  RateLimitPluginOptions,
} from "@fastify/rate-limit";

// =============================================================================
// key-service rate limiting — one bucket per identity (MIRROR-AUDIT §2.13)
//
// The limiter used to be registered globally with a single keyGenerator reading
// `x-reader-id` and falling back to `req.ip`. Every WRITER route sends no reader
// id, so vault publish, the vault PATCH, the editor's paywall-content load, the
// writer key export and the gateway's own liveness probe all fell back to the
// same key — the gateway container's IP — and shared ONE 10/min bucket
// platform-wide with each other. A writer publishing eleven paywalled pieces in
// a minute spent the key-fishing budget, the export budget and the parity
// probe's, all at once.
//
// So the plugin is registered NON-global and each route declares its own budget,
// keyed on the identity that route actually carries. A route with no
// `config.rateLimit` is not limited at all — which is what `/auth-check` wants.
//
// This file is the one home for those options: `src/index.ts` registers
// `rateLimitPluginOptions`, `routes/keys.ts` attaches the per-route configs, and
// the test drives the real routes through the real options. A test that built
// its own registration would pass against a broken one.
// =============================================================================

export const rateLimitPluginOptions: RateLimitPluginOptions = {
  // Per-route only. The values below are the defaults a route's own
  // `config.rateLimit` is Object.assigned on top of (index.js:155), so the error
  // shape lives here and nowhere else.
  global: false,
  max: 10,
  timeWindow: "1 minute",
  // `statusCode` is NOT decoration. @fastify/rate-limit `throw`s whatever this
  // returns and Fastify reads `err.statusCode` off it (index.js:271, and the
  // plugin's own defaultErrorResponse sets it) — so without it EVERY
  // rate-limited request answered 500, including on the key-fishing route the
  // limiter exists for. That had been true since the limiter was added; found
  // while splitting the buckets, 2026-09-10. `ctx.ban ? 403 : 429` is the
  // plugin's own computation (index.js:258) read off the one field its types
  // expose, so a future `ban` setting reports 403 rather than this hard-coding a
  // 429 that would then be wrong.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: ctx.ban ? 403 : 429,
    error: "RATE_LIMITED",
    message: "Too many key requests — slow down",
  }),
};

// The fallback to `req.ip` is for a request arriving with the header missing.
// The handler 401s on that anyway, but the limiter runs on `onRequest` — before
// the handler and before the plugin-scope internal-secret preHandler — so it
// needs an answer either way.
function byHeader(header: "x-reader-id" | "x-writer-id") {
  return (req: FastifyRequest): string => {
    const v = req.headers[header];
    return typeof v === "string" && v.length > 0 ? v : req.ip;
  };
}

const perMinute = (
  max: number,
  header: "x-reader-id" | "x-writer-id",
): { rateLimit: RateLimitOptions } => ({
  rateLimit: { max, timeWindow: "1 minute", keyGenerator: byHeader(header) },
});

/** POST /articles/:nostrEventId/key — the key-fishing surface the original
 *  10/min was written for. It keeps that budget; what changes is that it no
 *  longer shares it with every writer route on the service. */
export const readerKeyLimit = perMinute(10, "x-reader-id");

/** POST + PATCH /articles/:nostrEventId/vault — one vault write per paywalled
 *  piece. Generous enough for a bulk archive import, and per writer, so a busy
 *  author costs nobody else. */
export const writerPublishLimit = perMinute(60, "x-writer-id");

/** GET /articles/:articleId/paywall-content — editor loads of the writer's own
 *  paywalled body. Generous; flicking between drafts must never meet this. */
export const writerReadLimit = perMinute(60, "x-writer-id");

/** GET /writers/export-keys — the sensitive one: every vault key the writer owns
 *  in one response. Tight, and per writer so tightness costs nobody else. */
export const writerExportLimit = perMinute(5, "x-writer-id");
