import "dotenv/config";
import Fastify from "fastify";
import { buildApp } from "./app.js";
import { pool } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "@platform-pub/shared/lib/logger.js";
import {
  requireEnv,
  requireHexKeyBytes,
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
// 32 BYTES = 64 hex characters, which is what the cipher parses. The old
// `requireEnvMinLength(…, 32)` counted CHARACTERS, so a 32-character key
// passed startup and threw at the first real use.
requireHexKeyBytes("KMS_MASTER_KEY_HEX", 32);
// The NIP-44 service keypair (lib/nip44.ts) — 32-byte secp256k1 secret key.
// It was not boot-checked at all, so a missing or malformed one first
// surfaced as a failed key wrap on a reader's paid unlock.
requireHexKeyBytes("PLATFORM_SERVICE_PRIVKEY", 32);

const app = Fastify({ logger: pinoConfig });

async function start() {
  await buildApp(app);

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
