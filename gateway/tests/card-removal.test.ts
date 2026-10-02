import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// DELETE /auth/payment-method — Reader Terms 2.4.
//
// "You can change or remove it in your account settings at any time; removing
// it will pause paid reading until you add another." There was no route at all
// until now, so the sentence described nothing.
//
// THE ASSERTION THAT MATTERS IS AN ABSENCE. Removing a card must not touch the
// tab: Reader Terms 6.3 says an unpaid tab stays owed, and a route that helpfully
// zeroed the balance — or settled it without being asked — would be forgiving a
// debt or taking money on a press that says "remove". So the cases below read
// the whole statement log and assert that `reading_tabs`, `read_events` and
// `ledger_entries` were never named, which is the one thing a status code
// cannot tell you.
//
// The second is that it detaches EVERY card, not the default: each card setup
// attaches a new PaymentMethod and leaves the previous one attached, so a
// removal that took only the current one would leave the reader's older cards
// on our customer — exactly what they asked us to stop holding.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const statements: { sql: string; params: unknown[] }[] = [];
let customerId: string | null = "cus_1";

function query(sql: string, params?: unknown[]) {
  statements.push({ sql, params: [...(params ?? [])] });
  if (/SELECT stripe_customer_id FROM accounts WHERE id = \$1/.test(sql)) {
    return Promise.resolve({
      rows: [{ stripe_customer_id: customerId }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({ tabSettlementThresholdPence: 800 })),
}));

// --- the Stripe double -------------------------------------------------------

const stripeState = vi.hoisted(() => ({
  /** Cards currently attached to the customer. */
  attached: ["pm_new", "pm_old"] as string[],
  detached: [] as string[],
  /** Payment methods whose detach throws. */
  failDetach: new Set<string>(),
  listThrows: false,
}));

vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    paymentMethods: {
      list: async () => {
        if (stripeState.listThrows) throw new Error("stripe is down");
        return { data: stripeState.attached.map((id) => ({ id })) };
      },
      detach: async (id: string) => {
        if (stripeState.failDetach.has(id)) throw new Error("detach failed");
        stripeState.detached.push(id);
        return { id };
      },
    },
  })),
}));

const invalidateAuthCache = vi.fn();
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: "member-1" };
  },
  invalidateAuthCache: (...a: unknown[]) => invalidateAuthCache(...(a as [])),
}));

vi.mock("../src/lib/settlement-client.js", () => ({
  requestSettlement: vi.fn(async () => ({ kind: "nothing_due" })),
}));

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
  signEvent: vi.fn(),
}));
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn() }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));
vi.mock("../src/lib/closed-beta.js", () => ({
  CLOSED_BETA: true,
  CLOSED_BETA_ERROR: "closed_beta",
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

import { authRoutes } from "../src/routes/auth.js";

async function removeCard() {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({
    method: "DELETE",
    url: "/api/v1/auth/payment-method",
  });
  await app.close();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

const named = (table: RegExp) => statements.some((s) => table.test(s.sql));

beforeEach(() => {
  statements.length = 0;
  customerId = "cus_1";
  stripeState.attached = ["pm_new", "pm_old"];
  stripeState.detached = [];
  stripeState.failDetach = new Set();
  stripeState.listThrows = false;
  invalidateAuthCache.mockClear();
});

describe("DELETE /auth/payment-method", () => {
  it("detaches EVERY attached card, not just the default", async () => {
    const { status, body } = await removeCard();

    expect(status).toBe(200);
    expect(stripeState.detached).toEqual(["pm_new", "pm_old"]);
    expect(body).toMatchObject({ hasPaymentMethod: false, detached: 2, failed: 0 });
  });

  it("clears the customer id — and that statement names no other column", async () => {
    await removeCard();

    const update = statements.find((s) => /UPDATE accounts/.test(s.sql));
    expect(update).toBeTruthy();
    expect(update!.sql).toMatch(/stripe_customer_id = NULL/);
    // `updated_at` is bookkeeping; anything else would be this route deciding
    // something about the member it was not asked to decide.
    expect(update!.sql.replace(/updated_at = now\(\)/, "")).not.toMatch(
      /free_allowance|card_action_required_at|status/,
    );
  });

  it("LEAVES THE DEBT ALONE — the tab, the reads and the ledger are never named", async () => {
    await removeCard();

    expect(named(/reading_tabs/)).toBe(false);
    expect(named(/read_events/)).toBe(false);
    expect(named(/ledger_entries/)).toBe(false);
    expect(named(/tab_settlements/)).toBe(false);
  });

  it("takes no money on the way out", async () => {
    // "Remove" is not a gesture that authorises a charge. A reader who wants to
    // pay first has Settle now; this press must not do it for them.
    const { requestSettlement } = await import("../src/lib/settlement-client.js");

    await removeCard();

    expect(requestSettlement).not.toHaveBeenCalled();
  });

  it("refreshes the session cache, so hasPaymentMethod moves everywhere at once", async () => {
    await removeCard();

    expect(invalidateAuthCache).toHaveBeenCalledWith("member-1");
  });

  it("409s when there is no card to remove, rather than reporting success", async () => {
    customerId = null;

    const { status, body } = await removeCard();

    expect(status).toBe(409);
    expect(body.error).toBe("no_payment_method");
    expect(named(/UPDATE accounts/)).toBe(false);
  });

  it("keeps going when ONE card will not detach, and counts the shortfall", async () => {
    // A partial outcome is not a total one: the card that did come off is off.
    stripeState.failDetach = new Set(["pm_old"]);

    const { status, body } = await removeCard();

    expect(status).toBe(200);
    expect(body).toMatchObject({ detached: 1, failed: 1 });
    expect(stripeState.detached).toEqual(["pm_new"]);
    expect(named(/UPDATE accounts/)).toBe(true);
  });

  it("changes NOTHING when every detach fails — Stripe still holds the cards", async () => {
    // Clearing the customer id here would tell the reader their card was gone
    // while Stripe still held all of them, and leave us unable to settle.
    stripeState.failDetach = new Set(["pm_new", "pm_old"]);

    const { status } = await removeCard();

    expect(status).toBe(502);
    expect(named(/UPDATE accounts/)).toBe(false);
  });

  it("changes nothing when Stripe cannot even be asked", async () => {
    stripeState.listThrows = true;

    const { status } = await removeCard();

    expect(status).toBe(502);
    expect(named(/UPDATE accounts/)).toBe(false);
  });

  it("succeeds on a customer with no cards attached", async () => {
    // A customer record with nothing on it is not a failure: the end state the
    // reader asked for is already true, and the local flag still has to move.
    stripeState.attached = [];

    const { status, body } = await removeCard();

    expect(status).toBe(200);
    expect(body).toMatchObject({ detached: 0, failed: 0 });
    expect(named(/UPDATE accounts/)).toBe(true);
  });
});
