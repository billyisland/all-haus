import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /account/export — the step-up (MIRROR-AUDIT §2.6).
//
// The bundle carries the account's root Nostr secret key: the identity itself,
// which cannot be rotated. It shipped on the ambient session cookie alone, so
// any session compromise was permanent — and nothing recorded that an export
// had happened, so "was my key taken?" had no answer in either direction.
//
// WHAT THIS FILE ASSERTS IS WHETHER THE KEY WAS FETCHED, never the status code.
// A refusal that still called key-custody would be the same disclosure wearing
// a 403, and every branch here answers with plausible JSON either way. Same
// reason the arrival-route test asserts whether the gate pass ran.
//
// The confirmation is not a refusal: the export is MANDATED by the custodial
// identity rule, so the last case here is the ordinary member getting their key,
// and it has to keep passing.
// =============================================================================

process.env.KEY_SERVICE_URL = "http://key-service.test";
process.env.INTERNAL_SECRET = "test-internal";

const exportSecretKey = vi.fn(async () => ({
  privkeyHex: "11".repeat(32),
  nsec: "nsec1test",
}));
const sendKeyExportStepUpEmail = vi.fn(async () => undefined);
const sendKeyExportNoticeEmail = vi.fn(async () => undefined);
const requestStepUpToken = vi.fn(async () => ({
  token: "fresh-token",
  expiresAt: new Date(Date.now() + 900_000),
}));

/** What the claim would answer — the DB test owns whether the SQL is right. */
let tokenIsValid = true;
let claimThrows = false;
const auditInserts: unknown[][] = [];

const claimStepUpToken = vi.fn(
  async (
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    _token: string,
    _accountId: string,
    _purpose: string,
  ) => {
    void client;
    if (claimThrows) throw new Error("db down");
    return tokenIsValid;
  },
);

let accountRows = [
  {
    email: "member@example.com",
    nostr_pubkey: "ff".repeat(32),
    username: "member",
    display_name: "Member",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
    date_of_birth: null,
    age_declared_at: null,
    has_keypair: true,
  },
];

function query(sql: string, params?: unknown[]) {
  if (sql.includes("INSERT INTO account_key_exports")) {
    auditInserts.push(params ?? []);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("FROM accounts"))
    return Promise.resolve({ rows: accountRows, rowCount: accountRows.length });
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  exportSecretKey: (...a: unknown[]) => exportSecretKey(...(a as [])),
}));

vi.mock("@platform-pub/shared/auth/magic-links.js", () => ({
  requestStepUpToken: (...a: unknown[]) => requestStepUpToken(...(a as [])),
  claimStepUpToken: (...a: unknown[]) =>
    claimStepUpToken(...(a as [Parameters<typeof claimStepUpToken>[0], string, string, string])),
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendKeyExportStepUpEmail: (...a: unknown[]) =>
    sendKeyExportStepUpEmail(...(a as [])),
  sendKeyExportNoticeEmail: (...a: unknown[]) =>
    sendKeyExportNoticeEmail(...(a as [])),
}));

vi.mock("@platform-pub/shared/auth/session.js", () => ({
  verifySession: async () => ({ sub: "member-1" }),
}));

// The route moved to `requireSelfServiceAuth` (L7.1) — requireAuth widened to
// admit a member's own `deactivated` state, so an export is not refused over a
// state they chose. Which statuses pass is asserted against a real database in
// `account-export-contents.test.ts`; this file is about the step-up, so the
// gate is stubbed open and the assertions stay on whether the KEY was fetched.
vi.mock("../src/middleware/auth.js", () => ({
  requireSelfServiceAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: "member-1" };
  },
}));

import { exportRoutes } from "../src/routes/export.js";

async function buildApp() {
  const app = Fastify();
  await app.register(exportRoutes, { prefix: "/api/v1" });
  return app;
}

/** key-service's export-keys leg, which the route fetches directly. */
function stubKeyService() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ keys: [] }) })),
  );
}

beforeEach(() => {
  tokenIsValid = true;
  claimThrows = false;
  auditInserts.length = 0;
  exportSecretKey.mockClear();
  sendKeyExportNoticeEmail.mockClear();
  sendKeyExportStepUpEmail.mockClear();
  requestStepUpToken.mockClear();
  accountRows = [
    {
      email: "member@example.com",
      nostr_pubkey: "ff".repeat(32),
      username: "member",
      display_name: "Member",
      status: "active",
      created_at: new Date("2026-01-01T00:00:00Z"),
      date_of_birth: null,
      age_declared_at: null,
      has_keypair: true,
    },
  ];
  stubKeyService();
});

describe("account export — the mailed step-up", () => {
  it("refuses a session-only export, and fetches no key", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/account/export" });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_required");
    // The whole finding: a cookie alone must not move the key.
    expect(exportSecretKey).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(0);
  });

  it("refuses an array-shaped token rather than claiming one of them", async () => {
    // `?token=a&token=b` arrives as an ARRAY. A truthiness check passes it
    // through and the claim is parameterised with something that is not the
    // string it was minted as — harmless here, and the same trap the OAuth
    // `bind` bound documents one route over.
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export?token=a&token=b",
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_required");
    expect(claimStepUpToken).not.toHaveBeenCalled();
    expect(exportSecretKey).not.toHaveBeenCalled();
  });

  it("refuses a spent or expired token, records nothing, and fetches no key", async () => {
    tokenIsValid = false;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export?token=stale",
    });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("step_up_invalid");
    expect(exportSecretKey).not.toHaveBeenCalled();
    expect(auditInserts).toHaveLength(0);
  });

  it("hands over the key on a good token — and records and announces it", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export?token=good",
      headers: { "user-agent": "TestBrowser/1.0" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // The export is a member's RIGHT — the step-up must never become a way to
    // withhold it, so the ordinary path has to keep delivering the key.
    expect(res.json().account.nostrPrivkeyNsec).toBe("nsec1test");
    expect(exportSecretKey).toHaveBeenCalledOnce();

    // Recorded: one row, carrying the two things that make it answerable.
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0][0]).toBe("member-1");
    expect(auditInserts[0][2]).toBe("TestBrowser/1.0");

    // Announced, unconditionally and on the export rather than the request.
    expect(sendKeyExportNoticeEmail).toHaveBeenCalledOnce();
    expect(sendKeyExportNoticeEmail.mock.calls[0][0]).toBe("member@example.com");
  });

  it("fails closed when the authorisation transaction itself fails", async () => {
    claimThrows = true;

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/account/export?token=good",
    });
    await app.close();

    expect(res.statusCode).toBe(500);
    expect(exportSecretKey).not.toHaveBeenCalled();
  });

  it("mails a confirmation on request, and says nothing about the account", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/export/request",
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(requestStepUpToken).toHaveBeenCalledWith("member-1", "key_export");
    expect(sendKeyExportStepUpEmail.mock.calls[0][0]).toBe("member@example.com");
  });

  it("answers a request identically when there is no address to mail", async () => {
    accountRows = [];

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/account/export/request",
    });
    await app.close();

    // Same 200, same body. A stolen session learns nothing about the account
    // from this route, and the member's next move is unchanged either way.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(sendKeyExportStepUpEmail).not.toHaveBeenCalled();
  });
});
