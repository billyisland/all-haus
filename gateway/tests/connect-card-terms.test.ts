import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// POST /auth/connect-card — the card and the Reader Terms arrive together.
//
// Reader acceptance IS card registration (operator decision A3, 2026-09-16), so
// the version is a REQUIRED field on this request and the route refuses the
// card without it. A value the client may omit is a value a stale client omits,
// and the card would then register with nothing recorded — which is the state
// this route exists to stop existing.
//
// WHAT THIS FILE ASSERTS IS WHETHER STRIPE WAS TOUCHED AND WHAT WAS WRITTEN,
// never the status code alone. The refusal has to land before the SetupIntent
// is retrieved and before the customer's default payment method is set: a 400
// returned after those is a card attached at Stripe with no record here of why.
//
// AND THE VERSION STAMPED IS THE SERVER'S. The obvious shortcut is to write
// whatever string the client sent, which records an acceptance of text nobody
// can identify. The route compares first and then stamps its own constant, so
// the write is asserted against `READER_TERMS_VERSION`, not against the body.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const ACCOUNT = "member-1";

const retrieve = vi.fn();
const customersUpdate = vi.fn(async () => ({}));
vi.mock("stripe", () => ({
  default: vi.fn(() => ({
    setupIntents: { retrieve: (...a: unknown[]) => retrieve(...(a as [])) },
    customers: { update: (...a: unknown[]) => customersUpdate(...(a as [])) },
  })),
}));

const connectPaymentMethod = vi.fn(async () => undefined);
vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  signup: vi.fn(),
  signupSchema: () => z.object({}).passthrough(),
  getAccount: vi.fn(async () => ({ id: ACCOUNT, stripeCustomerId: null })),
  updateProfile: vi.fn(),
  connectStripeAccount: vi.fn(),
  connectPaymentMethod: (...a: unknown[]) => connectPaymentMethod(...(a as [])),
}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({ tabSettlementThresholdPence: 800 })),
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
    req.session = { sub: ACCOUNT };
  },
  invalidateAuthCache: vi.fn(),
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
import { READER_TERMS_VERSION } from "@platform-pub/shared/lib/terms-versions.js";

async function connect(payload: unknown) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/connect-card",
    payload: payload as Record<string, unknown>,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  retrieve.mockReset();
  retrieve.mockResolvedValue({
    id: "seti_1",
    status: "succeeded",
    metadata: { account_id: ACCOUNT },
    customer: "cus_1",
    payment_method: "pm_1",
  });
  customersUpdate.mockClear();
  connectPaymentMethod.mockClear();
  // Nothing here should reach the payment service's card-connected hook.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});

describe("POST /auth/connect-card — the acceptance rides the card", () => {
  it("records the card with the SERVER's current version", async () => {
    const res = await connect({
      setupIntentId: "seti_1",
      readerTermsVersion: READER_TERMS_VERSION,
    });

    expect(res.statusCode).toBe(200);
    expect(connectPaymentMethod).toHaveBeenCalledWith(
      ACCOUNT,
      "cus_1",
      READER_TERMS_VERSION,
    );
  });

  it("refuses a stale version without touching Stripe or the account", async () => {
    const res = await connect({ setupIntentId: "seti_1", readerTermsVersion: "0.4" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("terms_version_mismatch");
    // The current version comes back so the client can render THAT text and
    // ask again, rather than guessing.
    expect(res.json().current).toBe(READER_TERMS_VERSION);
    // The whole finding: refused BEFORE the SetupIntent is retrieved and
    // before the customer's default payment method is set. A refusal after
    // those leaves a card attached at Stripe with nothing recorded here.
    expect(retrieve).not.toHaveBeenCalled();
    expect(customersUpdate).not.toHaveBeenCalled();
    expect(connectPaymentMethod).not.toHaveBeenCalled();
  });

  it("refuses a request that omits the version entirely", async () => {
    // Required, never optional — this is the stale-frontend case, and the one
    // that would otherwise register a card silently.
    const res = await connect({ setupIntentId: "seti_1" });
    expect(res.statusCode).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
    expect(connectPaymentMethod).not.toHaveBeenCalled();
  });

  it("never coerces: a text sub-version is accepted, a major is not", async () => {
    const major = READER_TERMS_VERSION.split(".")[0];
    const ok = await connect({
      setupIntentId: "seti_1",
      readerTermsVersion: `${major}.9`,
    });
    expect(ok.statusCode).toBe(200);
    // And what was WRITTEN is still the server's own string, not the `.9` the
    // client sent — the record has to name a text that exists.
    expect(connectPaymentMethod).toHaveBeenCalledWith(
      ACCOUNT,
      "cus_1",
      READER_TERMS_VERSION,
    );

    connectPaymentMethod.mockClear();
    const nope = await connect({
      setupIntentId: "seti_1",
      readerTermsVersion: `${Number(major) + 1}.0`,
    });
    expect(nope.statusCode).toBe(400);
    expect(connectPaymentMethod).not.toHaveBeenCalled();
  });
});
