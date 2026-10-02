import type { FastifyRequest } from "fastify";

// =============================================================================
// Raw request body, kept for the per-request binding
//
// The binding hashes the bytes the gateway SENT (shared/lib/internal-binding.ts).
// A receiver that re-serialised `req.body` would be hashing something else:
// `JSON.parse` → `JSON.stringify` is not the identity function — number
// formatting and escape forms both survive the round trip only by luck — so it
// would reject good requests at a rate nobody could reproduce, and the symptom
// would be "publishing is intermittently broken".
//
// So `src/app.ts` installs a JSON content-type parser that keeps the raw
// string here on the way past, and the guard reads it back through this one
// accessor. A bodyless request (`GET /writers/export-keys`) never reaches the
// parser, and the empty string is what the sender hashed for it.
// =============================================================================

const RAW = Symbol.for("platformpub.rawBody");

export function setRawBody(req: FastifyRequest, raw: string): void {
  (req as unknown as Record<symbol, string>)[RAW] = raw;
}

export function rawBodyOf(req: FastifyRequest): string {
  return (req as unknown as Record<symbol, string | undefined>)[RAW] ?? "";
}
