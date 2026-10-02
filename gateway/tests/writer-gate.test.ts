import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// The writer gate's one home, and the one money-out door that asks it
// (READER-WRITER-SPLIT-ADR §4.7, §5)
//
// `requireWriter` is the preHandler every `writer` route carries; the registry
// test (`route-classes.test.ts`) pins WHICH routes carry it, this file pins
// what it DOES: a reader is refused with the one code, a writer passes
// untouched, and a missing account row is a reader — the read fails closed.
//
// Connect onboarding (`POST /auth/upgrade-writer`) is `money-out`: it is how
// money already earned leaves, so it never carries `requireWriter`. It asks
// `canWrite OR holdsWriterLedger` instead — nobody opens a Stripe account for
// nothing, and nobody holding earnings is locked out of collecting them. Each
// case asserts whether STRIPE WAS CALLED, never the status alone: a refusal
// returned after the account was created looks the same from outside.
//
// The mock answers FROM THE PARAM, never from the text alone: both reads are
// keyed on the account id they are handed.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const WRITER = "00000000-0000-4000-8000-00000000000a";
const READER = "00000000-0000-4000-8000-00000000000b";
const EARNER = "00000000-0000-4000-8000-00000000000c"; // a reader holding earnings

let calls: Array<{ sql: string; params: unknown[] }> = [];

function query(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });
  if (sql.includes("AS can_write")) {
    const known = [WRITER, READER, EARNER].includes(params[0] as string);
    return Promise.resolve(
      known ? { rows: [{ can_write: params[0] === WRITER }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("FROM ledger_entries")) {
    // A structural pin as well as a behavioural one: the trigger list is only
    // Postgres's to evaluate, so assert it names the writer-side entries.
    expect(sql).toContain("'writer_accrual'");
    expect(sql).toContain("'subscription_earning'");
    return Promise.resolve(params[0] === EARNER ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({ tabSettlementThresholdPence: 800 })),
}));

let sessionId = WRITER;
const getAccount = vi.fn(async (id: string) => ({
  id,
  stripeConnectId: null,
  writerAdmittedAt: id === WRITER ? "2026-09-01T00:00:00.000Z" : null,
}));
const connectStripeAccount = vi.fn(async () => ({ onboardingUrl: "https://connect.stripe.test/x" }));

vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  signup: vi.fn(),
  signupSchema: () => z.object({}).passthrough(),
  getAccount: (id: string) => getAccount(id),
  updateProfile: vi.fn(),
  connectStripeAccount: (...a: unknown[]) => connectStripeAccount(...(a as [])),
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
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: sessionId };
  },
  invalidateAuthCache: vi.fn(),
}));
vi.mock("../src/middleware/admin.js", () => ({ getAdminIds: vi.fn(async () => []) }));
vi.mock("../src/lib/key-custody-client.js", () => ({ generateKeypair: vi.fn(), signEvent: vi.fn() }));
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn() }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({ enqueueRelayPublish: vi.fn() }));
vi.mock("../src/lib/closed-beta.js", () => ({ CLOSED_BETA: true, CLOSED_BETA_ERROR: "closed_beta" }));

const stripeAccountsCreate = vi.fn(async () => ({ id: "acct_test" }));
vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    accounts: { create: (...a: unknown[]) => stripeAccountsCreate(...(a as [])) },
    accountLinks: { create: vi.fn(async () => ({ url: "https://connect.stripe.test/x" })) },
  })),
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

import { authRoutes } from "../src/routes/auth.js";
import { requireWriter, WRITER_ACCESS_REQUIRED } from "../src/lib/writer-gate.js";

beforeEach(() => {
  calls = [];
  sessionId = WRITER;
  stripeAccountsCreate.mockClear();
  connectStripeAccount.mockClear();
});

async function gatedApp() {
  const app = Fastify({ logger: false });
  app.post(
    "/gated",
    {
      preHandler: [
        async (req) => {
          (req as { session?: { sub: string } }).session = { sub: sessionId } as never;
        },
        requireWriter,
      ],
    },
    async () => ({ reached: true }),
  );
  return app;
}

describe("requireWriter", () => {
  it("refuses a READER with 403 writer_access_required, and the handler never runs", async () => {
    sessionId = READER;
    const app = await gatedApp();
    const res = await app.inject({ method: "POST", url: "/gated" });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(WRITER_ACCESS_REQUIRED);
    expect(res.json().reached).toBeUndefined();
    // It asked about the member in the session, not somebody else.
    expect(calls.filter((c) => c.sql.includes("AS can_write")).map((c) => c.params[0])).toEqual([READER]);
  });

  it("CONTROL: lets a WRITER through to the handler", async () => {
    const app = await gatedApp();
    const res = await app.inject({ method: "POST", url: "/gated" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
  });

  it("fails CLOSED: an account the read cannot find is a reader", async () => {
    sessionId = "00000000-0000-4000-8000-0000000000ff";
    const app = await gatedApp();
    const res = await app.inject({ method: "POST", url: "/gated" });
    await app.close();
    expect(res.statusCode).toBe(403);
  });
});

async function upgrade() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/upgrade-writer" });
  await app.close();
  return res;
}

describe("POST /auth/upgrade-writer — canWrite OR holdsWriterLedger, never requireWriter", () => {
  it("refuses a READER with nothing earned, and opens NO Stripe account", async () => {
    sessionId = READER;
    const res = await upgrade();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(WRITER_ACCESS_REQUIRED);
    expect(stripeAccountsCreate).not.toHaveBeenCalled();
    expect(connectStripeAccount).not.toHaveBeenCalled();
    // It asked the ledger about THIS member.
    expect(calls.find((c) => c.sql.includes("FROM ledger_entries"))?.params[0]).toBe(READER);
  });

  it("lets a reader HOLDING EARNINGS through — money already earned must be collectable", async () => {
    sessionId = EARNER;
    await upgrade();
    expect(stripeAccountsCreate).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: lets a writer through, without asking the ledger", async () => {
    await upgrade();
    expect(stripeAccountsCreate).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.sql.includes("FROM ledger_entries"))).toBe(false);
  });
});
