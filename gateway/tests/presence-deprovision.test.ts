import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// A CREDENTIAL OUTLIVES NOTHING (MIRROR-AUDIT §2.10, S9; migration 194).
//
// WHAT WAS WRONG. Account deletion is a soft delete and never touched
// `network_presences` — so every linked Bluesky/Mastodon OAuth credential
// stayed `active` and `is_valid` after the member left, and
// `outbound-token-refresh` kept refreshing it weekly. `atproto_oauth_sessions`
// had no link to `accounts` at all. The explicit unlink had the same gap from
// the other end: it deleted the presence row — the only thing carrying the DID
// — and left the session behind, so an orphan exists for every atproto
// presence ever disconnected.
//
// WHAT IS UNDER TEST, and why each assertion is the one that survives a
// plausible wrong fix:
//
//   (1) WHICH STATEMENTS RAN, never the status code. Both routes answered 200
//       with plausible JSON before the fix and answer 200 after it; a
//       status-shaped assertion passes against the defect exactly as it passes
//       against the fix. Same shape as the export step-up test asserting
//       whether the key was fetched.
//
//   (2) THE ORDER. The DID is read off the presence row, and the presence row
//       is what the delete is keyed on — so a fix that deprovisions first and
//       looks for sessions afterwards strands the session for good while
//       looking entirely correct. The deletion case asserts the SELECT of
//       `external_id` precedes the presence UPDATE; the unlink case asserts
//       the session delete uses the DID the DELETE ... RETURNING handed back.
//
//   (3) THE NON-ATPROTO CONTROL. A Mastodon presence carries its credential in
//       `credentials_enc` and has no session row; a fix that fired the session
//       delete unconditionally would pass a suite whose only fixture is
//       Bluesky.
//
//   (4) ONE TRANSACTION. Both unlink statements are recorded with the client
//       they were issued through, because a session delete that runs after the
//       transaction commits is byte-identical in its SQL and leaves the pair
//       half-done on a failure.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const PRESENCE = "00000000-0000-4000-8000-0000000000d4";
const DID = "did:plc:abc123";

type Call = { sql: string; params: unknown[]; via: "pool" | "tx" };
let calls: Call[] = [];
/** The presence row DELETE ... RETURNING hands back on the unlink path. */
let unlinkPresence: { protocol: string; external_id: string | null } | null =
  null;

function record(via: "pool" | "tx") {
  return (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params: [...params], via });

    if (sql.includes("SELECT email, nostr_pubkey FROM accounts")) {
      return Promise.resolve({
        rows: [{ email: "gone@example.com", nostr_pubkey: "f".repeat(64) }],
        rowCount: 1,
      });
    }
    // The deletion path's DID read. Answered from the SQL it was handed: this
    // is the only statement selecting external_id off network_presences.
    if (
      sql.includes("SELECT external_id FROM network_presences") ||
      (sql.includes("external_id") &&
        sql.includes("FROM network_presences") &&
        sql.includes("SELECT"))
    ) {
      return Promise.resolve({
        rows: [{ external_id: DID }],
        rowCount: 1,
      });
    }
    if (sql.includes("DELETE FROM network_presences")) {
      return unlinkPresence
        ? Promise.resolve({ rows: [{ ...unlinkPresence }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}

const poolQuery = record("pool");
const txQuery = record("tx");

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => poolQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof txQuery }) => Promise<unknown>) =>
    cb({ query: txQuery }),
  loadConfig: async () => ({}),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: ACCOUNT };
  },
  optionalAuth: async () => {},
  invalidateAuthCache: vi.fn(),
}));

// --- auth.ts collaborators ---------------------------------------------------

vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  signup: vi.fn(),
  signupSchema: () => z.object({}).passthrough(),
  getAccount: vi.fn(),
  updateProfile: vi.fn(),
  connectStripeAccount: vi.fn(),
  connectPaymentMethod: vi.fn(),
}));
vi.mock("@platform-pub/shared/auth/session.js", () => ({
  createSession: vi.fn(),
  destroySession: vi.fn(),
  verifySession: vi.fn(),
}));
vi.mock("@platform-pub/shared/auth/magic-links.js", () => ({
  requestMagicLink: vi.fn(),
  verifyMagicLink: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendMagicLinkEmail: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("../src/middleware/admin.js", () => ({ getAdminIds: async () => [] }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: vi.fn(),
  signEvent: vi.fn(async () => ({ id: "e".repeat(64) })),
}));
vi.mock("../src/lib/discovery-publish.js", () => ({
  republishProfile: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

// --- linked-accounts.ts collaborators ----------------------------------------

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/crypto.js", () => ({
  encryptJson: vi.fn(),
  decryptJson: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/atproto-oauth.js", () => ({
  getAtprotoClient: vi.fn(),
}));
vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: vi.fn(),
  isDid: vi.fn(),
  normaliseHandle: vi.fn(),
}));

const { authRoutes } = await import("../src/routes/auth.js");
const { linkedAccountsRoutes } = await import(
  "../src/routes/linked-accounts.js"
);

function indexOf(fragment: string): number {
  return calls.findIndex((c) => c.sql.includes(fragment));
}
function callFor(fragment: string): Call | undefined {
  return calls.find((c) => c.sql.includes(fragment));
}

beforeEach(() => {
  calls = [];
  unlinkPresence = null;
});

describe("POST /auth/delete-account — the presences go with the account", () => {
  async function deleteAccount() {
    const app = Fastify();
    await app.register(authRoutes, { prefix: "/api/v1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/delete-account",
      payload: { emailConfirmation: "gone@example.com" },
    });
    await app.close();
    return res;
  }

  it("deprovisions every presence and drops its atproto session", async () => {
    const res = await deleteAccount();
    expect(res.statusCode).toBe(200);

    const deprovision = callFor("lifecycle_state = 'deprovisioned'");
    expect(deprovision).toBeDefined();
    expect(deprovision!.sql).toContain("is_valid = FALSE");
    expect(deprovision!.sql).toContain("credentials_enc = NULL");
    expect(deprovision!.params).toEqual([ACCOUNT]);

    const sessionDelete = callFor("DELETE FROM atproto_oauth_sessions");
    expect(sessionDelete).toBeDefined();
    expect(sessionDelete!.params[0]).toEqual([DID]);
  });

  it("reads the DIDs BEFORE it changes the presence rows", async () => {
    await deleteAccount();
    const read = indexOf("SELECT external_id FROM network_presences");
    const del = indexOf("DELETE FROM atproto_oauth_sessions");
    const update = indexOf("lifecycle_state = 'deprovisioned'");
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(del);
    expect(del).toBeLessThan(update);
  });

  it("runs the deprovision inside the deletion transaction", async () => {
    await deleteAccount();
    expect(callFor("lifecycle_state = 'deprovisioned'")!.via).toBe("tx");
    expect(callFor("DELETE FROM atproto_oauth_sessions")!.via).toBe("tx");
  });
});

describe("DELETE /linked-accounts/:id — the credential goes with the link", () => {
  async function unlink() {
    const app = Fastify();
    await app.register(linkedAccountsRoutes, { prefix: "/api/v1" });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/linked-accounts/${PRESENCE}`,
    });
    await app.close();
    return res;
  }

  it("deletes the atproto session keyed on the DID the DELETE returned", async () => {
    unlinkPresence = { protocol: "atproto", external_id: DID };
    const res = await unlink();
    expect(res.statusCode).toBe(200);

    const sessionDelete = callFor("DELETE FROM atproto_oauth_sessions");
    expect(sessionDelete).toBeDefined();
    expect(sessionDelete!.params).toEqual([DID]);
    // Both halves in one transaction — a session delete that ran after the
    // commit would carry identical SQL.
    expect(callFor("DELETE FROM network_presences")!.via).toBe("tx");
    expect(sessionDelete!.via).toBe("tx");
  });

  it("does not touch the session table for a non-atproto presence", async () => {
    unlinkPresence = { protocol: "activitypub", external_id: "12345" };
    const res = await unlink();
    expect(res.statusCode).toBe(200);
    expect(callFor("DELETE FROM atproto_oauth_sessions")).toBeUndefined();
  });

  it("404s and deletes nothing when the presence is not the caller's", async () => {
    unlinkPresence = null;
    const res = await unlink();
    expect(res.statusCode).toBe(404);
    expect(callFor("DELETE FROM atproto_oauth_sessions")).toBeUndefined();
  });
});
