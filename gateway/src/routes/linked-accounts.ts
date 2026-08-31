import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { encryptJson, decryptJson } from "@platform-pub/shared/lib/crypto.js";
import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import { getProfile, isDid, normaliseHandle } from "../lib/atproto-resolve.js";
import {
  followImportEnabled,
  importableProtocols,
} from "../lib/follow-import.js";
import { requireAuth } from "../middleware/auth.js";
import { requireEnv } from "@platform-pub/shared/lib/env.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Linked Accounts (Phase 5 — outbound reply router)
//
// GET    /linked-accounts              — list current user's linked accounts
// DELETE /linked-accounts/:id          — disconnect one
// PATCH  /linked-accounts/:id          — update cross_post_default / show_on_profile
// POST   /linked-accounts/mastodon     — begin Mastodon OAuth flow (returns authorize URL)
// POST   /linked-accounts/mastodon/assisted — "set one up for me" (ASSISTED, §9)
// GET    /linked-accounts/callback     — Mastodon OAuth callback (linked + assisted)
// POST   /linked-accounts/bluesky      — begin AT Protocol OAuth flow (returns authorize URL)
// GET    /linked-accounts/bluesky/callback — AT Protocol OAuth callback
//
// Bluesky uses @atproto/oauth-client-node (PKCE + DPoP + PAR). The library
// handles all crypto and stores session state in atproto_oauth_sessions via
// our DB-backed SimpleStore (see shared/src/lib/atproto-oauth.ts).
//
// External Nostr outbound uses the user's custodial key via key-custody (no
// OAuth; enqueueNostrOutbound handles relay publishing directly).
// =============================================================================

const APP_URL = requireEnv("APP_URL");
// Callback is the user's own browser returning to all.haus, so we can piggy-back
// on the existing session cookie. The Fastify cookie plugin signs state with
// SESSION_SECRET automatically when `signed: true` is set.
const CALLBACK_PATH = "/api/v1/linked-accounts/callback";

const MASTODON_SCOPES = "read:accounts write:statuses";
const CLIENT_NAME = "all.haus";

// ASSISTED atproto (NETWORK-CONCIERGE-ADR §6.1, Phase 2). The "set one up for
// me" path reuses the LINKED OAuth machinery verbatim — the only deltas are
// seeding authorize() with a PDS hostname (so Bluesky renders native signup
// mid-flow) and the provenance written. Ships dark behind ATPROTO_ASSISTED_ENABLED.
const ATPROTO_DEFAULT_PDS =
  process.env.ATPROTO_DEFAULT_PDS?.trim() || "https://bsky.social";
const ATPROTO_SCOPE = "atproto transition:generic";
const assistedEnabled = () => process.env.ATPROTO_ASSISTED_ENABLED === "1";

// State-cookie lifetimes. LINKED is a quick "log in + approve" (10 min is ample).
// ASSISTED makes the user create a whole account mid-flow — handle, email,
// captcha, ToS — which routinely exceeds 10 min, so its state cookie must live
// long enough to survive that or the callback silently drops the round-trip
// (the cookie guard returns before the logging try/catch). Must stay <= the
// DbStateStore TTL in shared/src/lib/atproto-oauth.ts, which client.callback()
// reads for the PKCE verifier + DPoP key.
const OAUTH_COOKIE_TTL_SECONDS = 600; // 10 min — LINKED
const ASSISTED_OAUTH_COOKIE_TTL_SECONDS = 30 * 60; // 30 min — ASSISTED signup

// ASSISTED activitypub (NETWORK-CONCIERGE-ADR §9, Phase 3). Mastodon has no
// bsky.social-equivalent default, so the hand-off targets a curated allowlist
// of open-registration instances (first entry is the default). Unlike atproto
// there is no signup *inside* the OAuth screen: /oauth/authorize stores its own
// URL as the post-login destination (Doorkeeper store_location_for), the user
// signs up → confirms email → logs in on the instance, and Mastodon's
// after_sign_in_path_for resumes the stored authorize round-trip. Verified
// against mastodon/mastodon main (2026-06-11). Ships dark behind
// MASTODON_ASSISTED_ENABLED.
const mastodonAssistedEnabled = () =>
  process.env.MASTODON_ASSISTED_ENABLED === "1";
const mastodonAssistedInstances = (): string[] =>
  (process.env.MASTODON_ASSISTED_INSTANCES ?? "mastodon.social")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
// Signup + email confirmation + first login routinely outlasts even the 30-min
// atproto window. The cookie is the only flow state here (plain code exchange,
// no PKCE state store to expire under us), so it can be generous.
const ASSISTED_MASTODON_COOKIE_TTL_SECONDS = 60 * 60; // 60 min

// ---- Mastodon API shapes we care about --------------------------------------

interface MastodonAppResponse {
  id: string;
  client_id: string;
  client_secret: string;
}

interface MastodonTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  created_at: number;
}

interface MastodonVerifyCredentialsResponse {
  id: string;
  username: string;
  acct: string; // user@instance for remote, user for local
  display_name: string;
  avatar: string;
  url: string;
  // The post-link import offer's count (FOLLOW-GRAPH-IMPORT-ADR §7.1) —
  // free because this call already happens.
  following_count?: number;
}

// ---- Route handlers ---------------------------------------------------------

export async function linkedAccountsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /linked-accounts — list user's linked accounts (public-safe fields only)
  // ---------------------------------------------------------------------------

  app.get("/linked-accounts", { preHandler: requireAuth }, async (req) => {
    const userId = req.session!.sub;
    const { rows } = await pool.query<{
      id: string;
      protocol: string;
      provenance: string;
      lifecycle_state: string;
      external_id: string;
      handle: string | null;
      service_url: string | null;
      is_valid: boolean;
      cross_post_default: boolean;
      show_on_profile: boolean;
      token_expires_at: Date | null;
      created_at: Date;
    }>(
      `
      SELECT id, protocol, provenance, lifecycle_state, external_id,
             handle, service_url,
             is_valid, cross_post_default, show_on_profile,
             token_expires_at, created_at
      FROM network_presences
      WHERE account_id = $1
      ORDER BY created_at DESC
    `,
      [userId],
    );

    return {
      accounts: rows.map((r) => ({
        id: r.id,
        protocol: r.protocol,
        provenance: r.provenance,
        lifecycleState: r.lifecycle_state,
        externalId: r.external_id,
        externalHandle: r.handle,
        instanceUrl: r.service_url,
        isValid: r.is_valid,
        crossPostDefault: r.cross_post_default,
        showOnProfile: r.show_on_profile,
        tokenExpiresAt: r.token_expires_at,
        createdAt: r.created_at,
      })),
      // Single source of truth for the dark-ship flags so the UI shows the
      // ASSISTED affordances only when the server can honour them (§6.1.1 S6).
      capabilities: {
        assistedBluesky: assistedEnabled(),
        assistedMastodon: mastodonAssistedEnabled(),
        // Curated open-registration instances for the ASSISTED hand-off (§9);
        // first entry is the default. Empty while the flag is dark.
        assistedMastodonInstances: mastodonAssistedEnabled()
          ? mastodonAssistedInstances()
          : [],
        // Follow-graph import (FOLLOW-GRAPH-IMPORT-ADR §7): the protocols
        // whose remote graph the import engine can read today. Empty while
        // the master switch is dark; activitypub additionally rides its §6.6
        // sub-brake (FOLLOW_IMPORT_ACTIVITYPUB_ENABLED) pending the §6.4
        // fairness soak.
        followImportProtocols: followImportEnabled()
          ? importableProtocols()
          : [],
        // OPML upload (Phase 1d) — deliberately NOT an entry in
        // followImportProtocols: that list gates the "import this account's
        // follows" affordances on resolver matches, and a plain rss feed URL
        // has no follow graph to read. The upload surface gates on this flag.
        followImportOpml: followImportEnabled(),
      },
    };
  });

  // ---------------------------------------------------------------------------
  // DELETE /linked-accounts/:id — disconnect
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    "/linked-accounts/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { rowCount } = await pool.query(
        `DELETE FROM network_presences WHERE id = $1 AND account_id = $2`,
        [req.params.id, userId],
      );
      if (rowCount === 0) return reply.status(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /linked-accounts/:id — update cross_post_default / show_on_profile
  //
  // Two independent consents, deliberately not one: cross_post_default consents
  // to POSTING through this presence, show_on_profile consents to DISPLAYING it
  // on the profile's identity row (PROFILE-PANE-REDESIGN-ADR D7). The profile
  // pages are SSR'd share/SEO surfaces, so collapsing the two would make every
  // OAuth link retroactively public. Either field may be sent alone; at least
  // one must be.
  // ---------------------------------------------------------------------------

  app.patch<{
    Params: { id: string };
    Body: { crossPostDefault?: boolean; showOnProfile?: boolean };
  }>(
    "/linked-accounts/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const body = z
        .object({
          crossPostDefault: z.boolean().optional(),
          showOnProfile: z.boolean().optional(),
        })
        .refine(
          (b) =>
            b.crossPostDefault !== undefined || b.showOnProfile !== undefined,
          { message: "Nothing to update" },
        )
        .safeParse(req.body);
      if (!body.success)
        return reply.status(400).send(zodValidationError(body.error));

      // COALESCE($3/$4, column) — an omitted field leaves its consent alone
      // rather than silently resetting the other one to a default.
      const { rowCount } = await pool.query(
        `UPDATE network_presences
           SET cross_post_default = COALESCE($3, cross_post_default),
               show_on_profile    = COALESCE($4, show_on_profile),
               updated_at = now()
         WHERE id = $1 AND account_id = $2`,
        [
          req.params.id,
          userId,
          body.data.crossPostDefault ?? null,
          body.data.showOnProfile ?? null,
        ],
      );
      if (rowCount === 0) return reply.status(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/mastodon — begin OAuth flow
  //
  // Body: { instanceUrl }
  // Returns: { authorizeUrl } — the frontend redirects the user there.
  //
  // Steps:
  //   1. Validate instance URL (must be https, non-private IP — safeFetch enforces)
  //   2. Look up or register OAuth app for that instance
  //   3. Generate a signed state cookie (nonce + instanceUrl)
  //   4. Return the authorize URL
  // ---------------------------------------------------------------------------

  app.post<{ Body: { instanceUrl: string } }>(
    "/linked-accounts/mastodon",
    { preHandler: requireAuth },
    async (req, reply) => {
      const schema = z.object({ instanceUrl: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success)
        return reply.status(400).send({ error: parsed.error.flatten() });

      let instance: URL;
      try {
        instance = new URL(
          parsed.data.instanceUrl.startsWith("http")
            ? parsed.data.instanceUrl
            : `https://${parsed.data.instanceUrl}`,
        );
      } catch {
        return reply.status(400).send({ error: "Invalid instance URL" });
      }
      if (instance.protocol !== "https:") {
        return reply.status(400).send({ error: "Instance must use https" });
      }
      const instanceOrigin = instance.origin;

      const redirectUri = `${APP_URL}${CALLBACK_PATH}`;

      // Find or register app credentials for this instance.
      let appCreds: { clientId: string; clientSecret: string };
      try {
        appCreds = await getOrRegisterMastodonApp(instanceOrigin, redirectUri);
      } catch (err) {
        logger.warn(
          { err, instance: instanceOrigin },
          "Mastodon app registration failed",
        );
        return reply
          .status(502)
          .send({ error: "Could not register with that Mastodon instance" });
      }

      // Signed state cookie — ties the callback to this user + instance + protocol.
      const userId = req.session!.sub;
      const nonce = crypto.randomBytes(16).toString("hex");
      reply.setCookie(
        "oauth_state_mastodon",
        JSON.stringify({
          protocol: "activitypub",
          instance: instanceOrigin,
          nonce,
          userId,
          provenance: "linked",
        }),
        {
          signed: true,
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: APP_URL.startsWith("https://"),
          maxAge: OAUTH_COOKIE_TTL_SECONDS,
        },
      );

      return {
        authorizeUrl: buildMastodonAuthorizeUrl(
          instanceOrigin,
          appCreds.clientId,
          redirectUri,
          nonce,
        ),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/mastodon/assisted — "set one up for me" (ASSISTED)
  //
  // Body: { instance? } — hostname from the curated allowlist (defaults to its
  // first entry). Reuses the LINKED OAuth flow (§9): we send the user straight
  // to /oauth/authorize on an open-registration instance. Logged out, Mastodon
  // stores that URL as the post-login destination and bounces to sign-in, where
  // the user creates the account (signup → email confirm → log in); signing in
  // resumes the stored authorize round-trip back to our shared callback. The
  // instance custodies the account; we only hold the OAuth grant — identical to
  // LINKED bar the provenance label in the state cookie.
  // ---------------------------------------------------------------------------

  app.post<{ Body: { instance?: string } }>(
    "/linked-accounts/mastodon/assisted",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!mastodonAssistedEnabled()) {
        return reply
          .status(503)
          .send({ error: "Assisted setup is not available yet" });
      }
      const userId = req.session!.sub;
      const parsed = z
        .object({ instance: z.string().min(1).max(256).optional() })
        .safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.status(400).send({ error: parsed.error.flatten() });

      const allowed = mastodonAssistedInstances();
      const requested = parsed.data.instance
        ?.trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "");
      const host = requested || allowed[0];
      if (!host || !allowed.includes(host)) {
        return reply
          .status(400)
          .send({ error: "That instance is not available for assisted setup" });
      }
      const instanceOrigin = `https://${host}`;

      // Live guard: never hand the user off to a signup that is closed or
      // approval-gated — the round-trip would dead-end on their side.
      try {
        const res = await safeFetch(`${instanceOrigin}/api/v2/instance`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`instance API HTTP ${res.status}`);
        const info = JSON.parse(res.text) as {
          registrations?: { enabled?: boolean; approval_required?: boolean };
        };
        if (
          !info.registrations?.enabled ||
          info.registrations.approval_required
        ) {
          return reply.status(409).send({
            error: `${host} is not accepting open signups right now — try linking an existing account instead`,
          });
        }
      } catch (err) {
        logger.warn(
          { err, instance: instanceOrigin },
          "Mastodon assisted: registration check failed",
        );
        return reply.status(502).send({
          error: "Could not verify signup is open — try again shortly",
        });
      }

      const redirectUri = `${APP_URL}${CALLBACK_PATH}`;
      let appCreds: { clientId: string; clientSecret: string };
      try {
        appCreds = await getOrRegisterMastodonApp(instanceOrigin, redirectUri);
      } catch (err) {
        logger.warn(
          { err, instance: instanceOrigin },
          "Mastodon app registration failed",
        );
        return reply
          .status(502)
          .send({ error: "Could not register with that Mastodon instance" });
      }

      const nonce = crypto.randomBytes(16).toString("hex");
      reply.setCookie(
        "oauth_state_mastodon",
        JSON.stringify({
          protocol: "activitypub",
          instance: instanceOrigin,
          nonce,
          userId,
          provenance: "assisted",
        }),
        {
          signed: true,
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: APP_URL.startsWith("https://"),
          maxAge: ASSISTED_MASTODON_COOKIE_TTL_SECONDS,
        },
      );

      return {
        authorizeUrl: buildMastodonAuthorizeUrl(
          instanceOrigin,
          appCreds.clientId,
          redirectUri,
          nonce,
        ),
      };
    },
  );

  // ---------------------------------------------------------------------------
  // GET /linked-accounts/callback — handles Mastodon OAuth return
  //
  // Reads the state cookie, exchanges the code for a token, fetches the
  // user's external identity, and upserts network_presences.
  // Always redirects to /settings with a query flag indicating outcome.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/linked-accounts/callback",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { code, state, error } = req.query;

      const redirectOk = (flag: string) =>
        reply.redirect(
          `${APP_URL}/settings?linked=${encodeURIComponent(flag)}`,
        );

      if (error || !code || !state) {
        return redirectOk("error");
      }

      // Verify signed state cookie
      const rawCookie = req.cookies.oauth_state_mastodon;
      if (!rawCookie) return redirectOk("error");
      const unsigned = reply.unsignCookie(rawCookie);
      if (!unsigned.valid || !unsigned.value) return redirectOk("error");
      reply.clearCookie("oauth_state_mastodon", { path: "/" });

      let statePayload: {
        protocol: string;
        instance: string;
        nonce: string;
        userId?: string;
        provenance?: string;
      };
      try {
        statePayload = JSON.parse(unsigned.value);
      } catch {
        return redirectOk("error");
      }
      if (statePayload.nonce !== state) return redirectOk("error");

      if (statePayload.protocol !== "activitypub") {
        return redirectOk("error");
      }
      // Tie the returning browser to the account that started the flow
      // (optional for back-compat with cookies minted before the field existed).
      if (statePayload.userId && statePayload.userId !== userId) {
        return redirectOk("error");
      }

      // The state cookie is the only channel that survives the redirect to tell
      // this shared callback which flow returned (§9, mirroring §6.1.1 S3).
      const provenance =
        statePayload.provenance === "assisted" ? "assisted" : "linked";

      try {
        const { clientId, clientSecret } = await getStoredMastodonApp(
          statePayload.instance,
        );
        const redirectUri = `${APP_URL}${CALLBACK_PATH}`;
        const token = await exchangeMastodonCode({
          instance: statePayload.instance,
          clientId,
          clientSecret,
          code,
          redirectUri,
        });
        const profile = await fetchMastodonProfile(
          statePayload.instance,
          token.access_token,
        );

        const credentialsEnc = encryptJson({
          accessToken: token.access_token,
          tokenType: token.token_type,
          scope: token.scope,
        });

        await pool.query(
          `
          INSERT INTO network_presences (
            account_id, protocol, provenance, external_id, handle,
            service_url, credentials_enc, is_valid,
            last_refreshed_at, updated_at
          ) VALUES ($1, 'activitypub', $6, $2, $3, $4, $5, TRUE, now(), now())
          ON CONFLICT (account_id, protocol)
          DO UPDATE SET
            external_id       = EXCLUDED.external_id,
            handle            = EXCLUDED.handle,
            service_url       = EXCLUDED.service_url,
            credentials_enc   = EXCLUDED.credentials_enc,
            provenance        = EXCLUDED.provenance,
            lifecycle_state   = 'active',
            is_valid          = TRUE,
            last_refreshed_at = now(),
            updated_at        = now()
        `,
          [
            userId,
            profile.id,
            profile.acct.includes("@")
              ? profile.acct
              : `${profile.username}@${new URL(statePayload.instance).hostname}`,
            statePayload.instance,
            credentialsEnc,
            provenance,
          ],
        );

        logger.info(
          {
            userId,
            instance: statePayload.instance,
            externalId: profile.id,
            provenance,
          },
          "Mastodon account linked",
        );
        // The follow count rides the same ?linked= redirect channel the
        // connect banner reads (§7.1), mirroring the Bluesky callback — only
        // while AP import is live (incl. the §6.6 sub-brake), so nothing
        // leaks while it's dark.
        const qs = new URLSearchParams({ linked: "mastodon" });
        if (
          importableProtocols().includes("activitypub") &&
          typeof profile.following_count === "number"
        )
          qs.set("follows", String(profile.following_count));
        return reply.redirect(`${APP_URL}/settings?${qs.toString()}`);
      } catch (err) {
        // 23505 = the (protocol, external_id) unique index (migration 115):
        // another account already links this identity. Reject cleanly rather
        // than clobbering the existing presence.
        if ((err as { code?: string })?.code === "23505") {
          logger.info(
            { userId },
            "Mastodon link rejected — identity already linked to another account",
          );
          return redirectOk("already-linked");
        }
        logger.warn({ err, userId }, "Mastodon OAuth callback failed");
        return redirectOk("error");
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/bluesky — begin AT Protocol OAuth flow
  //
  // Body: { handle }  — a Bluesky handle or DID (bsky.app/profile/... accepted)
  // Returns: { authorizeUrl } — frontend redirects the user.
  //
  // NodeOAuthClient.authorize() takes an identifier (handle or DID), resolves
  // it to a PDS + authorization server, does PAR + PKCE + DPoP, and returns
  // the URL to send the user to.
  // ---------------------------------------------------------------------------

  app.post<{ Body: { handle: string } }>(
    "/linked-accounts/bluesky",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const parsed = z
        .object({ handle: z.string().min(1).max(256) })
        .safeParse(req.body);
      if (!parsed.success)
        return reply.status(400).send({ error: parsed.error.flatten() });

      let identifier = parsed.data.handle.trim();
      try {
        const asUrl = new URL(identifier);
        if (
          asUrl.hostname === "bsky.app" ||
          asUrl.hostname === "staging.bsky.app"
        ) {
          const m = asUrl.pathname.match(/^\/profile\/([^\/]+)/);
          if (m) identifier = decodeURIComponent(m[1]);
        }
      } catch {
        // not a URL, treat as handle
      }
      if (!isDid(identifier)) identifier = normaliseHandle(identifier);

      // Stash the user id in a signed cookie so the callback can find them.
      // (State also flows through NodeOAuthClient, but the callback needs to
      // know which all.haus account to attach the DID to.)
      const nonce = crypto.randomBytes(16).toString("hex");
      reply.setCookie(
        "oauth_state_bluesky",
        JSON.stringify({
          protocol: "atproto",
          userId,
          nonce,
          provenance: "linked",
        }),
        {
          signed: true,
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: APP_URL.startsWith("https://"),
          maxAge: OAUTH_COOKIE_TTL_SECONDS,
        },
      );

      try {
        const client = await getAtprotoClient();
        const url = await client.authorize(identifier, {
          state: nonce,
          scope: ATPROTO_SCOPE,
        });
        return { authorizeUrl: url.toString() };
      } catch (err) {
        logger.warn({ err, identifier }, "Bluesky OAuth authorize() failed");
        return reply
          .status(502)
          .send({
            error: "Could not start Bluesky OAuth — check the handle is valid",
          });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /linked-accounts/bluesky/assisted — "set one up for me" (ASSISTED)
  //
  // No body. Reuses the LINKED OAuth flow (§6.1.1 S1) but seeds authorize()
  // with the PDS hostname instead of a user handle, so Bluesky renders its own
  // native signup (handle, ToS, anti-abuse) mid-redirect and returns already
  // authorized. Bluesky custodies the keys; we only hold the OAuth grant — so
  // the shared callback (and the outbound dispatcher) treat it exactly like a
  // linked account, differing only by the provenance label in the state cookie.
  // ---------------------------------------------------------------------------

  app.post(
    "/linked-accounts/bluesky/assisted",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!assistedEnabled()) {
        return reply
          .status(503)
          .send({ error: "Assisted setup is not available yet" });
      }
      const userId = req.session!.sub;

      const nonce = crypto.randomBytes(16).toString("hex");
      reply.setCookie(
        "oauth_state_bluesky",
        JSON.stringify({
          protocol: "atproto",
          userId,
          nonce,
          provenance: "assisted",
        }),
        {
          signed: true,
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: APP_URL.startsWith("https://"),
          maxAge: ASSISTED_OAUTH_COOKIE_TTL_SECONDS,
        },
      );

      try {
        const client = await getAtprotoClient();
        // Seed with the PDS hostname, not a handle — atproto account-creation-
        // in-flow (§2). The installed oauth-client resolver accepts a PDS URL.
        const url = await client.authorize(ATPROTO_DEFAULT_PDS, {
          state: nonce,
          scope: ATPROTO_SCOPE,
        });
        return { authorizeUrl: url.toString() };
      } catch (err) {
        logger.warn(
          { err, pds: ATPROTO_DEFAULT_PDS },
          "Bluesky assisted authorize() failed",
        );
        return reply
          .status(502)
          .send({ error: "Could not start Bluesky setup — try again shortly" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /linked-accounts/bluesky/callback — AT Protocol OAuth return
  //
  // NodeOAuthClient.callback(params) verifies state, exchanges code (with DPoP
  // proof), stores the session via our SessionStore, and returns the OAuthSession.
  // We then look up the user from the signed cookie and insert a network_presences
  // row (provenance 'linked') with external_id = did, credentials_enc = NULL (the
  // @atproto lib owns the token storage in atproto_oauth_sessions).
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: Record<string, string> }>(
    "/linked-accounts/bluesky/callback",
    { preHandler: requireAuth },
    async (req, reply) => {
      const redirectOk = (flag: string) =>
        reply.redirect(
          `${APP_URL}/settings?linked=${encodeURIComponent(flag)}`,
        );

      // Read + verify our cookie first — it carries the all.haus user id.
      const rawCookie = req.cookies.oauth_state_bluesky;
      if (!rawCookie) return redirectOk("error");
      const unsigned = reply.unsignCookie(rawCookie);
      if (!unsigned.valid || !unsigned.value) return redirectOk("error");
      reply.clearCookie("oauth_state_bluesky", { path: "/" });

      let statePayload: {
        protocol: string;
        userId: string;
        nonce: string;
        provenance?: string;
      };
      try {
        statePayload = JSON.parse(unsigned.value);
      } catch {
        return redirectOk("error");
      }
      if (statePayload.protocol !== "atproto") return redirectOk("error");

      const userId = req.session!.sub;
      if (statePayload.userId !== userId) return redirectOk("error");

      // The state cookie is the only channel that survives the redirect to tell
      // this shared callback which flow returned (§6.1.1 S3). Default to
      // 'linked' for back-compat with cookies minted before this column existed.
      const provenance =
        statePayload.provenance === "assisted" ? "assisted" : "linked";

      try {
        const client = await getAtprotoClient();
        const params = new URLSearchParams(req.query);
        // The @atproto client puts its OWN generated nonce in the OAuth `state`
        // query param and verifies it internally (against its stateStore). The
        // value we passed via authorize({ state: nonce }) comes back as the
        // returned application state — NOT as req.query.state. So our CSRF tie
        // must compare the *returned* appState to our cookie nonce; comparing
        // req.query.state would never match and silently drop every callback.
        const { session, state: appState } = await client.callback(params);
        if (appState !== statePayload.nonce) return redirectOk("error");
        const did = session.did;

        // Pull handle/display name from the AppView for a nicer handle. The
        // same response carries followsCount — the post-link import offer's
        // count (FOLLOW-GRAPH-IMPORT-ADR §7.1), free because this call already
        // happens.
        let handle: string = did;
        let followsCount: number | undefined;
        try {
          const profile = await getProfile(did);
          if (profile?.handle) handle = profile.handle;
          followsCount = profile?.followsCount;
        } catch {
          // non-fatal
        }

        await pool.query(
          `
          INSERT INTO network_presences (
            account_id, protocol, provenance, external_id, handle,
            service_url, credentials_enc, is_valid,
            last_refreshed_at, updated_at
          ) VALUES ($1, 'atproto', $4, $2, $3, NULL, NULL, TRUE, now(), now())
          ON CONFLICT (account_id, protocol)
          DO UPDATE SET
            external_id       = EXCLUDED.external_id,
            handle            = EXCLUDED.handle,
            provenance        = EXCLUDED.provenance,
            lifecycle_state   = 'active',
            is_valid          = TRUE,
            last_refreshed_at = now(),
            updated_at        = now()
        `,
          [userId, did, handle, provenance],
        );

        logger.info(
          { userId, did, handle, provenance },
          "Bluesky account linked",
        );
        // The follow count rides the same ?linked= redirect channel the
        // connect banner reads (§7.1); only while the import feature is live,
        // so nothing leaks while the flag is dark.
        const qs = new URLSearchParams({ linked: "bluesky" });
        if (followImportEnabled() && followsCount !== undefined)
          qs.set("follows", String(followsCount));
        return reply.redirect(`${APP_URL}/settings?${qs.toString()}`);
      } catch (err) {
        // 23505 = the (protocol, external_id) unique index (migration 115):
        // another account already links this DID. Reject cleanly rather than
        // clobbering the existing presence (and its shared OAuth session).
        if ((err as { code?: string })?.code === "23505") {
          logger.info(
            { userId },
            "Bluesky link rejected — DID already linked to another account",
          );
          return redirectOk("already-linked");
        }
        logger.warn({ err }, "Bluesky OAuth callback failed");
        return redirectOk("error");
      }
    },
  );
}

// =============================================================================
// Mastodon OAuth helpers
// =============================================================================

function buildMastodonAuthorizeUrl(
  instanceOrigin: string,
  clientId: string,
  redirectUri: string,
  nonce: string,
): string {
  const authorizeUrl = new URL(`${instanceOrigin}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", MASTODON_SCOPES);
  authorizeUrl.searchParams.set("state", nonce);
  return authorizeUrl.toString();
}

async function getOrRegisterMastodonApp(
  instance: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const { rows } = await pool.query<{
    client_id: string;
    client_secret_enc: string;
  }>(
    `SELECT client_id, client_secret_enc
     FROM oauth_app_registrations
     WHERE protocol = 'activitypub' AND instance_url = $1`,
    [instance],
  );
  if (rows[0]) {
    return {
      clientId: rows[0].client_id,
      clientSecret: decryptJson<string>(rows[0].client_secret_enc),
    };
  }

  const res = await safeFetch(`${instance}/api/v1/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: redirectUri,
      scopes: MASTODON_SCOPES,
      website: APP_URL,
    }),
  });
  if (!res.ok) throw new Error(`App registration HTTP ${res.status}`);

  const body = JSON.parse(res.text) as MastodonAppResponse;
  if (!body.client_id || !body.client_secret) {
    throw new Error("App registration missing client_id/client_secret");
  }

  await pool.query(
    `
    INSERT INTO oauth_app_registrations (
      protocol, instance_url, client_id, client_secret_enc, scopes, redirect_uri
    ) VALUES ('activitypub', $1, $2, $3, $4, $5)
    ON CONFLICT (protocol, instance_url) DO NOTHING
  `,
    [
      instance,
      body.client_id,
      encryptJson(body.client_secret),
      MASTODON_SCOPES,
      redirectUri,
    ],
  );

  return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function getStoredMastodonApp(
  instance: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const { rows } = await pool.query<{
    client_id: string;
    client_secret_enc: string;
  }>(
    `SELECT client_id, client_secret_enc
     FROM oauth_app_registrations
     WHERE protocol = 'activitypub' AND instance_url = $1`,
    [instance],
  );
  if (!rows[0]) throw new Error("App registration not found");
  return {
    clientId: rows[0].client_id,
    clientSecret: decryptJson<string>(rows[0].client_secret_enc),
  };
}

async function exchangeMastodonCode(params: {
  instance: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<MastodonTokenResponse> {
  const res = await safeFetch(`${params.instance}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      scope: MASTODON_SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange HTTP ${res.status}`);
  return JSON.parse(res.text) as MastodonTokenResponse;
}

async function fetchMastodonProfile(
  instance: string,
  accessToken: string,
): Promise<MastodonVerifyCredentialsResponse> {
  const res = await safeFetch(
    `${instance}/api/v1/accounts/verify_credentials`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!res.ok) throw new Error(`verify_credentials HTTP ${res.status}`);
  return JSON.parse(res.text) as MastodonVerifyCredentialsResponse;
}
