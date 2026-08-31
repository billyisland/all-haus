import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// POST /auth/signup — the closed-beta flat refusal.
//
// closed-beta-gate.test.ts pins the Google OAuth branch and its header calls
// this path "trivially checked by hand" — but hand-checks don't survive a
// refactor of authRoutes: deleting the `if (CLOSED_BETA)` block failed zero
// tests (audit 2026-07-24). This file closes that hole with the same contract:
//
//   - beta closed → 403 closed_beta BEFORE parse/keypair/insert — nothing
//     provisioned, for a stale frontend or a hand-crafted request alike.
//   - beta open   → the route goes back to creating accounts (pins the gate,
//     not "returns 403 forever").
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

// --- collaborators -----------------------------------------------------------

const signup = vi.fn(async () => ({ id: "new-account" }));
const generateKeypair = vi.fn(async () => ({
  pubkeyHex: "ff".repeat(32),
  privkeyEncrypted: "enc",
}));

vi.mock("@platform-pub/shared/auth/accounts.js", () => ({
  signup: (...a: unknown[]) => signup(...(a as [])),
  // Permissive stand-in: the gate under test must refuse BEFORE parsing, and
  // the reopened case needs any payload to pass through to signup().
  SignupSchema: z.object({}).passthrough(),
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

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendMagicLinkEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: vi.fn(),
  invalidateAuthCache: vi.fn(),
}));

vi.mock("../src/middleware/admin.js", () => ({
  getAdminIds: vi.fn(async () => []),
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: (...a: unknown[]) => generateKeypair(...(a as [])),
  signEvent: vi.fn(),
}));

vi.mock("../src/lib/discovery-publish.js", () => ({
  republishProfile: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));

// auth.ts constructs a Stripe client at module load (requireEnv would throw
// before the test's env assignments run, since static imports hoist).
vi.mock("stripe", () => ({ default: vi.fn(() => ({})) }));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
}));

// Same per-test getter idiom as closed-beta-gate.test.ts: prove the route
// follows the flag in BOTH positions.
let closedBeta = true;
vi.mock("../src/lib/closed-beta.js", () => ({
  get CLOSED_BETA() {
    return closedBeta;
  },
  CLOSED_BETA_ERROR: "closed_beta",
}));

import { authRoutes } from "../src/routes/auth.js";

async function signupAs(payload: Record<string, unknown>) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  closedBeta = true;
  signup.mockClear();
  generateKeypair.mockClear();
});

describe("closed beta — /auth/signup flat refusal", () => {
  it("refuses signup, and creates absolutely nothing", async () => {
    const res = await signupAs({
      email: "stranger@example.com",
      username: "stranger",
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "closed_beta" });
    expect(generateKeypair).not.toHaveBeenCalled();
    expect(signup).not.toHaveBeenCalled();
  });

  it("provisions again once the beta is reopened", async () => {
    closedBeta = false;

    const res = await signupAs({
      email: "stranger@example.com",
      username: "stranger",
    });

    expect(res.statusCode).toBe(201);
    expect(generateKeypair).toHaveBeenCalledOnce();
    expect(signup).toHaveBeenCalledOnce();
  });
});
