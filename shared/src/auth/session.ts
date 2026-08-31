import {
  SignJWT,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
} from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";
import "@fastify/cookie";

// =============================================================================
// Session Management
//
// JWT-based sessions stored in httpOnly secure cookies.
//
// Flow:
//   1. User signs up or logs in → createSession() → sets cookie
//   2. Every request → verifySession() middleware → extracts account info
//   3. Gateway injects x-reader-id, x-writer-id, x-reader-pubkey headers
//      for downstream services (payment, key service)
//
// The JWT contains:
//   - sub: account UUID
//   - pubkey: Nostr hex pubkey
//   - iat/exp: standard claims
// (Cookies minted before migration 145 also carry an isWriter claim from the
// retired reader/writer taxonomy — ignored; nothing reads it.)
//
// Token lifetime: 30 days. Refresh-on-use extends the session silently
// when the token is past its refresh threshold (7 days). Active users
// stay logged in indefinitely; idle sessions expire after 30 days.
// =============================================================================

const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days
const REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60; // refresh after 7 days
const COOKIE_NAME = "pp_session";

export interface SessionPayload extends JWTPayload {
  sub: string; // account UUID
  pubkey: string; // Nostr hex pubkey
}

// ---------------------------------------------------------------------------
// getSigningKey — loads from env, cached
// ---------------------------------------------------------------------------

let signingKey: Uint8Array | null = null;

function getSigningKey(): Uint8Array {
  if (signingKey) return signingKey;
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  signingKey = new TextEncoder().encode(secret);
  return signingKey;
}

// ---------------------------------------------------------------------------
// createSession — called after signup or login
// ---------------------------------------------------------------------------

export async function createSession(
  reply: FastifyReply,
  account: { id: string; nostrPubkey: string },
): Promise<string> {
  const key = getSigningKey();

  const token = await new SignJWT({
    pubkey: account.nostrPubkey,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(account.id)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
    .sign(key);

  setCookie(reply, token);
  return token;
}

// ---------------------------------------------------------------------------
// verifySession — extracts and validates session from cookie
// Returns null if no session or the token is no good (not an error —
// unauthenticated is OK). A fault of OURS still throws: see below.
// ---------------------------------------------------------------------------

export async function verifySession(
  req: FastifyRequest,
): Promise<SessionPayload | null> {
  const token = getCookie(req);
  if (!token) return null;

  // Outside the try, deliberately. A missing or too-short SESSION_SECRET is a
  // broken deployment, not a bad cookie: swallowing it returns null for every
  // request, so every member is silently logged out and nothing anywhere says
  // why. createSession() already throws on it (login/signup 500s loudly) —
  // verification must fail the same way rather than look like mass expiry.
  const key = getSigningKey();

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
    });

    return payload as SessionPayload;
  } catch (err) {
    // Terminal vs ambiguous, the same split as the Stripe classifiers and the
    // internal-parity probe. jose's own errors ARE the modelled outcome —
    // expired, forged, malformed, wrong alg — i.e. an ordinary unauthenticated
    // request. Anything else (a TypeError, a bug in here) is unexpected and
    // stays loud; a bare `catch {}` made the two indistinguishable.
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// refreshIfNeeded — silently extends session past refresh threshold (7 days)
// Call this in the gateway after successful verification.
// ---------------------------------------------------------------------------

export async function refreshIfNeeded(
  req: FastifyRequest,
  reply: FastifyReply,
  session: SessionPayload,
): Promise<void> {
  if (!session.iat) return;

  const age = Math.floor(Date.now() / 1000) - session.iat;
  if (age < REFRESH_AFTER_SECONDS) return;

  // Past refresh threshold — issue a fresh token
  await createSession(reply, {
    id: session.sub,
    nostrPubkey: session.pubkey,
  });
}

// ---------------------------------------------------------------------------
// destroySession — clears the cookie
// ---------------------------------------------------------------------------

export function destroySession(reply: FastifyReply): void {
  reply.setCookie(COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function setCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TOKEN_LIFETIME_SECONDS,
  });
}

function getCookie(req: FastifyRequest): string | null {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[COOKIE_NAME] ?? null;
}
