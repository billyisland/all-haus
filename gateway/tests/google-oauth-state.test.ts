import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { createHash } from "crypto";

// =============================================================================
// Google OAuth — the state is bound to the browser that started the flow.
//
// MIRROR-AUDIT §2.5. The signed state proved the PLATFORM minted it and nothing
// about WHO for, so the attack was: start a flow, take the callback URL Google
// hands back, forward it to a victim. The victim's browser completes the
// exchange and is signed into the attacker's account — and a card the victim
// then adds lands on the attacker's reading tab.
//
// The fix is a mandatory `bind` segment: the browser keeps 32 random bytes in
// its own `sessionStorage` and only their sha256 crosses Google. What this file
// pins is that the raw value is REQUIRED and CHECKED, which is the whole of it —
// an empty-allowed or unchecked binding is the same hole with an extra step.
//
// The forwarded-URL case is the test that matters, and note what it does NOT
// assert: the exchange is mocked to succeed, so every branch here can answer
// 200 with plausible JSON. It asserts whether a SESSION was created, because
// that is the thing the attack is after.
// =============================================================================

process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.OAUTH_STATE_SECRET = "test-state-secret";
process.env.APP_URL = "https://test.all.haus";

const createSession = vi.fn(async () => undefined);
const jwtVerify = vi.fn();

function query(sql: string) {
  if (sql.includes("SELECT id, status FROM accounts"))
    return Promise.resolve({
      rows: [{ id: "member-1", status: "active" }],
      rowCount: 1,
    });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string) => query(sql) },
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query }),
  loadConfig: async () => ({ freeAllowancePence: 500 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/auth/session.js", () => ({
  createSession: (...a: unknown[]) => createSession(...(a as [])),
}));

vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  getAccount: async (id: string) => ({ id, nostrPubkey: "ff".repeat(32) }),
}));

vi.mock("../src/middleware/auth.js", () => ({ invalidateAuthCache: vi.fn() }));

vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: (...a: unknown[]) => jwtVerify(...(a as [])),
}));

vi.mock("../src/lib/closed-beta.js", () => ({
  CLOSED_BETA: false,
  CLOSED_BETA_ERROR: "closed_beta",
}));

import { googleAuthRoutes } from "../src/routes/google-auth.js";

async function buildApp() {
  const app = Fastify();
  await app.register(googleAuthRoutes, { prefix: "/api/v1" });
  return app;
}

/** What a browser does before it leaves: mint bytes, send only their digest. */
function mintBinding(raw: string) {
  return { raw, digest: createHash("sha256").update(raw, "utf8").digest("hex") };
}

/** Drive the real GET and read the `state` back out of the Google redirect. */
async function startFlow(digest: string, arrival?: string) {
  const app = await buildApp();
  const qs = new URLSearchParams({ bind: digest });
  if (arrival) qs.set("arrival", arrival);
  const res = await app.inject({ method: "GET", url: `/api/v1/auth/google?${qs}` });
  await app.close();
  const location = res.headers.location as string | undefined;
  const state = location
    ? new URL(location).searchParams.get("state")
    : null;
  return { res, state };
}

async function exchange(payload: Record<string, unknown>) {
  jwtVerify.mockResolvedValue({
    payload: { email: "member@example.com", email_verified: true, name: "M" },
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
    payload,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  createSession.mockClear();
});

describe("Google OAuth state binding", () => {
  it("refuses to start a flow with no binding at all", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    await app.close();

    expect(res.statusCode).toBe(400);
    // Not a redirect: an unbound flow must never reach Google, or the state it
    // comes back with is one anybody can complete.
    expect(res.headers.location).toBeUndefined();
  });

  it("refuses a binding of the wrong shape, including the array form", async () => {
    const app = await buildApp();
    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google?bind=not-a-digest",
    });
    // `?bind=a&bind=b` arrives as an ARRAY whose elements are each perfectly
    // well-formed hex — the trap the `arrival` bound already documents. A typed
    // querystring is a claim, not a check.
    const both = mintBinding("aa".repeat(32)).digest;
    const array = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google?bind=${both}&bind=${both}`,
    });
    await app.close();

    expect(malformed.statusCode).toBe(400);
    expect(array.statusCode).toBe(400);
  });

  it("signs the digest into the state and completes for the browser that holds the preimage", async () => {
    const bind = mintBinding("11".repeat(32));
    const { res, state } = await startFlow(bind.digest);

    expect(res.statusCode).toBe(302);
    expect(state).toBeTruthy();
    // Five segments, and the digest is the second — the shape the exchange and
    // the closed-beta test both mint by hand.
    const parts = (state as string).split(".");
    expect(parts).toHaveLength(5);
    expect(parts[1]).toBe(bind.digest);

    const done = await exchange({ code: "c", state, bind: bind.raw });
    expect(done.statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("refuses the forwarded callback URL — the attack itself", async () => {
    // The attacker starts the flow in their own browser and holds the preimage.
    const attacker = mintBinding("22".repeat(32));
    const { state } = await startFlow(attacker.digest);

    // The victim's browser has the code and state (they were forwarded the URL)
    // and its own sessionStorage holds either nothing…
    const unbound = await exchange({ code: "c", state });
    // …or a binding from some flow of its own, which hashes to something else.
    const victim = mintBinding("33".repeat(32));
    const mismatched = await exchange({ code: "c", state, bind: victim.raw });

    expect(unbound.statusCode).toBe(400);
    expect(mismatched.statusCode).toBe(400);
    // The thing the attack was after. A 400 that still set a cookie would be
    // the same hole wearing a different status code.
    expect(createSession).not.toHaveBeenCalled();
  });

  it("carries the arrival intent through unchanged", async () => {
    const bind = mintBinding("44".repeat(32));
    const { state } = await startFlow(bind.digest, "some-d-tag");

    const done = await exchange({ code: "c", state, bind: bind.raw });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ ok: true, arrivalDTag: "some-d-tag" });
  });

  it("refuses a state whose binding segment was swapped for one the caller holds", async () => {
    // Tampering, as opposed to forwarding: the forwarder re-points the binding
    // at a preimage of their own. The HMAC covers the segment, so this is what
    // says the digest is inside the signed payload rather than beside it.
    const attacker = mintBinding("55".repeat(32));
    const { state } = await startFlow(attacker.digest);
    const mine = mintBinding("66".repeat(32));
    const tampered = (state as string)
      .split(".")
      .map((seg, i) => (i === 1 ? mine.digest : seg))
      .join(".");

    const res = await exchange({ code: "c", state: tampered, bind: mine.raw });

    expect(res.statusCode).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });
});
