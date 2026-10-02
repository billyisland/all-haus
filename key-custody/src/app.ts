import type { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { keypairRoutes } from "./routes/keypairs.js";
import { rateLimitPluginOptions } from "./lib/rate-limit.js";
import { setRawBody } from "./lib/raw-body.js";
import { pool } from "@platform-pub/shared/db/client.js";

// =============================================================================
// key-custody, assembled.
//
// Separate from index.ts so importing the assembly does not start a listener —
// the guard/limiter test drives this, and a test that had to import the
// entrypoint would either boot a socket or be testing a copy of it.
// =============================================================================

/**
 * The service, assembled. Exported so the guard/limiter test drives the REAL
 * registration — the raw-body parser, the limiter options and the routes, in the
 * order `start()` puts them in. A test that rebuilt this would agree with itself
 * about a service it had not built (the S7 lesson on key-service, where exactly
 * that passed green against every rate-limited request answering 500).
 */
export async function buildApp(app: FastifyInstance) {
  await app.register(sensible);

  // Keep the raw JSON body on the way past. The per-request binding hashes the
  // bytes the caller SENT, and a re-serialisation of `req.body` is not those
  // bytes — see lib/raw-body.ts. This replaces Fastify's built-in JSON parser
  // rather than sitting beside it, so every JSON request on this service is
  // covered and none can slip in unrecorded.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      setRawBody(req, raw);
      if (raw.length === 0) return done(null, undefined);
      try {
        done(null, JSON.parse(raw));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // Rate limiting — registered NON-global, one bucket per signer. Every option,
  // and the reason, is in lib/rate-limit.ts; the routes attach their own budgets
  // there too.
  await app.register(rateLimit, rateLimitPluginOptions);

  await app.register(keypairRoutes, { prefix: "/api/v1" });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "key-custody" };
  });

  return app;
}

