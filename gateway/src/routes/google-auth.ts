import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { provisionAccount } from "../lib/account-provision.js";
import { createSession } from "@platform-pub/shared/auth/session.js";
import { getAccount } from "@platform-pub/shared/auth/accounts.js";
import { invalidateAuthCache } from "../middleware/auth.js";
import { CLOSED_BETA, CLOSED_BETA_ERROR } from "../lib/closed-beta.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { randomBytes, createHmac, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

// =============================================================================
// Google OAuth Routes
//
// GET  /auth/google          — redirect to Google's consent screen
// POST /auth/google/exchange — called by the frontend callback page after
//                              Google redirects back; validates state, exchanges
//                              code, finds the account, sets session cookie.
//                              Closed beta: an unknown email is refused with
//                              403 closed_beta, never provisioned (D1).
//
// Flow:
//   1. Browser clicks "Continue with Google" → GET /api/v1/auth/google
//   2. Gateway generates an HMAC-signed state, redirects to Google
//   3. Google redirects to ${APP_URL}/auth/google/callback (Next.js page)
//   4. That page POSTs { code, state } to /api/v1/auth/google/exchange
//   5. Gateway verifies state HMAC, exchanges code, sets pp_session cookie
//   6. Page calls /auth/me to hydrate the store, then navigates to /feed
//
// State is verified by HMAC signature (not a cookie) because Next.js rewrite
// proxies do not reliably forward Set-Cookie headers in redirect responses.
// =============================================================================

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const STATE_MAX_AGE_SECONDS = 600;
const consumedNonces = new Map<string, number>();

setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - STATE_MAX_AGE_SECONDS;
  for (const [nonce, ts] of consumedNonces) {
    if (ts < cutoff) consumedNonces.delete(nonce);
  }
}, 60_000).unref();

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL ?? "https://all.haus";

  // The redirect_uri must point to the Next.js callback page (not a proxied
  // gateway route) so Google lands the browser directly on the frontend.
  const redirectUri = `${appUrl}/auth/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }

  return { clientId, clientSecret, redirectUri };
}

export async function googleAuthRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /auth/google — redirect to Google
  // ---------------------------------------------------------------------------

  app.get("/auth/google", async (req, reply) => {
    const { clientId, redirectUri } = getGoogleConfig();

    // Use an HMAC-signed state so no cookie is needed.
    // A cookie set in a redirect response is not reliably forwarded by the
    // Next.js rewrite proxy, so we moved state verification server-side.
    const state = generateSignedState();

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });

    return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  });

  // ---------------------------------------------------------------------------
  // POST /auth/google/exchange — complete OAuth from the frontend callback page
  //
  // Verifies the HMAC-signed state, exchanges the code for tokens, then sets
  // the session cookie in a normal JSON response (not a redirect) so Next.js
  // reliably forwards Set-Cookie to the browser.
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { code: string; state: string };
  }>("/auth/google/exchange", async (req, reply) => {
    const { code, state } = req.body ?? {};

    if (!code || !state) {
      return reply.status(400).send({ error: "Missing code or state" });
    }

    if (!verifySignedState(state)) {
      logger.warn("Google OAuth state verification failed in exchange");
      return reply.status(400).send({ error: "State mismatch" });
    }

    try {
      const { clientId, clientSecret, redirectUri } = getGoogleConfig();

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        logger.error(
          { status: tokenRes.status, body },
          "Google token exchange failed",
        );
        return reply.status(400).send({ error: "Token exchange failed" });
      }

      const tokens = (await tokenRes.json()) as { id_token?: string };

      if (!tokens.id_token) {
        logger.error("No id_token in Google response");
        return reply.status(400).send({ error: "No id_token" });
      }

      const payload = await verifyIdToken(tokens.id_token);

      if (!payload.email) {
        logger.error("No email in Google ID token");
        return reply.status(400).send({ error: "No email in token" });
      }

      if (!payload.email_verified) {
        logger.warn("Google ID token email not verified");
        return reply.status(400).send({ error: "Email not verified" });
      }

      const email = payload.email.toLowerCase().trim();
      const name = payload.name ?? email.split("@")[0];

      const existing = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM accounts WHERE email = $1",
        [email],
      );

      let accountId: string;

      if (existing.rows.length > 0) {
        const status = existing.rows[0].status;
        // Only suspended (admin action) blocks login. A deactivated account
        // reactivates on login — the promised reactivation path, mirroring the
        // magic-link /auth/verify branch.
        if (status !== "active" && status !== "deactivated") {
          // Distinguish deleted (terminal, migration 159) from suspended —
          // mirrors the magic-link /auth/verify branch, which already does.
          return reply.status(403).send({
            error:
              status === "deleted" ? "Account deleted" : "Account suspended",
          });
        }
        accountId = existing.rows[0].id;
        if (status === "deactivated") {
          await pool.query(
            `UPDATE accounts SET status = 'active', updated_at = now() WHERE id = $1`,
            [accountId],
          );
          invalidateAuthCache(accountId);
          logger.info({ accountId }, "Account reactivated on Google login");
        }
        logger.info(
          { accountId, email: email.slice(0, 3) + "***" },
          "Google login — existing account",
        );
      } else if (CLOSED_BETA) {
        // CLOSED BETA (CLOSED-BETA-ADR D1) — "Continue with Google" silently
        // provisioned an account for any unknown email; that was the leak.
        // Existing accounts pass through the branch above untouched.
        //
        // This is a JSON 403, not a redirect: the exchange is a POST whose
        // response carries Set-Cookie (see the flow note at the top of this
        // file), so the frontend callback page owns the routing. It sends the
        // visitor to the closed-beta explanation rather than a raw error.
        logger.info(
          { email: email.slice(0, 3) + "***" },
          "Google login refused — closed beta, no account for this email",
        );
        return reply.status(403).send({ error: CLOSED_BETA_ERROR });
      } else {
        accountId = (await provisionAccount(email, name)).accountId;
        logger.info(
          { accountId, email: email.slice(0, 3) + "***" },
          "Google login — new account created",
        );
      }

      const account = await getAccount(accountId);
      if (!account) {
        logger.error({ accountId }, "Account not found after Google login");
        return reply.status(500).send({ error: "Account not found" });
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
      });

      return reply.status(200).send({ ok: true });
    } catch (err) {
      logger.error({ err }, "Google OAuth exchange failed");
      return reply.status(500).send({ error: "Exchange failed" });
    }
  });
}

// =============================================================================
// Helpers
// =============================================================================

// ---------------------------------------------------------------------------
// HMAC-signed OAuth state — avoids setting a cookie in a redirect response,
// which Next.js rewrite proxies don't reliably forward to the browser.
//
// Format: <nonce>.<timestamp>.<hmac-sha256-hex>
// The exchange endpoint verifies the HMAC and that the token is not expired.
// ---------------------------------------------------------------------------

function getStateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET ?? process.env.SESSION_SECRET;
  if (!secret)
    throw new Error("OAUTH_STATE_SECRET or SESSION_SECRET must be set");
  return secret;
}

function generateSignedState(): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${timestamp}`;
  const sig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

function verifySignedState(state: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [nonce, ts, sig] = parts;
  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return false;
  if (Math.floor(Date.now() / 1000) - timestamp > STATE_MAX_AGE_SECONDS)
    return false;
  const payload = `${nonce}.${ts}`;
  const expectedSig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest();
  const sigBuf = Buffer.from(sig, "hex");
  if (sigBuf.length !== expectedSig.length) return false;
  if (!timingSafeEqual(sigBuf, expectedSig)) return false;

  if (consumedNonces.has(nonce)) return false;
  consumedNonces.set(nonce, timestamp);
  return true;
}

async function verifyIdToken(idToken: string): Promise<{
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub?: string;
}> {
  const { clientId } = getGoogleConfig();
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  return payload as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
    sub?: string;
  };
}

