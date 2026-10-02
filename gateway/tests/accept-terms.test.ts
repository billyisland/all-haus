import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

// =============================================================================
// POST /auth/accept-terms — the acceptance record.
//
// WHAT THIS FILE ASSERTS IS WHAT REACHED THE DATABASE, not the status code.
// The failure the route exists to prevent is silent: coerce a client's stale
// version to the current one and the row records an acceptance of text the
// member never saw, with a 200 and a plausible body. So every case here reads
// the captured SQL and its PARAMS.
//
// The dispatch is on `params`, deliberately. The reader and writer UPDATEs are
// the same statement shape against the same table, and a mock keyed on "does
// the SQL mention accounts" answers identically for both — which is how
// transposing the two column pairs would stay green. The column names are
// read out of the SQL and the accepted version out of `params[1]`.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

// --- what the route wrote ----------------------------------------------------

interface Write {
  sql: string;
  params: unknown[];
}
const writes: Write[] = [];

function query(sql: string, params?: unknown[]) {
  if (sql.includes("UPDATE accounts")) {
    // A copy, never the live array: a test that hands back the object the
    // route passed lets a later call appear to have mutated an earlier one.
    writes.push({ sql, params: [...(params ?? [])] });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
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
vi.mock("../src/lib/discovery-publish.js", () => ({ republishProfile: vi.fn() }));
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
import {
  READER_TERMS_VERSION,
  WRITER_TERMS_VERSION,
  TERMS_KINDS,
} from "@platform-pub/shared/lib/terms-versions.js";

async function accept(payload: unknown) {
  const app = Fastify();
  await app.register(authRoutes, { prefix: "/api/v1" });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/accept-terms",
    payload: payload as Record<string, unknown>,
  });
  await app.close();
  return res;
}

beforeEach(() => {
  writes.length = 0;
  invalidateAuthCache.mockClear();
});

describe("POST /auth/accept-terms", () => {
  it("records the reader acceptance against the reader columns", async () => {
    const res = await accept({ kind: "reader", version: READER_TERMS_VERSION });

    expect(res.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    const [w] = writes;
    // The columns, read out of the SQL — the discriminator between the two
    // kinds is which pair the statement names.
    expect(w.sql).toContain("reader_terms_accepted_at");
    expect(w.sql).toContain("reader_terms_version");
    expect(w.sql).not.toContain("writer_terms");
    // The version stamped is the SERVER's, and it is in the params.
    expect(w.params[0]).toBe("member-1");
    expect(w.params[1]).toBe(READER_TERMS_VERSION);
  });

  it("records the writer acceptance against the writer columns", async () => {
    const res = await accept({ kind: "writer", version: WRITER_TERMS_VERSION });

    expect(res.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w.sql).toContain("writer_terms_accepted_at");
    expect(w.sql).toContain("writer_terms_version");
    expect(w.sql).not.toContain("reader_terms");
    expect(w.params[1]).toBe(WRITER_TERMS_VERSION);
  });

  it("does not move a timestamp that already records this version", async () => {
    // First-write-wins per version: a second press, a retry or a second tab
    // must not rewrite when the member accepted this text. The guard is in the
    // WHERE clause, so this is a structural pin — whether Postgres then
    // matches zero rows is the DB-backed test's question, not this one.
    await accept({ kind: "reader", version: READER_TERMS_VERSION });
    expect(writes[0].sql).toContain("IS DISTINCT FROM $2");
  });

  it("refuses a version this server does not offer, and writes nothing", async () => {
    const res = await accept({ kind: "reader", version: "99.0" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("terms_version_mismatch");
    // The current version comes back so the client can render THAT text and
    // ask again, rather than guessing.
    expect(res.json().current).toBe(READER_TERMS_VERSION);
    // The whole finding: a stale version must never be coerced to the current
    // one. Deleting the refusal turns this red.
    expect(writes).toHaveLength(0);
  });

  it("refuses an unknown kind, and writes nothing", async () => {
    const res = await accept({ kind: "publisher", version: READER_TERMS_VERSION });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("refuses a missing version rather than defaulting it", async () => {
    // A fallback is for an absent value, never a malformed one — and an absent
    // one here is not a fallback case either: nobody accepted anything.
    const res = await accept({ kind: "reader" });
    expect(res.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it("invalidates the auth cache so /auth/me does not answer from the old row", async () => {
    await accept({ kind: "writer", version: WRITER_TERMS_VERSION });
    expect(invalidateAuthCache).toHaveBeenCalledWith("member-1");
  });

  it("every kind the wire accepts has a column pair", async () => {
    // TERMS_KINDS is the zod enum's source, so a third text added to it with
    // no column mapping would 500 here rather than ship half-added.
    expect(TERMS_KINDS.length).toBeGreaterThan(1);
    for (const kind of TERMS_KINDS) {
      writes.length = 0;
      const version = kind === "reader" ? READER_TERMS_VERSION : WRITER_TERMS_VERSION;
      const res = await accept({ kind, version });
      expect(res.statusCode).toBe(200);
      expect(writes).toHaveLength(1);
      expect(writes[0].sql).toContain(`${kind}_terms_version`);
    }
  });
});
