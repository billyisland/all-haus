import type {
  FastifyRequest,
  FastifyReply,
} from "fastify";
import {
  verifySession,
  refreshIfNeeded,
  destroySession,
  type SessionPayload,
} from "@platform-pub/shared/auth/session.js";
import { pool } from "@platform-pub/shared/db/client.js";

// =============================================================================
// Auth Middleware
//
// Sits in the gateway. Two variants:
//
//   requireAuth — request fails with 401 if no valid session.
//                 Injects x-reader-id, x-reader-pubkey, x-writer-id headers
//                 that downstream services (payment, key) expect.
//
//   optionalAuth — decorates request with session info if present,
//                  but allows unauthenticated requests through.
//                  Used for public pages (article reading, feed).
//
// The gateway is the ONLY service that touches cookies or JWTs.
// Downstream services trust the injected headers unconditionally.
// =============================================================================

// Extend FastifyRequest with session data
declare module "fastify" {
  interface FastifyRequest {
    session?: SessionPayload | null;
  }
}

// Strip identity headers from incoming requests so unauthenticated callers
// cannot impersonate users on downstream services.
export async function stripIdentityHeaders(req: FastifyRequest): Promise<void> {
  delete req.headers["x-reader-id"];
  delete req.headers["x-reader-pubkey"];
  delete req.headers["x-writer-id"];
}

// ---------------------------------------------------------------------------
// Account auth-state cache
//
// Every authenticated request gates on two account columns (status +
// sessions_invalidated_at). Fetching them per request makes JWT verification —
// otherwise free — cost a DB round trip before any route runs, which is the
// single largest source of gateway query volume. Both gated behaviours
// (suspension, logout-all-devices) are already eventually-consistent, so a few
// seconds of staleness is acceptable; a short in-process TTL removes almost all
// of that volume. Admin/self actions that flip either column call
// invalidateAuthCache() so the change is not deferred past TTL on this instance
// (a multi-instance deployment still converges within TTL on the others).
// In-process by design — no Redis — matching loadConfig()'s pattern.
// ---------------------------------------------------------------------------

const AUTH_CACHE_TTL_MS = 8_000;
const AUTH_CACHE_SWEEP_AT = 10_000;

interface AccountAuthState {
  status: string;
  sessionsInvalidatedAt: Date | null;
  /** Terms 1.1: has this member declared their age? Read here so the refusal
   *  is SERVER-side (§0z item 11) — the web's gate is the surface, not the rule. */
  ageDeclared: boolean;
}

/**
 * Per-route opt-out of the age refusal, for the handful of routes an
 * undeclared member must still be able to reach: the one that reads their
 * state (`/auth/me`, which is how the web knows to show the gate) and the one
 * that records the declaration. Everything else — every money, publish, DM
 * and read door — answers 403 `age_required` until the column is set. A
 * route opts out with `config: { allowUndeclaredAge: true }`; the flag is
 * typed here so a misspelling is a compile error, not a silent open door.
 */
declare module "fastify" {
  interface FastifyContextConfig {
    allowUndeclaredAge?: boolean;
  }
}

// value.state === null encodes "account not found" (also cached, briefly).
const authStateCache = new Map<
  string,
  { state: AccountAuthState | null; expiresAt: number }
>();

export function invalidateAuthCache(accountId: string): void {
  authStateCache.delete(accountId);
}

async function loadAccountAuthState(
  accountId: string,
): Promise<AccountAuthState | null> {
  const now = Date.now();
  const cached = authStateCache.get(accountId);
  if (cached && cached.expiresAt > now) return cached.state;

  const row = await pool.query<{
    status: string;
    sessions_invalidated_at: Date | null;
    age_declared: boolean;
  }>(
    `SELECT status, sessions_invalidated_at,
            (age_declared_at IS NOT NULL) AS age_declared
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  const state: AccountAuthState | null =
    row.rowCount === 0
      ? null
      : {
          status: row.rows[0].status,
          sessionsInvalidatedAt: row.rows[0].sessions_invalidated_at,
          ageDeclared: row.rows[0].age_declared === true,
        };

  authStateCache.set(accountId, { state, expiresAt: now + AUTH_CACHE_TTL_MS });

  // Opportunistic eviction so a long-lived process doesn't retain an entry per
  // account ever seen; only runs once the map grows past the threshold.
  if (authStateCache.size > AUTH_CACHE_SWEEP_AT) {
    for (const [k, v] of authStateCache) {
      if (v.expiresAt <= now) authStateCache.delete(k);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// requireAuth — 401 if not authenticated
// ---------------------------------------------------------------------------

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await verifySession(req);

  if (!session || !session.sub) {
    reply.status(401).send({ error: "Authentication required" });
    return;
  }

  // Check account status — suspended users must not retain API access
  const account = await loadAccountAuthState(session.sub);
  if (!account || account.status !== "active") {
    reply.status(403).send({ error: "Account suspended or not found" });
    return;
  }

  // Terms 1.1 — "we refuse an account to anyone who tells us they are
  // younger" — was CLIENT-side until §0z item 11: the web mounted the gate and
  // nothing on the server read the column, so any client with the cookie
  // could gate-pass, accrue, DM and publish with no declaration at all. The
  // refusal lives here, in the one middleware every member door passes, and
  // a route opts OUT by config rather than in — the two that must (`/auth/me`,
  // `/auth/declare-age`) name themselves. An under-18 declaration is refused
  // and not recorded (see that route), which with this check in force means
  // the account can reach nothing: refused in fact, without a status written
  // on an unverified assertion.
  if (
    !account.ageDeclared &&
    !req.routeOptions?.config?.allowUndeclaredAge
  ) {
    reply.status(403).send({
      error: "age_required",
      message: "Please tell us your date of birth before continuing.",
    });
    return;
  }

  // Reject tokens issued before the last session invalidation (logout-all-devices)
  const invalidatedAt = account.sessionsInvalidatedAt;
  if (
    invalidatedAt &&
    session.iat &&
    session.iat < Math.floor(invalidatedAt.getTime() / 1000)
  ) {
    destroySession(reply);
    reply.status(401).send({ error: "Session expired" });
    return;
  }

  // Inject headers for downstream services
  req.headers["x-reader-id"] = session.sub;
  req.headers["x-reader-pubkey"] = session.pubkey;

  req.headers["x-writer-id"] = session.sub;

  // Attach to request for route handlers
  req.session = session;

  // Silently refresh session if past half-life
  await refreshIfNeeded(req, reply, session);
}

// ---------------------------------------------------------------------------
// optionalAuth — attaches session if present, allows anonymous
// ---------------------------------------------------------------------------

export async function optionalAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await verifySession(req);

  if (session?.sub) {
    const account = await loadAccountAuthState(session.sub);

    const invalid =
      !account ||
      account.status !== "active" ||
      (account.sessionsInvalidatedAt &&
        session.iat &&
        session.iat <
          Math.floor(account.sessionsInvalidatedAt.getTime() / 1000));

    if (invalid) {
      destroySession(reply);
      req.session = null;
      return;
    }

    req.headers["x-reader-id"] = session.sub;
    req.headers["x-reader-pubkey"] = session.pubkey;
    req.headers["x-writer-id"] = session.sub;

    req.session = session;
    await refreshIfNeeded(req, reply, session);
  } else {
    req.session = null;
  }
}

// ---------------------------------------------------------------------------
// requireSelfServiceAuth — requireAuth, widened to a member's OWN deactivation
//
// `requireAuth` refuses every status but `active`, which is right for the ~200
// routes that DO something. It is wrong for the one route whose whole job is
// handing a member their own data back (L7.1, D8 §7): a member who deactivates
// on their phone still has a live cookie on their laptop, and an export refused
// there is a data-subject right refused over a state the member chose and can
// reverse at any time by signing in.
//
// The split is deliberate and is the same one the reinstate route draws:
// `deactivated` is the MEMBER'S act and is theirs to undo, so it must not cost
// them their data; `suspended` and `moderated` are the OPERATOR'S and stay
// refused here — a moderated member's route out is the appeal (D7 §5), not a
// self-serve bundle carrying their root key.
//
// Everything else is requireAuth's, unchanged and deliberately not duplicated:
// the session check, the invalidation check, the injected identity headers and
// the silent refresh. This wrapper only widens which statuses may pass, and it
// re-reads the status from the same cached loader rather than from the session,
// which carries no status at all.
// ---------------------------------------------------------------------------

const SELF_SERVICE_STATUSES = new Set(["active", "deactivated"]);

export async function requireSelfServiceAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await verifySession(req);

  if (!session || !session.sub) {
    reply.status(401).send({ error: "Authentication required" });
    return;
  }

  const account = await loadAccountAuthState(session.sub);
  if (!account || !SELF_SERVICE_STATUSES.has(account.status)) {
    reply.status(403).send({ error: "Account suspended or not found" });
    return;
  }

  const invalidatedAt = account.sessionsInvalidatedAt;
  if (
    invalidatedAt &&
    session.iat &&
    session.iat < Math.floor(invalidatedAt.getTime() / 1000)
  ) {
    destroySession(reply);
    reply.status(401).send({ error: "Session expired" });
    return;
  }

  req.headers["x-reader-id"] = session.sub;
  req.headers["x-reader-pubkey"] = session.pubkey;
  req.headers["x-writer-id"] = session.sub;

  req.session = session;

  await refreshIfNeeded(req, reply, session);
}
