import "dotenv/config";
import {
  requireEnv,
  requireEnvMinLength,
  tributesEnabled,
} from "@platform-pub/shared/lib/env.js";
import { ADVISORY_LOCKS } from "@platform-pub/shared/lib/advisory-locks.js";
import { assertInternalParity, getParityReport } from "./lib/internal-parity.js";
import { startEmailHealthChecks } from "@platform-pub/shared/lib/email-health.js";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { authRoutes } from "./routes/auth.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { signingRoutes } from "./routes/signing.js";
import { writerRoutes } from "./routes/writers.js";
import { articleRoutes } from "./routes/articles/index.js";
import { noteRoutes } from "./routes/notes.js";
import { followRoutes } from "./routes/follows.js";
import { moderationRoutes } from "./routes/moderation.js";
import { adminDashboardRoutes } from "./routes/admin-dashboard.js";
import { rssRoutes } from "./routes/rss.js";
import { inboundMailRoutes } from "./routes/inbound-mail.js";
import { searchRoutes } from "./routes/search.js";
import { googleAuthRoutes } from "./routes/google-auth.js";
import { draftRoutes } from "./routes/drafts.js";
import { replyRoutes } from "./routes/replies.js";
import { mediaRoutes } from "./routes/media.js";
import { subscriptionRoutes } from "./routes/subscriptions/index.js";
import { expireAndRenewSubscriptions } from "./workers/subscription-expiry.js";
import { myAccountRoutes } from "./routes/my-account.js";
import { receiptRoutes } from "./routes/receipts.js";
import { exportRoutes } from "./routes/export.js";
import { notificationRoutes } from "./routes/notifications.js";
import { voteRoutes } from "./routes/votes.js";
import { historyRoutes } from "./routes/history.js";
import { giftLinkRoutes } from "./routes/gift-links.js";
import { subscriptionOfferRoutes } from "./routes/subscription-offers.js";
import { messageRoutes } from "./routes/messages.js";
import { postThreadRoutes } from "./routes/post-thread.js";
import { socialRoutes } from "./routes/social.js";
import { publicationRoutes } from "./routes/publications/index.js";
import { driveRoutes } from "./routes/drives.js";
import { upstreamEdgeRoutes } from "./routes/upstream-edges.js";
import { tributeRoutes } from "./routes/tributes.js";
import { runTributeSweep } from "./lib/tribute-sweep.js";
import { expireOverdueDrives } from "./workers/drive-expiry.js";
import { traffologyRoutes } from "./routes/traffology.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { tagRoutes } from "./routes/tags.js";
import { resolveRoutes } from "./routes/resolve.js";
import { externalFeedsRoutes } from "./routes/external-feeds.js";
import { externalItemsRoutes } from "./routes/external-items/index.js";
import { sourcesRoutes } from "./routes/sources.js";
import { linkedAccountsRoutes } from "./routes/linked-accounts.js";
import { trustRoutes } from "./routes/trust.js";
import { readingPositionRoutes } from "./routes/reading-positions.js";
import { privacyPreferencesRoutes } from "./routes/privacy-preferences.js";
import { feedsRoutes } from "./routes/feeds/index.js";
import { formulaPublicRoutes } from "./routes/feeds/formulas.js";
import { extractRoutes } from "./routes/extract.js";
import { authorCardRoutes } from "./routes/author-card.js";
import { authorRoutes } from "./routes/author.js";
import { identityLinkRoutes } from "./routes/identity-links.js";
import followImportRoutes from "./routes/follow-imports.js";
import {
  followImportEnabled,
  runFollowImportSweep,
} from "./lib/follow-import.js";
import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import { publishScheduledDrafts } from "./workers/scheduler.js";
import { sendWaitlistDigest } from "./workers/waitlist-digest.js";
import { runDiscoverySweep } from "./lib/discovery-publish.js";
import { relayForAccount } from "./lib/nostr-events.js";
import { pool } from "@platform-pub/shared/db/client.js";
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

// trustProxy: 1 — exactly one trusted hop (prod: nginx; dev: the Next.js
// /api rewrite), so req.ip is the client address nginx APPENDED to
// X-Forwarded-For, and per-IP rate limiting keys per visitor instead of
// collapsing every request onto the proxy's address (one global bucket —
// six waitlist joins per minute worldwide). Never `true`: trust-all takes
// the LEFTMOST XFF entry, which the client controls (spoofable limits).
const app = Fastify({ logger: pinoConfig, trustProxy: 1 });

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

  // Auth routes
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(googleAuthRoutes, { prefix: "/api/v1" });
  await app.register(waitlistRoutes, { prefix: "/api/v1" });

  // Signing service (event signing + NIP-44 key unwrapping)
  await app.register(signingRoutes, { prefix: "/api/v1" });

  // Writer profiles (public)
  await app.register(writerRoutes, { prefix: "/api/v1" });

  // Articles (indexing, metadata, vault/key proxies, gate pass orchestration)
  await app.register(articleRoutes, { prefix: "/api/v1" });

  // Notes (short-form content indexing)
  await app.register(noteRoutes, { prefix: "/api/v1" });

  // Drafts (auto-save, load, delete — per ADR §III.3 open question #15)
  await app.register(draftRoutes, { prefix: "/api/v1" });

  // Replies (index, threaded fetch, soft-delete, toggle)
  await app.register(replyRoutes, { prefix: "/api/v1" });

  // Media (Blossom upload proxy, oEmbed proxy)
  await app.register(mediaRoutes, { prefix: "/api/v1" });

  // Follows (follow/unfollow writers, feed filtering)
  await app.register(followRoutes, { prefix: "/api/v1" });

  // Moderation (reports, content removal, account suspension)
  await app.register(moderationRoutes, { prefix: "/api/v1" });
  await app.register(adminDashboardRoutes, { prefix: "/api/v1" });

  // Search (articles + writers, trigram-powered)
  await app.register(searchRoutes, { prefix: "/api/v1" });

  // RSS feeds (public, no auth — per ADR §II.6)
  await app.register(rssRoutes);

  // Inbound email webhook (Postmark → email newsletter ingestion)
  await app.register(inboundMailRoutes);

  // Subscriptions (subscribe, unsubscribe, check, list, pricing)
  await app.register(subscriptionRoutes, { prefix: "/api/v1" });

  // Email unsubscribe (signed token — no auth required)
  await app.register(unsubscribeRoutes, { prefix: "/api/v1" });

  // v1.6 additional routes (reading tab)
  await app.register(myAccountRoutes, { prefix: "/api/v1" });

  // Receipt portability (portable bearer proofs + platform pubkey for federation)
  await app.register(receiptRoutes, { prefix: "/api/v1" });

  // Author migration export (content keys + receipt whitelist for portability)
  await app.register(exportRoutes, { prefix: "/api/v1" });

  // Notifications (new followers, new replies)
  await app.register(notificationRoutes, { prefix: "/api/v1" });

  // Votes (upvote/downvote articles, notes, replies)
  await app.register(voteRoutes, { prefix: "/api/v1" });

  // Reading history (list previously-read articles for the current reader)
  await app.register(historyRoutes, { prefix: "/api/v1" });

  // Gift links (capped shareable access tokens for paywalled articles)
  await app.register(giftLinkRoutes, { prefix: "/api/v1" });

  // Subscription offers (discount codes and gifted subscriptions)
  await app.register(subscriptionOfferRoutes, { prefix: "/api/v1" });

  // Direct messages (NIP-17 E2E encrypted conversations)
  await app.register(messageRoutes, { prefix: "/api/v1" });

  // Post-model thread (UNIVERSAL-POST-ADR Phase 1 — GET /thread/:postId). The
  // legacy native /conversation reader was retired (FEED-RETIREMENT-PLAN Slice 6);
  // external /external-items/:id/thread reads still coexist.
  await app.register(postThreadRoutes, { prefix: "/api/v1" });

  // Social (blocks, mutes)
  await app.register(socialRoutes, { prefix: "/api/v1" });

  // Publications (multi-writer publishing groups)
  await app.register(publicationRoutes, { prefix: "/api/v1" });

  // Pledge drives (crowdfunding, commissions)
  await app.register(driveRoutes, { prefix: "/api/v1" });

  // Upstream Edges (credit / citation / dispute — UPSTREAM-EDGES-ADR Phase 1)
  await app.register(upstreamEdgeRoutes, { prefix: "/api/v1" });

  // Upstream Edges (tribute authoring + contact — Phase 2, dark behind TRIBUTES_ENABLED)
  await app.register(tributeRoutes, { prefix: "/api/v1" });

  // Traffology (writer analytics — concurrent reader counts)
  await app.register(traffologyRoutes, { prefix: "/api/v1" });

  // Bookmarks
  await app.register(bookmarkRoutes, { prefix: "/api/v1" });

  // Tags
  await app.register(tagRoutes, { prefix: "/api/v1" });

  // Universal resolver (omnivorous identity input)
  await app.register(resolveRoutes, { prefix: "/api/v1" });

  // External feed subscriptions (RSS, Nostr, Bluesky, Mastodon)
  await app.register(externalFeedsRoutes, { prefix: "/api/v1" });

  // External item interactions (live engagement, parent context)
  await app.register(externalItemsRoutes, { prefix: "/api/v1" });

  // External source surface — byline-click destination (CARD-BEHAVIOUR-ADR §VI.2)
  await app.register(sourcesRoutes, { prefix: "/api/v1" });

  // Linked accounts for outbound cross-posting (Phase 5)
  await app.register(linkedAccountsRoutes, { prefix: "/api/v1" });

  // Trust Layer 1 signals (Phase 1)
  await app.register(trustRoutes, { prefix: "/api/v1" });

  // Reading-position resumption (per-user, per-article scroll snapshot)
  await app.register(readingPositionRoutes, { prefix: "/api/v1" });

  // Privacy/sharing preferences (e.g. publish follow graph to the Nostr mesh)
  await app.register(privacyPreferencesRoutes, { prefix: "/api/v1" });

  // Readability article extraction for reader pane.
  await app.register(extractRoutes, { prefix: "/api/v1" });

  // Author card (tier-aware profile resolution for hover modals)
  await app.register(authorCardRoutes, { prefix: "/api/v1" });

  // Constructed author profile (UNIVERSAL-POST-ADR Phase 4): /author/:id/profile + /posts
  await app.register(authorRoutes, { prefix: "/api/v1" });

  // Cross-source identity links (Slice 8 P2): /author/:id/links create + unlink
  await app.register(identityLinkRoutes, { prefix: "/api/v1" });

  // Follow-graph imports (FOLLOW-GRAPH-IMPORT-ADR): POST run + progress poll.
  // Dark behind FOLLOW_IMPORT_ENABLED (routes 404 when off).
  await app.register(followImportRoutes, { prefix: "/api/v1" });

  // Workspace feeds (slice 3 — owner-private feed objects rendered by vessels).
  // Mounted under /api/v1/workspace because external-feeds.ts already owns the
  // /api/v1/feeds namespace for RSS/Mastodon/Bluesky/Nostr subscriptions.
  await app.register(feedsRoutes, { prefix: "/api/v1/workspace" });

  // Feed formulas — the public half (FEED-FORMULAS-ADR §7). GET /formulas/:token
  // is the preview a logged-out visitor opens, so it is deliberately NOT under
  // the workspace prefix. Freeze lives with the feeds plugin above; the whole
  // engine is dark behind FEED_FORMULAS_ENABLED.
  await app.register(formulaPublicRoutes, { prefix: "/api/v1" });

  // AT Protocol OAuth client metadata (discovered by Bluesky PDSes).
  // Mounted at the root so the canonical URL is
  //   https://${APP_URL}/.well-known/oauth-client-metadata.json
  app.get("/.well-known/oauth-client-metadata.json", async (_req, reply) => {
    reply
      .type("application/json")
      .header("Cache-Control", "public, max-age=3600");
    const client = await getAtprotoClient();
    return client.clientMetadata;
  });
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    reply
      .type("application/json")
      .header("Cache-Control", "public, max-age=3600");
    const client = await getAtprotoClient();
    return client.jwks;
  });

  // NIP-05 — resolve <name>@all.haus to a hex pubkey + relay hint, so outside
  // Nostr clients can add an all.haus user by handle (NOSTR-OUTBOUND-INTEROP
  // §3.2). Anonymous + unauthenticated by spec; rate-limited against
  // username→pubkey enumeration. Must send ACAO:* and must not be cached long
  // (a username change has to propagate within the redirect window).
  app.get<{ Querystring: { name?: string } }>(
    "/.well-known/nostr.json",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      reply
        .type("application/json")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");

      const name = (req.query.name ?? "").toLowerCase().trim();
      if (!name) return { names: {} };

      const { rows } = await pool.query<{
        username: string;
        nostr_pubkey: string;
        hosting_type: string | null;
        self_hosted_relay_url: string | null;
      }>(
        `SELECT username, nostr_pubkey, hosting_type, self_hosted_relay_url
           FROM accounts
          WHERE lower(username) = $1 AND status = 'active'
          LIMIT 1`,
        [name],
      );
      if (rows.length === 0) return { names: {} };

      const a = rows[0];
      return {
        names: { [a.username]: a.nostr_pubkey },
        relays: {
          [a.nostr_pubkey]: [
            relayForAccount({
              hostingType: a.hosting_type,
              selfHostedRelayUrl: a.self_hosted_relay_url,
            }),
          ],
        },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Service proxies
  //
  // The gateway forwards authenticated requests to internal services.
  // These are simple fetch-based proxies — not a full reverse proxy.
  // Auth middleware has already validated the session and injected headers.
  //
  // In production, consider @fastify/http-proxy for better performance.
  // ---------------------------------------------------------------------------

  // Health check
  //
  // Also reports shared-secret parity, which is what makes a peer redeployed
  // with a drifted secret show up as `unhealthy` in `docker compose ps` instead
  // of as nothing at all. Safe to fail here: `web` and `nginx` depend on the
  // gateway with the plain list form, NOT `condition: service_healthy`, so an
  // unhealthy gateway blocks neither, and `restart: unless-stopped` does not
  // restart on a failed healthcheck — it stays up, serving, and visibly wrong.
  //
  // Fails ONLY on a PROVEN mismatch. An unreachable peer must never flip this,
  // or an ordinary peer restart would make the gateway flap.
  app.get("/health", async (_req, reply) => {
    await pool.query("SELECT 1");
    const parity = getParityReport();
    if (!parity.ok) {
      return reply.status(503).send({
        status: "degraded",
        service: "gateway",
        error: "shared_secret_mismatch",
        peers: parity.mismatched,
      });
    }
    return { status: "ok", service: "gateway" };
  });

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
  const SCHEDULER_INTERVAL_MS = 60 * 1000; // 1 minute

  async function withAdvisoryLock(
    lockId: number,
    name: string,
    fn: () => Promise<unknown>,
  ) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [lockId],
      );
      if (!rows[0].locked) {
        logger.info(`${name}: skipped — another instance holds the lock`);
        return;
      }
      try {
        await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
      }
    } finally {
      client.release();
    }
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
