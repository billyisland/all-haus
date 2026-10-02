import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// A USERNAME THAT IS THE ADDRESS OF A PAGE IS REFUSED (MODERNHAUS-ADR §R2.10).
//
// A profile is `/<username>`, and every fixed top-level path shadows it: a
// member who took `settings` would have a profile nobody can reach. The rule is
// `shared/src/auth/reserved-usernames.ts` (derived from the web app, Next's
// config and nginx by `shared/tests/reserved-usernames.test.ts`); these cases
// drive the two routes that take a typed name. What is asserted is whether the
// UPDATE RAN — a refusal and a success are both plausible JSON.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const updates: unknown[][] = [];

function query(sql: string, params?: unknown[]) {
  if (sql.includes("UPDATE accounts")) {
    updates.push([...(params ?? [])]);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("SELECT username, username_changed_at FROM accounts")) {
    return Promise.resolve({ rows: [{ username: "oldname", username_changed_at: null }], rowCount: 1 });
  }
  // Availability: nobody holds anything.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({ tabSettlementThresholdPence: 800 })),
}));

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

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const invalidateAuthCache = vi.fn();
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: "member-1" };
  },
  invalidateAuthCache: (...a: unknown[]) => invalidateAuthCache(...(a as [])),
}));

vi.mock("../src/middleware/admin.js", () => ({ getAdminIds: vi.fn(async () => []) }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: vi.fn(),
  signEvent: vi.fn(),
}));
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn(async () => undefined) }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));
vi.mock("../src/lib/closed-beta.js", () => ({
  CLOSED_BETA: true,
  CLOSED_BETA_ERROR: "closed_beta",
}));

// auth.ts constructs a Stripe client at module load.
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

import { authRoutes } from "../src/routes/auth.js";
import { USERNAME_RESERVED_MESSAGE } from "@platform-pub/shared/auth/reserved-usernames.js";

async function send(method: "POST" | "GET", url: string, payload?: Record<string, unknown>) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({ method, url: `/api/v1${url}`, payload });
  await app.close();
  return res;
}

beforeEach(() => {
  updates.length = 0;
});

describe("POST /auth/change-username", () => {
  it("refuses the name of a page, and writes nothing", async () => {
    const res = await send("POST", "/auth/change-username", { newUsername: "settings" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(USERNAME_RESERVED_MESSAGE);
    expect(updates).toEqual([]);
  });

  it("refuses a name under a shadowing prefix, whatever its case", async () => {
    const res = await send("POST", "/auth/change-username", { newUsername: "RSS-Weekly" });
    expect(res.statusCode).toBe(400);
    expect(updates).toEqual([]);
  });

  it("takes an ordinary name (the control: the route does write)", async () => {
    const res = await send("POST", "/auth/change-username", { newUsername: "marguerite" });
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toBe("marguerite");
  });
});

describe("GET /auth/check-username/:username", () => {
  it("says a page's name is reserved, not merely taken", async () => {
    const res = await send("GET", "/auth/check-username/reader");
    expect(res.json()).toEqual({ available: false, reason: "Reserved" });
  });

  it("says an ordinary free name is available", async () => {
    const res = await send("GET", "/auth/check-username/marguerite");
    expect(res.json()).toEqual({ available: true });
  });
});
