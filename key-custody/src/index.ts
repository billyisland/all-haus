import "dotenv/config";
import Fastify from "fastify";
import { buildApp } from "./app.js";
import { pool } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "@platform-pub/shared/lib/logger.js";
import { getServicePubkey } from "./lib/crypto.js";
import {
  requireEnv,
  requireHexKeyBytes,
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
// Exposes three internal endpoints (require X-Internal-Secret header AND a
// per-request binding over method/path/signer/body — shared/lib/internal-
// binding.ts, MIRROR-AUDIT S15):
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
// 32 BYTES = 64 hex characters, which is what the cipher parses. The old
// `requireEnvMinLength(…, 32)` counted CHARACTERS, so a 32-character key
// passed startup and threw at the first real use.
requireHexKeyBytes("ACCOUNT_KEY_HEX", 32);
// The service pubkey (CA-F14b): a MALFORMED value is fatal here rather than at
// the first unwrap. An ABSENT one is loud but not fatal — unwrap is the only
// consumer, and every signing route must not go down with it.
try {
  getServicePubkey();
} catch (err) {
  if (!process.env.PLATFORM_SERVICE_PUBKEY && !process.env.PLATFORM_SERVICE_PRIVKEY) {
    console.error(
      "[key-custody] PLATFORM_SERVICE_PUBKEY is not set — every content-key unwrap will fail until it is",
    );
  } else {
    throw err;
  }
}

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

  const port = parseInt(process.env.PORT ?? "3004", 10);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Key custody service started");
}

start().catch((err) => {
  logger.error({ err }, "Failed to start key custody service");
  process.exit(1);
});
