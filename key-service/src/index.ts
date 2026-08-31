import "dotenv/config";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { keyRoutes } from "./routes/keys.js";
import { pool } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "@platform-pub/shared/lib/logger.js";
import {
  requireEnv,
  requireEnvMinLength,
} from "@platform-pub/shared/lib/env.js";

// =============================================================================
// all.haus — Key Service
//
// Runs alongside the relay. Single responsibility: on proof of payment,
// issue the content key for a given article to a given reader, encrypted
// to that reader's public key using NIP-44.
// =============================================================================

// Validate required env vars at startup — fail fast
requireEnv("INTERNAL_SECRET");
requireEnv("DATABASE_URL");
requireEnvMinLength("KMS_MASTER_KEY_HEX", 32);

const app = Fastify({ logger: pinoConfig });

async function start() {
  await app.register(sensible);

  // Rate limiting — protects the key issuance endpoint from key-fishing
  await app.register(rateLimit, {
    max: 10,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      // Rate limit per reader, not per IP (readers behind NAT / VPNs)
      const readerId = req.headers["x-reader-id"];
      return typeof readerId === "string" ? readerId : req.ip;
    },
    errorResponseBuilder: () => ({
      error: "RATE_LIMITED",
      message: "Too many key requests — slow down",
    }),
  });

  await app.register(keyRoutes, { prefix: "/api/v1" });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "key-service" };
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const port = parseInt(process.env.PORT ?? "3002", 10);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Key service started");
}

start().catch((err) => {
  logger.error({ err }, "Failed to start key service");
  process.exit(1);
});
