import "dotenv/config";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { keypairRoutes } from "./routes/keypairs.js";
import { pool } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "@platform-pub/shared/lib/logger.js";
import {
  requireEnv,
  requireEnvMinLength,
} from "@platform-pub/shared/lib/env.js";

// =============================================================================
// all.haus — Key Custody Service
//
// Sole responsibility: custody and use of user Nostr private keys.
//
// This service is the only component that holds ACCOUNT_KEY_HEX — the master
// key that encrypts user private keys at rest. The gateway and all other
// services call this service for any operation requiring a user's private key.
//
// Exposes three internal endpoints (require X-Internal-Secret header):
//   POST /api/v1/keypairs/generate  — generate a keypair for a new account
//   POST /api/v1/keypairs/sign      — sign a Nostr event for an account
//   POST /api/v1/keypairs/unwrap    — unwrap a NIP-44 content key for a reader
//
// This is the first step toward a NIP-46 compatible remote signing service.
// Future: expose a NIP-46 WebSocket endpoint so users can transfer key custody
// to a third-party bunker or a browser extension.
// =============================================================================

// Validate required env vars at startup — fail fast
requireEnv("INTERNAL_SECRET");
requireEnv("DATABASE_URL");
requireEnvMinLength("ACCOUNT_KEY_HEX", 32);

const app = Fastify({ logger: pinoConfig });

async function start() {
  await app.register(sensible);
  await app.register(keypairRoutes, { prefix: "/api/v1" });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { status: "ok", service: "key-custody" };
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const port = parseInt(process.env.PORT ?? "3004", 10);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Key custody service started");
}

start().catch((err) => {
  logger.error({ err }, "Failed to start key custody service");
  process.exit(1);
});
