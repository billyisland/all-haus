import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { createHmac, randomBytes } from "crypto";

// =============================================================================
// POST /auth/google/exchange — the closed-beta account-creation gate.
//
// CLOSED-BETA-ADR §II.3 calls this path "the leak": "Continue with Google" is
// find-or-create, so an unknown email was silently provisioned an account. The
// email magic-link path is members-only by construction and the /auth/signup
// path is a flat refusal (both trivially checked by hand); THIS branch is the
// one that cannot be exercised without a real Google-signed id_token, so it is
// the one that earns a test.
//
// The contract under test:
//   - unknown email      → 403 closed_beta, and NOTHING is created: no keypair
//                          minted, no INSERT INTO accounts, no session. The
//                          whole point — a 403 that still provisioned would be
//                          the same leak wearing a different status code.
//   - active account     → passes through untouched (members keep full access,
//                          §I.1 — they must be able to log in FRESH, not merely
//                          ride an existing session).
//   - deactivated account→ still reactivates and logs in (§VII: "including
//                          those who previously deactivated").
//
// If CLOSED_BETA is flipped to false, the unknown-email case must go back to
// creating an account — asserted too, so this test pins the gate rather than
// merely pinning "returns 403 forever".
// =============================================================================

process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.OAUTH_STATE_SECRET = "test-state-secret";
process.env.APP_URL = "https://test.all.haus";

const STATE_SECRET = "test-state-secret";

/** Mint a state the route's own verifySignedState will accept. */
function signedState(): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${timestamp}`;
  const sig = createHmac("sha256", STATE_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

// --- collaborators -----------------------------------------------------------

let accountRows: Array<{ id: string; status: string }> = [];
let insertedAccounts = 0;
let updateCalls: string[] = [];

const generateKeypair = vi.fn(async () => ({
  pubkeyHex: "ff".repeat(32),
  privkeyEncrypted: "enc",
}));
const createSession = vi.fn(async () => undefined);
const jwtVerify = vi.fn();

function query(sql: string) {
  if (sql.includes("SELECT id, status FROM accounts"))
    return Promise.resolve({ rows: accountRows, rowCount: accountRows.length });
  if (sql.includes("INSERT INTO accounts")) {
    insertedAccounts += 1;
    return Promise.resolve({ rows: [{ id: "new-account" }], rowCount: 1 });
  }
  if (sql.trimStart().startsWith("UPDATE accounts")) updateCalls.push(sql);
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string) => query(sql) },
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query }),
  // provisionAccount stamps the free allowance from the dial (migration 169),
  // so the module it reads that from has to answer here too. What the grant
  // actually is, is this file's business not at all — free-allowance-grant.test.ts
  // owns that; this one only needs the provision path to reach its INSERT.
  loadConfig: async () => ({ freeAllowancePence: 500 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: (...a: unknown[]) => generateKeypair(...(a as [])),
}));

vi.mock("@platform-pub/shared/auth/session.js", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [])),
}));

vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  getAccount: async (id: string) => ({ id, nostrPubkey: "ff".repeat(32) }),
}));

vi.mock("../src/middleware/auth.js", () => ({
  invalidateAuthCache: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: (...a: unknown[]) => jwtVerify(...(a as [])),
}));

// The gate itself is a module constant, so it is mocked per-test to prove the
// route follows it in BOTH positions rather than just returning 403 blindly.
let closedBeta = true;
vi.mock("../src/lib/closed-beta.js", () => ({
  get CLOSED_BETA() {
    return closedBeta;
  },
  CLOSED_BETA_ERROR: "closed_beta",
}));

import { googleAuthRoutes } from "../src/routes/google-auth.js";

async function buildApp() {
  const app = Fastify();
  await app.register(googleAuthRoutes, { prefix: "/api/v1" });
  return app;
}

/** Drive the exchange as Google would, for a given email. */
async function exchangeAs(email: string) {
  jwtVerify.mockResolvedValue({
    payload: { email, email_verified: true, name: "Test Person" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ id_token: "stub-id-token" }),
    })),
  );

  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/google/exchange",
    payload: { code: "stub-code", state: signedState() },
  });
  await app.close();
  return res;
}

beforeEach(() => {
  accountRows = [];
  insertedAccounts = 0;
  updateCalls = [];
  closedBeta = true;
  generateKeypair.mockClear();
  createSession.mockClear();
});

describe("closed beta — Google OAuth account creation gate", () => {
  it("refuses an unknown email, and creates absolutely nothing", async () => {
    const res = await exchangeAs("stranger@example.com");

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "closed_beta" });

    // A 403 that still provisioned would be the same leak in disguise.
    expect(insertedAccounts).toBe(0);
    expect(generateKeypair).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("lets an existing active member straight through", async () => {
    accountRows = [{ id: "member-1", status: "active" }];

    const res = await exchangeAs("member@example.com");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(createSession).toHaveBeenCalledOnce();
    expect(insertedAccounts).toBe(0);
  });

  it("still reactivates a deactivated member on login", async () => {
    accountRows = [{ id: "member-2", status: "deactivated" }];

    const res = await exchangeAs("returning@example.com");

    expect(res.statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledOnce();
    expect(updateCalls.some((s) => s.includes("status = 'active'"))).toBe(true);
  });

  it("keeps refusing a suspended account (unchanged by the gate)", async () => {
    accountRows = [{ id: "member-3", status: "suspended" }];

    const res = await exchangeAs("suspended@example.com");

    expect(res.statusCode).toBe(403);
    expect(res.json().error).not.toBe("closed_beta");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("provisions again once the beta is reopened", async () => {
    closedBeta = false;

    const res = await exchangeAs("stranger@example.com");

    expect(res.statusCode).toBe(200);
    expect(insertedAccounts).toBe(1);
    expect(generateKeypair).toHaveBeenCalledOnce();
  });
});
