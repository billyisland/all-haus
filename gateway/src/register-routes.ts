import type { FastifyInstance } from "fastify";
import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import { pool } from "@platform-pub/shared/db/client.js";
import { getParityReport } from "./lib/internal-parity.js";
import { relayForAccount } from "./lib/nostr-events.js";
import { authRoutes } from "./routes/auth.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { writerApplicationRoutes } from "./routes/writer-applications.js";
import { instanceActorRoutes } from "./routes/instance-actor.js";
import { signingRoutes } from "./routes/signing.js";
import { writerRoutes } from "./routes/writers.js";
import { articleRoutes } from "./routes/articles/index.js";
import { noteRoutes } from "./routes/notes.js";
import { followRoutes } from "./routes/follows.js";
import { adminDashboardRoutes } from "./routes/admin-dashboard.js";
import { rssRoutes } from "./routes/rss.js";
import { inboundMailRoutes } from "./routes/inbound-mail.js";
import { searchRoutes } from "./routes/search.js";
import { googleAuthRoutes } from "./routes/google-auth.js";
import { draftRoutes } from "./routes/drafts.js";
import { replyRoutes } from "./routes/replies.js";
import { mediaRoutes } from "./routes/media.js";
import { subscriptionRoutes } from "./routes/subscriptions/index.js";
import { myAccountRoutes } from "./routes/my-account.js";
import { receiptRoutes } from "./routes/receipts.js";
import { publishedFiguresRoutes } from "./routes/published-figures.js";
import { exportRoutes } from "./routes/export.js";
import { notificationRoutes } from "./routes/notifications.js";
import { voteRoutes } from "./routes/votes.js";
import { libraryRoutes } from "./routes/library.js";
import { readingLogRoutes } from "./routes/reading-log.js";
import { giftLinkRoutes } from "./routes/gift-links.js";
import { subscriptionOfferRoutes } from "./routes/subscription-offers.js";
import { messageRoutes } from "./routes/messages.js";
import { postThreadRoutes } from "./routes/post-thread.js";
import { socialRoutes } from "./routes/social.js";
import { publicationRoutes } from "./routes/publications/index.js";
import { driveRoutes } from "./routes/drives.js";
import { upstreamEdgeRoutes } from "./routes/upstream-edges.js";
import { tributeRoutes } from "./routes/tributes.js";
import { traffologyRoutes } from "./routes/traffology.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";
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
import { moderationRoutes } from "./routes/moderation.js";

// =============================================================================
// Every route the gateway serves, registered in one function
//
// Extracted from `index.ts` (READER-WRITER-SPLIT-ADR §4.6) so a test can build
// a bare Fastify, register everything through here, collect the route table
// with an `onRoute` hook, and never boot a database. `gateway/tests/
// route-classes.test.ts` does exactly that: every route must be classified
// (`writer`, `money-out`, `money-in-to-account` or `neither`) in
// `gateway/tests/route-classes.ts`, and an unclassified one fails CI.
//
// `index.ts` owns everything that is not a route — plugins, hooks, workers,
// boot checks — and calls this once, after the plugins and before listen.
// =============================================================================

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Auth routes
  await app.register(authRoutes, { prefix: "/api/v1" });
  await app.register(googleAuthRoutes, { prefix: "/api/v1" });
  await app.register(waitlistRoutes, { prefix: "/api/v1" });
  await app.register(writerApplicationRoutes, { prefix: "/api/v1" });

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

  // The dials the public pages name (About), never typed into their copy
  await app.register(publishedFiguresRoutes, { prefix: "/api/v1" });

  // Author migration export (content keys + receipt whitelist for portability)
  await app.register(exportRoutes, { prefix: "/api/v1" });

  // Notifications (new followers, new replies)
  await app.register(notificationRoutes, { prefix: "/api/v1" });

  // Votes (upvote/downvote articles, notes, replies)
  await app.register(voteRoutes, { prefix: "/api/v1" });

  // Reading history (list previously-read articles for the current reader)
  await app.register(libraryRoutes, { prefix: "/api/v1" });
  await app.register(readingLogRoutes, { prefix: "/api/v1" });

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

  // The instance actor + its WebFinger entry — the public half of outbound
  // HTTP Signatures. Root-mounted (no `/api/` prefix): the URL is what our own
  // `keyId` names, and a remote verifier fetches it from the open internet.
  // `routes/instance-actor.ts` carries the reasoning.
  await app.register(instanceActorRoutes);

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
}
