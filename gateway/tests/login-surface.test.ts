import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// POST /auth/login — `surface` (MODERNHAUS-ADR §D1.8.1).
//
// The emailed link opens the verify page of the register that asked for it.
// `surface` is a closed enum, never a path: an unknown value is a 400 and no
// link is requested at all, which is asserted by whether the token was MINTED,
// not by the status alone (testing.md).
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

// --- collaborators -----------------------------------------------------------

const requestMagicLink = vi.fn(async () => ({
  token: "tok",
  expiresAt: new Date(Date.now() + 15 * 60_000),
}));
const sendMagicLinkEmail = vi.fn(async () => {});

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
  requestMagicLink: (...a: unknown[]) => requestMagicLink(...(a as [])),
  verifyMagicLink: vi.fn(),
}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendMagicLinkEmail: (...a: unknown[]) => sendMagicLinkEmail(...(a as [])),
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
  generateKeypair: vi.fn(),
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

vi.mock("../src/lib/closed-beta.js", () => ({
  CLOSED_BETA: true,
  CLOSED_BETA_ERROR: "closed_beta",
}));

import { authRoutes } from "../src/routes/auth.js";

async function login(payload: Record<string, unknown>) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload });
  await app.close();
  return res;
}

beforeEach(() => {
  requestMagicLink.mockClear();
  sendMagicLinkEmail.mockClear();
});

describe("POST /auth/login — surface", () => {
  it("absent: the full site's link, as before", async () => {
    const res = await login({ email: "m@example.com" });
    expect(res.statusCode).toBe(200);
    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
    expect(sendMagicLinkEmail.mock.calls[0]).toEqual([
      "m@example.com",
      "tok",
      expect.any(Date),
      null,
      null,
    ]);
  });

  it("modernhaus: the surface reaches the email, with the arrival beside it", async () => {
    const res = await login({ email: "m@example.com", surface: "modernhaus", arrivalDTag: "a-piece" });
    expect(res.statusCode).toBe(200);
    expect(sendMagicLinkEmail.mock.calls[0]).toEqual([
      "m@example.com",
      "tok",
      expect.any(Date),
      "a-piece",
      "modernhaus",
    ]);
  });

  it("an unknown surface (or a path) is refused, and no link is minted", async () => {
    for (const surface of ["/evil", "elsewhere", "https://evil.example/"]) {
      const res = await login({ email: "m@example.com", surface });
      expect(res.statusCode).toBe(400);
    }
    expect(requestMagicLink).not.toHaveBeenCalled();
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });
});
