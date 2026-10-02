import "dotenv/config";
import {
  requireEnv,
  requireEnvMinLength,
  tributesEnabled,
} from "@platform-pub/shared/lib/env.js";
import { ADVISORY_LOCKS } from "@platform-pub/shared/lib/advisory-locks.js";
import { assertApSigningKeyUsable } from "@platform-pub/shared/lib/http-signature.js";
import { assertInternalParity } from "./lib/internal-parity.js";
import { gatewayErrorHandler } from "./lib/error-handler.js";
import { startEmailHealthChecks } from "@platform-pub/shared/lib/email-health.js";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { sweepExpiredSuspensions } from "./routes/moderation.js";
import { expireAndRenewSubscriptions } from "./workers/subscription-expiry.js";
import { runTributeSweep } from "./lib/tribute-sweep.js";
import { expireOverdueDrives } from "./workers/drive-expiry.js";
import {
  followImportEnabled,
  runFollowImportSweep,
} from "./lib/follow-import.js";
import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import { registerRoutes } from "./register-routes.js";
import { publishScheduledDrafts } from "./workers/scheduler.js";
import { sweepReadingLog } from "./workers/reading-log-sweep.js";
import { cleanupExpiredLinks } from "@platform-pub/shared/auth/magic-links.js";
import { sendWaitlistDigest } from "./workers/waitlist-digest.js";
import { runDiscoverySweep } from "./lib/discovery-publish.js";
import { pool, withAdvisoryLock as withSharedAdvisoryLock } from "@platform-pub/shared/db/client.js";
import logger, { pinoConfig } from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// all.haus — API Gateway
//
// Single ingress point for all client requests. Responsibilities:
//
//   1. Cookie-based session management (JWT in httpOnly cookie)
//   2. Auth routes (signup, login, logout, account info)
//   3. Stripe Connect and card onboarding
//   4. Proxy to internal services (payment-service, key-service)
//      with x-reader-id / x-writer-id / x-reader-pubkey headers injected
//
// The gateway is the ONLY service exposed to the public internet.
// Payment and key services are internal-only.
//
// In production this sits behind a reverse proxy (nginx, Caddy, or
// Cloudflare Tunnel) that handles TLS termination.
// =============================================================================

// Validate required env vars at startup — fail fast
const SESSION_SECRET = requireEnvMinLength("SESSION_SECRET", 32);
const COOKIE_SECRET = process.env.COOKIE_SECRET ?? SESSION_SECRET;
const APP_URL = requireEnv("APP_URL");
// A PRESENCE check, and the gateway's only boot-time one for INTERNAL_SECRET:
// the key-custody client reads it lazily at the first signing call, and the
// parity probe skips a peer whose secret is unset — so without this line an
// absent secret boots clean and fails at the first publish (CA-H4).
requireEnv("INTERNAL_SECRET");
// The ActivityPub signing key, if one is configured. A no-op when it is not —
// signing is a capability and the platform reads the fediverse without it —
// but a key that is SET and unusable kills the boot here rather than at the
// first outbound fetch, where it would be caught by a poll's error handling
// and spend a source's error budget on our own misconfiguration.
assertApSigningKeyUsable();

// trustProxy: 1 — exactly one trusted hop (prod: nginx; dev: the Next.js
// /api rewrite), so req.ip is the client address nginx APPENDED to
// X-Forwarded-For, and per-IP rate limiting keys per visitor instead of
// collapsing every request onto the proxy's address (one global bucket —
// six waitlist joins per minute worldwide). Never `true`: trust-all takes
// the LEFTMOST XFF entry, which the client controls (spoofable limits).
const app = Fastify({ logger: pinoConfig, trustProxy: 1 });

// The one error funnel — see the header of lib/error-handler.ts for what it
// passes through and what it swallows.
app.setErrorHandler(gatewayErrorHandler);

async function start() {
  // Plugins
  await app.register(sensible);
  await app.register(cookie, {
    secret: COOKIE_SECRET,
  });
  await app.register(cors, {
    origin: APP_URL,
    credentials: true, // allow cookies
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  });
  await app.register(multipart, {
    limits: {
      fileSize: 12 * 1024 * 1024, // 12 MB (slightly above 10 MB limit to allow overhead)
    },
  });

  // Strip client-supplied identity headers before any route handler runs.
  // These headers are set by auth middleware for downstream services —
  // they must never come from the client.
  const { stripIdentityHeaders } = await import("./middleware/auth.js");
  app.addHook("onRequest", stripIdentityHeaders);

  // Rate limiting — per-route limits on sensitive endpoints only.
  // The global blanket limit caused cascading auth failures in dev (Docker
  // containers share a single IP, exhausting the bucket on every SSR fetch).
  // Sensitive routes (signup, login, gate-pass, search, messages) keep their
  // own per-route limits registered inline.
  await app.register(rateLimit, {
    global: false,
  });

  // Every route, in one place the registry test can enumerate without a
  // database (READER-WRITER-SPLIT-ADR §4.6).
  await registerRoutes(app);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down gateway");
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Eagerly construct the AT Protocol OAuth client so a malformed
  // ATPROTO_PRIVATE_JWK surfaces at boot instead of the first OAuth-dependent
  // request. Non-fatal: Bluesky OAuth features are disabled until the JWK is
  // configured, but the rest of the gateway serves normally.
  try {
    await getAtprotoClient();
  } catch (err) {
    logger.warn(
      { err },
      "AT Protocol OAuth client failed to initialise — Bluesky OAuth disabled",
    );
  }

  const port = parseInt(process.env.PORT ?? "3000", 10);
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Gateway started");

  // Prove we hold the same shared secrets as payment / key-custody / key-service,
  // and exit if one provably differs (a drifted secret is silent and total — it
  // broke every paywalled unlock on prod for an unknown period, 2026-08-07).
  // Deliberately NOT awaited: peers start alongside us, so this retries in the
  // background while the gateway serves. Blocking here would couple all free
  // reading and auth to a money service being up. See lib/internal-parity.ts.
  void assertInternalParity();

  // Prove the outbound email credential, and keep proving it. Same dependency
  // shape as the shared secrets above and NEVER fatal — a third party can revoke
  // a token at any hour, and email dying must not take reading and auth with it.
  // Not awaited for the same reason. See shared/lib/email-health.ts: every send
  // through this gateway failed for up to seventeen days in 2026 and no surface
  // anywhere said so.
  void startEmailHealthChecks();

  // Background workers — run periodically after startup
  // Advisory locks prevent duplicate execution when horizontally scaled
  const WORKER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const LOCK_SUBSCRIPTIONS = ADVISORY_LOCKS.SUBSCRIPTIONS;
  const LOCK_DRIVES = ADVISORY_LOCKS.DRIVES;
  const LOCK_SCHEDULER = ADVISORY_LOCKS.SCHEDULER;
  const LOCK_DISCOVERY = ADVISORY_LOCKS.DISCOVERY;
  const LOCK_TRIBUTES = ADVISORY_LOCKS.TRIBUTES;
  const LOCK_FOLLOW_IMPORT = ADVISORY_LOCKS.FOLLOW_IMPORT;
  const LOCK_WAITLIST_DIGEST = ADVISORY_LOCKS.WAITLIST_DIGEST;
  const LOCK_READING_LOG = ADVISORY_LOCKS.READING_LOG;
  const LOCK_SUSPENSION_EXPIRY = ADVISORY_LOCKS.SUSPENSION_EXPIRY;
  const SCHEDULER_INTERVAL_MS = 60 * 1000; // 1 minute

  // The lock and its unlock live in shared (`withAdvisoryLock`, beside
  // withTransaction): an unlock that fails must neither replace the job's own
  // error nor hand a lock-holding connection back to the pool.
  async function withAdvisoryLock(
    lockId: number,
    name: string,
    fn: () => Promise<unknown>,
  ) {
    const ran = await withSharedAdvisoryLock(lockId, fn);
    if (!ran) logger.info(`${name}: skipped — another instance holds the lock`);
  }

  setInterval(() => {
    withAdvisoryLock(
      LOCK_SUBSCRIPTIONS,
      "Subscription expiry",
      expireAndRenewSubscriptions,
    ).catch((err) =>
      logger.error({ err }, "Subscription expiry worker failed"),
    );
    withAdvisoryLock(LOCK_DRIVES, "Drive expiry", expireOverdueDrives).catch(
      (err) => logger.error({ err }, "Drive expiry worker failed"),
    );
    // Tribute lifecycle (30d reminder + 60d lapse) — dark behind TRIBUTES_ENABLED.
    if (tributesEnabled()) {
      withAdvisoryLock(LOCK_TRIBUTES, "Tribute lifecycle", runTributeSweep).catch(
        (err) => logger.error({ err }, "Tribute lifecycle worker failed"),
      );
    }
    // Waitlist operator digest — hourly tick, but self-gated to at most one
    // send a day and only when the list moved (CLOSED-BETA-ADR §XI, D8.2).
    withAdvisoryLock(
      LOCK_WAITLIST_DIGEST,
      "Waitlist digest",
      sendWaitlistDigest,
    ).catch((err) => logger.error({ err }, "Waitlist digest worker failed"));
    // Recent-reading retention (READING-LOG-AND-LIBRARY-ADR D5). Hourly is
    // ample for a day-grained window — and it reaps reading_positions too,
    // which since migration 189 dropped its ON DELETE CASCADE has no other
    // reaper at all.
    withAdvisoryLock(
      LOCK_READING_LOG,
      "Reading-log retention",
      sweepReadingLog,
    ).catch((err) => logger.error({ err }, "Reading-log retention sweep failed"));
    // Expired magic links (login, key-export step-up, appeal) — nothing else
    // prunes the table, and it rides into every data export (CA-F10). An
    // idempotent DELETE of rows past their own expiry, so no lock is needed.
    cleanupExpiredLinks().catch((err) =>
      logger.error({ err }, "Magic-link cleanup failed"),
    );
    // The 7-day suspension rung (D7 SS5). Hourly is ample for a day-grained
    // timer, and a suspension that lifts only when somebody remembers to lift
    // it is an indefinite one wearing a shorter name.
    withAdvisoryLock(
      LOCK_SUSPENSION_EXPIRY,
      "Suspension expiry",
      sweepExpiredSuspensions,
    ).catch((err) => logger.error({ err }, "Suspension expiry sweep failed"));
  }, WORKER_INTERVAL_MS);

  setInterval(() => {
    withAdvisoryLock(
      LOCK_SCHEDULER,
      "Scheduled publishing",
      publishScheduledDrafts,
    ).catch((err) => logger.error({ err }, "Scheduler worker failed"));
    withAdvisoryLock(
      LOCK_DISCOVERY,
      "Nostr discovery sweep",
      runDiscoverySweep,
    ).catch((err) => logger.error({ err }, "Discovery sweep worker failed"));
    // Follow-graph import sweep — dark behind FOLLOW_IMPORT_ENABLED.
    if (followImportEnabled()) {
      withAdvisoryLock(
        LOCK_FOLLOW_IMPORT,
        "Follow import sweep",
        runFollowImportSweep,
      ).catch((err) => logger.error({ err }, "Follow import sweep failed"));
    }
  }, SCHEDULER_INTERVAL_MS);

  // Run once on startup
  withAdvisoryLock(
    LOCK_SUBSCRIPTIONS,
    "Subscription expiry",
    expireAndRenewSubscriptions,
  ).catch((err) =>
    logger.error({ err }, "Subscription expiry worker failed (startup)"),
  );
  withAdvisoryLock(LOCK_DRIVES, "Drive expiry", expireOverdueDrives).catch(
    (err) => logger.error({ err }, "Drive expiry worker failed (startup)"),
  );
  if (tributesEnabled()) {
    withAdvisoryLock(LOCK_TRIBUTES, "Tribute lifecycle", runTributeSweep).catch(
      (err) => logger.error({ err }, "Tribute lifecycle worker failed (startup)"),
    );
  }
  withAdvisoryLock(
    LOCK_WAITLIST_DIGEST,
    "Waitlist digest",
    sendWaitlistDigest,
  ).catch((err) => logger.error({ err }, "Waitlist digest worker failed (startup)"));
  withAdvisoryLock(
    LOCK_READING_LOG,
    "Reading-log retention",
    sweepReadingLog,
  ).catch((err) =>
    logger.error({ err }, "Reading-log retention sweep failed (startup)"),
  );
  withAdvisoryLock(
    LOCK_SUSPENSION_EXPIRY,
    "Suspension expiry",
    sweepExpiredSuspensions,
  ).catch((err) =>
    logger.error({ err }, "Suspension expiry sweep failed (startup)"),
  );
  withAdvisoryLock(
    LOCK_SCHEDULER,
    "Scheduled publishing",
    publishScheduledDrafts,
  ).catch((err) => logger.error({ err }, "Scheduler worker failed (startup)"));
  withAdvisoryLock(
    LOCK_DISCOVERY,
    "Nostr discovery sweep",
    runDiscoverySweep,
  ).catch((err) => logger.error({ err }, "Discovery sweep worker failed (startup)"));
  if (followImportEnabled()) {
    withAdvisoryLock(
      LOCK_FOLLOW_IMPORT,
      "Follow import sweep",
      runFollowImportSweep,
    ).catch((err) =>
      logger.error({ err }, "Follow import sweep failed (startup)"));
  }
}

start().catch((err) => {
  logger.error({ err }, "Failed to start gateway");
  process.exit(1);
});
