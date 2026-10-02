import type { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { rateLimitPluginOptions } from "./lib/rate-limit.js";
import { keyRoutes } from "./routes/keys.js";
import { setRawBody } from "./lib/raw-body.js";
import { pool } from "@platform-pub/shared/db/client.js";

/**
 * The one place key-service is assembled — plugins, parsers, routes, in the
 * order `start()` puts them in. It exists for the same reason key-custody's
 * does, and for the reason the S7 comment in tests/rate-limit-buckets.test.ts
 * gives: a test that rebuilds the registration agrees with itself about a
 * service it has not built. The binding guard depends on a content-type parser
 * registered here, so a test that skipped it would prove nothing about the
 * running service.
 */
export async function buildApp(app: FastifyInstance) {
  await app.register(sensible);

  // Keep the raw JSON body on the way past. The per-request binding hashes the
  // bytes the gateway SENT, and a re-serialisation of `req.body` is not those
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

  // Rate limiting — registered NON-global, one bucket per identity. Every
  // option, and the reason, is in lib/rate-limit.ts; the routes attach their own
  // budgets there too.
  await app.register(rateLimit, rateLimitPluginOptions);

  await app.register(keyRoutes, { prefix: "/api/v1" });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "key-service" };
  });

  return app;
}
