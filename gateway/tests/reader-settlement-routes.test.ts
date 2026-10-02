import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The two routes a READER settles from — POST /my/tab/settle (Reader Terms 5.3)
// and the final charge inside POST /auth/delete-account (12.1).
//
// WHAT IS UNDER TEST HERE IS THE BRANCHING, and it is the whole of the risk.
// The settlement itself is the payment service's, driven for real in
// payment-service/tests/conformance-settlement.test.ts; what these routes add
// is a decision about what to DO with each outcome — and one of those decisions
// deletes an account. Two of the eight outcomes mean "the card may have been
// charged", and treating either as "nothing happened" would delete a member's
// account on top of a live payment.
//
// So every deletion case asserts whether the DELETION SQL RAN, not the status
// code: a 402 returned after the account was soft-deleted would pass a
// status-only assertion and be the exact failure this ordering exists to stop.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

// --- the DB, as a log of what the routes actually issued ---------------------

const statements: { sql: string; params: unknown[] }[] = [];
let tabBalancePence = 0;

function query(sql: string, params?: unknown[]) {
  // A COPY of the params, never the live array — a later call must not appear
  // to have mutated an earlier one.
  statements.push({ sql, params: [...(params ?? [])] });

  // The route reads the operational balance off reading_tabs to decide whether
  // there is anything to settle at all. Answered from the SQL it was handed.
  if (/SELECT balance_pence FROM reading_tabs WHERE reader_id = \$1/.test(sql)) {
    return Promise.resolve({
      rows: tabBalancePence === null ? [] : [{ balance_pence: tabBalancePence }],
      rowCount: 1,
    });
  }
  if (/SELECT email, nostr_pubkey FROM accounts/.test(sql)) {
    return Promise.resolve({
      rows: [{ email: "member@example.com", nostr_pubkey: "a".repeat(64) }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

const withTransaction = vi.fn(
  async (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
);

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: (cb: never) => withTransaction(cb),
  loadConfig: vi.fn(async () => ({ tabSettlementThresholdPence: 800 })),
}));

const requestSettlement = vi.fn();
vi.mock("../src/lib/settlement-client.js", () => ({
  requestSettlement: (...a: unknown[]) => requestSettlement(...a),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: "member-1" };
  },
  invalidateAuthCache: vi.fn(),
}));

// --- the rest of auth.ts's world, stubbed ------------------------------------

vi.mock("@platform-pub/shared/auth/accounts.js", async () => {
  const { z } = await import("zod");
  return {
    signup: vi.fn(),
    signupSchema: () => z.object({}).passthrough(),
    getAccount: vi.fn(),
    updateProfile: vi.fn(),
    connectStripeAccount: vi.fn(),
    connectPaymentMethod: vi.fn(),
  };
});
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
vi.mock("../src/middleware/admin.js", () => ({ getAdminIds: vi.fn(async () => []) }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: vi.fn(),
  signEvent: vi.fn(async () => ({ id: "evt" })),
}));
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn() }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));
vi.mock("../src/lib/closed-beta.js", () => ({
  CLOSED_BETA: true,
  CLOSED_BETA_ERROR: "closed_beta",
}));
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

import { myAccountRoutes } from "../src/routes/my-account.js";
import { authRoutes } from "../src/routes/auth.js";

async function settleTab() {
  const app = Fastify();
  await app.register(myAccountRoutes, { prefix: "/api/v1" });
  const res = await app.inject({ method: "POST", url: "/api/v1/my/tab/settle" });
  await app.close();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function deleteAccount() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/delete-account",
    payload: { emailConfirmation: "member@example.com" },
  });
  await app.close();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** Did the route get as far as deleting anything? */
const deletionRan = () =>
  statements.some((s) => /UPDATE accounts\s+SET status = 'deleted'/.test(s.sql));

beforeEach(() => {
  statements.length = 0;
  tabBalancePence = 0;
  requestSettlement.mockReset();
  withTransaction.mockClear();
});

// ---------------------------------------------------------------------------
describe("POST /my/tab/settle — every outcome gets its own answer", () => {
  it("reports the amount charged", async () => {
    requestSettlement.mockResolvedValue({
      kind: "charged",
      settlementId: "s1",
      amountPence: 640,
    });

    const { status, body } = await settleTab();

    expect(status).toBe(200);
    expect(body).toMatchObject({ settled: true, amountPence: 640 });
  });

  it("asks the payment service for a READER_REQUESTED settlement, never another trigger", async () => {
    // The trigger is what the settlement row records, and 'threshold' here
    // would assert the tab reached a figure it may never have reached.
    requestSettlement.mockResolvedValue({ kind: "nothing_due" });

    await settleTab();

    expect(requestSettlement).toHaveBeenCalledWith("member-1", "reader_requested");
  });

  it("treats an empty tab as a success, not a failure", async () => {
    requestSettlement.mockResolvedValue({ kind: "nothing_due" });

    const { status, body } = await settleTab();

    expect(status).toBe(200);
    expect(body).toMatchObject({ settled: false, reason: "nothing_due" });
  });

  it("names the figure when the tab is under Stripe's floor", async () => {
    requestSettlement.mockResolvedValue({ kind: "below_minimum", balancePence: 12 });

    const { status, body } = await settleTab();

    expect(status).toBe(200);
    expect(body).toMatchObject({ settled: false, reason: "below_minimum", balancePence: 12 });
  });

  it("409s while a settlement is already running", async () => {
    requestSettlement.mockResolvedValue({ kind: "in_flight" });

    const { status, body } = await settleTab();

    expect(status).toBe(409);
    expect(body.error).toBe("settlement_in_flight");
  });

  it("402s a reader with no card, pointing at the card and not at a retry", async () => {
    requestSettlement.mockResolvedValue({ kind: "no_card" });

    const { status, body } = await settleTab();

    expect(status).toBe(402);
    expect(body.error).toBe("card_required");
  });

  it.each([["card_action_required"], ["card_declined"]])(
    "402s on a card that will not work (%s)",
    async (kind) => {
      requestSettlement.mockResolvedValue({ kind, settlementId: "s1" });

      const { status, body } = await settleTab();

      expect(status).toBe(402);
      expect(body.error).toBe("card_action_required");
    },
  );

  it("502s on an ambiguous outcome, and does not call it a failure", async () => {
    // The reader must not be told "that didn't work" about a charge that may
    // have gone through, because the obvious response is to press again.
    requestSettlement.mockResolvedValue({ kind: "ambiguous" });

    const { status, body } = await settleTab();

    expect(status).toBe(502);
    expect(body.error).toBe("settlement_unconfirmed");
    expect(String(body.message)).not.toMatch(/failed|did not go/i);
  });
});

// ---------------------------------------------------------------------------
describe("POST /auth/delete-account — the final charge comes first", () => {
  it("settles an outstanding tab BEFORE deleting anything", async () => {
    tabBalancePence = 500;
    requestSettlement.mockResolvedValue({
      kind: "charged",
      settlementId: "s1",
      amountPence: 500,
    });

    const { status } = await deleteAccount();

    expect(status).toBe(200);
    expect(requestSettlement).toHaveBeenCalledWith("member-1", "account_closure");
    expect(deletionRan()).toBe(true);
  });

  it("does not call the settlement at all when nothing is owed", async () => {
    tabBalancePence = 0;

    const { status } = await deleteAccount();

    expect(status).toBe(200);
    expect(requestSettlement).not.toHaveBeenCalled();
    expect(deletionRan()).toBe(true);
  });

  it("REFUSES the deletion when the final charge declines — and deletes nothing", async () => {
    tabBalancePence = 500;
    requestSettlement.mockResolvedValue({ kind: "card_declined", settlementId: "s1" });

    const { status, body } = await deleteAccount();

    expect(status).toBe(402);
    expect(body.error).toBe("final_settlement_failed");
    expect(body.outstandingPence).toBe(500);
    expect(deletionRan()).toBe(false);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("REFUSES the deletion on an AMBIGUOUS outcome — the charge may be live", async () => {
    // The case the whole ordering exists for. Nothing here knows whether the
    // reader has been charged, and an account deleted on top of a live payment
    // leaves a charge with nothing to explain it.
    tabBalancePence = 500;
    requestSettlement.mockResolvedValue({ kind: "ambiguous" });

    const { status, body } = await deleteAccount();

    expect(status).toBe(409);
    expect(body.error).toBe("final_settlement_pending");
    expect(deletionRan()).toBe(false);
  });

  it("REFUSES the deletion while a settlement is in flight", async () => {
    tabBalancePence = 500;
    requestSettlement.mockResolvedValue({ kind: "in_flight" });

    const { status, body } = await deleteAccount();

    expect(status).toBe(409);
    expect(body.error).toBe("final_settlement_pending");
    expect(deletionRan()).toBe(false);
  });

  it("lets a CARD-LESS member leave, with the debt standing", async () => {
    // Reader Terms 6.3: the amount stays owed and we may ask for it. What it
    // must not do is hold a member on the platform over a debt no payment
    // method exists to clear — the tab row survives the soft delete.
    tabBalancePence = 500;
    requestSettlement.mockResolvedValue({ kind: "no_card" });

    const { status } = await deleteAccount();

    expect(status).toBe(200);
    expect(deletionRan()).toBe(true);
    // And nothing wrote the debt off on the way out.
    expect(
      statements.some((s) => /UPDATE reading_tabs/.test(s.sql)),
    ).toBe(false);
  });

  it("lets a member leave when the tab is under Stripe's floor", async () => {
    tabBalancePence = 12;
    requestSettlement.mockResolvedValue({ kind: "below_minimum", balancePence: 12 });

    const { status } = await deleteAccount();

    expect(status).toBe(200);
    expect(deletionRan()).toBe(true);
  });
});
