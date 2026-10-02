import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { provisionAccount } from "../lib/account-provision.js";
import { createSession } from "@platform-pub/shared/auth/session.js";
import { getAccount } from "@platform-pub/shared/auth/accounts.js";
import { invalidateAuthCache } from "../middleware/auth.js";
import { CLOSED_BETA, CLOSED_BETA_ERROR } from "../lib/closed-beta.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { randomBytes, createHash, createHmac, timingSafeEqual } from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { requireEnv } from "@platform-pub/shared/lib/env.js";

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
//   1. Browser mints 32 random bytes, keeps them in sessionStorage, and clicks
//      through to GET /api/v1/auth/google?bind=<sha256 of those bytes>
//   2. Gateway generates an HMAC-signed state (carrying that digest and any
//      paywall-arrival intent), redirects to Google
//   3. Google redirects to ${APP_URL}/auth/google/callback (Next.js page)
//   4. That page POSTs { code, state, bind } — bind being the RAW value out of
//      its own sessionStorage — to /api/v1/auth/google/exchange
//   5. Gateway verifies the state HMAC, checks the raw bind hashes to the digest
//      it signed, exchanges the code, sets the pp_session cookie
//   6. Page calls /auth/me to hydrate the store, then navigates on
//
// State is verified by HMAC signature (not a cookie) because Next.js rewrite
// proxies do not reliably forward Set-Cookie headers in redirect responses.
//
// AND THE STATE IS BOUND TO THE BROWSER THAT STARTED THE FLOW (§2.5). A signed
// state proves WE minted it; it proved nothing about WHO it was minted for, so
// an attacker could start a flow, take the callback URL Google handed them and
// forward it to a victim, whose browser would complete the exchange and be
// logged into the attacker's account — with any card the victim then added
// landing on the attacker's tab. The `bind` segment closes that: only the
// DIGEST crosses Google, so the forwarded URL carries a binding the victim's
// browser has no preimage for, and nothing new is cookie-borne (the reason
// state moved server-side in the first place). The in-process `consumedNonces`
// map is replay protection and is no help here — it is per-process and
// per-nonce, never per-browser.
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
  const appUrl = requireEnv("APP_URL");

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

  app.get<{ Querystring: { arrival?: string; bind?: string } }>(
    "/auth/google",
    async (req, reply) => {
    const { clientId, redirectUri } = getGoogleConfig();

    // THE BINDING IS MANDATORY, not tolerated-empty (§2.5). The caller is a
    // client component that always runs JS, so it can always produce one — and
    // an empty-allowed `bind` would be the hole with an extra step, since the
    // attacker starting the flow is the party who decides whether to send it.
    // A 400 here is a hand-built or stale URL, which is exactly the traffic
    // this route should stop carrying.
    //
    // Typed AND shape-checked, for the reason the `arrival` note below gives:
    // `?bind=a&bind=b` arrives as an ARRAY, and `bind` is about to be signed
    // into a delimiter-separated payload, so it must be 64 hex characters —
    // the shape a sha256 digest has and the delimiter cannot survive.
    const bind = req.query.bind;
    if (typeof bind !== "string" || !/^[0-9a-f]{64}$/.test(bind)) {
      return reply.status(400).send({ error: "missing_bind" });
    }

    // Use an HMAC-signed state so no cookie is needed.
    // A cookie set in a redirect response is not reliably forwarded by the
    // Next.js rewrite proxy, so we moved state verification server-side.
    //
    // THE STATE IS ALSO THE ARRIVAL CARRIER (PAYWALL-ARRIVAL §5). It has to
    // survive a round trip through a third party, and it is already HMAC-signed
    // and verified server-side — so a d-tag carried in it is tamper-proof
    // rather than merely safe, which matters because it is the value the grant
    // looks a PRICE up from. A client-supplied price would be a free-money
    // endpoint; a signed identifier is neither.
    //
    // BOUNDED AT THE SAME 200 THE POST SCHEMAS USE. The d-tag goes into the
    // state string, which goes into a URL Google has to accept and hand back;
    // unbounded, a caller could push an arbitrarily long value through the HMAC
    // and out the other side. `arrivalDTag` is `z.string().min(1).max(200)` on
    // every POST carrier, and this GET is the same value arriving by a different
    // door, so it gets the same ceiling. Over-long is DROPPED rather than
    // refused: the arrival intent is a courtesy on top of a sign-in, and failing
    // the sign-in over it would trade a lost welcome for a lost account.
    //
    // AND TYPED, not just bounded: `arrival?: string` is a TypeScript claim
    // about a querystring Fastify parses freely, and `?arrival=a&arrival=b`
    // arrives as an ARRAY whose `.length` passes the bound and reaches the
    // HMAC. Harmless in outcome (a nonsense d-tag is NO_GIFT), but a bound on
    // a value of the wrong shape is not a bound (CONSOLIDATED-TODO §0w item 4).
    const arrival = req.query.arrival;
    const state = generateSignedState(
      bind,
      typeof arrival === "string" && arrival.length > 0 && arrival.length <= 200
        ? arrival
        : null,
    );

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });

    return reply.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
  },
  );

  // ---------------------------------------------------------------------------
  // POST /auth/google/exchange — complete OAuth from the frontend callback page
  //
  // Verifies the HMAC-signed state, exchanges the code for tokens, then sets
  // the session cookie in a normal JSON response (not a redirect) so Next.js
  // reliably forwards Set-Cookie to the browser.
  // ---------------------------------------------------------------------------

  app.post<{
    Body: { code: string; state: string; bind: string };
  }>("/auth/google/exchange", async (req, reply) => {
    const { code, state, bind } = req.body ?? {};

    if (!code || !state || typeof bind !== "string" || bind.length === 0) {
      return reply.status(400).send({ error: "Missing code, state or bind" });
    }

    const stateCheck = verifySignedState(state);
    if (!stateCheck.ok) {
      logger.warn("Google OAuth state verification failed in exchange");
      return reply.status(400).send({ error: "State mismatch" });
    }

    // The state is ours; this is what says it is THIS browser's. The raw value
    // came out of the caller's own sessionStorage, which a forwarded callback
    // URL cannot carry with it — see the flow note at the top of the file. The
    // client-facing error is deliberately the same "State mismatch" the check
    // above returns: the two failures are one fact to the visitor, and telling
    // the two apart is only useful to whoever forwarded the URL.
    if (!bindMatches(bind, stateCheck.bindDigest)) {
      logger.warn("Google OAuth state was not bound to this browser");
      return reply.status(400).send({ error: "State mismatch" });
    }
    const arrivalDTag = stateCheck.arrivalDTag;

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
        accountId = (await provisionAccount(email, name, arrivalDTag))
          .accountId;
        logger.info(
          { accountId, email: email.slice(0, 3) + "***" },
          "Google login — new account created",
        );
      }

      const account = await getAccount(accountId);
      if (!account) {
        logger.error({ accountId }, "Account not found after Google login");
        return reply.status(500).send({ error: "We couldn't find that account." });
      }

      await createSession(reply, {
        id: account.id,
        nostrPubkey: account.nostrPubkey,
      });

      // Handed back so the callback page can route to the piece rather than to
      // the workspace. An EXISTING account gets it too — they came to read
      // something and should land on it — and gets no gift and no welcome,
      // because both are gated on `arrival_article_id`, which is stamped at
      // creation and so is false for everyone who was already a member (§11.5).
      return reply.status(200).send({ ok: true, arrivalDTag });
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
// Format: <nonce>.<bind>.<timestamp>.<arrival>.<hmac-sha256-hex>
// The exchange endpoint verifies the HMAC, that the token is not expired, and
// that the caller holds the preimage of <bind>.
// ---------------------------------------------------------------------------

function getStateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET ?? process.env.SESSION_SECRET;
  if (!secret)
    throw new Error("OAUTH_STATE_SECRET or SESSION_SECRET must be set");
  return secret;
}

// Format: <nonce>.<bind-sha256-hex>.<timestamp>.<arrival-b64url>.<hmac-sha256-hex>
//
// The FOURTH segment is the paywall-arrival intent, base64url-encoded so it can
// never contain the delimiter, and EMPTY for every ordinary sign-in — which is
// why this is a fixed-arity format rather than a bag of optional extras: an
// optional segment would mean two payload shapes signing to two different
// strings, and the shorter one would verify against neither.
//
// The SECOND is the browser binding (§2.5) and it is mandatory for exactly the
// same reason inverted — it is never empty, because a value the attacker may
// omit is a value the attacker will omit. It is a sha256 digest, so it is
// fixed-width hex and cannot contain the delimiter either.
//
// Both are inside the SIGNED payload, not beside it. `arrival` decides how much
// money a new account is granted (`resolveArrivalGift` looks the price up from
// it), so a tamperable one would be a free-money endpoint reached through a
// third party's redirect; a tamperable `bind` would let the forwarder re-point
// the binding at a preimage they hold, which is the whole attack.
function generateSignedState(
  bindDigest: string,
  arrivalDTag: string | null,
): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const arrival = arrivalDTag
    ? Buffer.from(arrivalDTag, "utf8").toString("base64url")
    : "";
  const payload = `${nonce}.${bindDigest}.${timestamp}.${arrival}`;
  const sig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

// Does the raw value the caller kept in sessionStorage hash to the digest we
// signed into the state? Compared timing-safely, and length-checked first
// because `timingSafeEqual` throws on a length mismatch rather than returning
// false — a malformed `bind` must be a refusal, never a 500.
function bindMatches(raw: string, digestHex: string): boolean {
  const actual = createHash("sha256").update(raw, "utf8").digest();
  const expected = Buffer.from(digestHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}

function verifySignedState(state: string): {
  ok: boolean;
  arrivalDTag: string | null;
  bindDigest: string;
} {
  const bad = { ok: false, arrivalDTag: null, bindDigest: "" };
  const parts = state.split(".");
  if (parts.length !== 5) return bad;
  const [nonce, bindDigest, ts, arrival, sig] = parts;
  // Shape-checked even though the signature covers it: `bindDigest` is about to
  // be `Buffer.from(…, "hex")`d, which answers garbage with a SHORT buffer
  // rather than an error, and a short buffer compared against a sha256 is a
  // refusal that looks like a length bug.
  if (!/^[0-9a-f]{64}$/.test(bindDigest)) return bad;
  const timestamp = parseInt(ts, 10);
  if (isNaN(timestamp)) return bad;
  if (Math.floor(Date.now() / 1000) - timestamp > STATE_MAX_AGE_SECONDS)
    return bad;
  const payload = `${nonce}.${bindDigest}.${ts}.${arrival}`;
  const expectedSig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest();
  const sigBuf = Buffer.from(sig, "hex");
  if (sigBuf.length !== expectedSig.length) return bad;
  if (!timingSafeEqual(sigBuf, expectedSig)) return bad;

  if (consumedNonces.has(nonce)) return bad;
  consumedNonces.set(nonce, timestamp);

  return {
    ok: true,
    arrivalDTag: arrival
      ? Buffer.from(arrival, "base64url").toString("utf8")
      : null,
    bindDigest,
  };
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

