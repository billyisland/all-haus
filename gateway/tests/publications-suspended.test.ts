import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// Publications are SUSPENDED (operator directive 2026-08-31; launch is solo
// author accounts only). This file pins
// the dark state — every gate, and just as importantly the things that are
// deliberately NOT gated.
//
// WHY IT EXISTS. The two pre-existing publication suites do not reach any of
// this: publication-member-finance-mandate.test.ts registers
// `publicationMembersRoutes` DIRECTLY, so it never sees the hook that lives on
// the composed `publicationRoutes` plugin, and publication-publisher.test.ts
// only exercises `generateDTag`. Both stayed green against every gate added on
// 2026-08-31 — i.e. the suspension shipped untested until this file. That is
// the "a passing suite proves nothing until you mutate it" trap in its exact
// house form.
//
// THE DISCRIMINATOR IS QUERY COUNT, NOT STATUS CODE. A publication route with
// the flag ON and an empty mocked DB answers 404 from its own handler, which is
// byte-identical to the gate's 404 — a status-code assertion would pass against
// a completely broken route and against no gate at all. The preHandler
// short-circuits BEFORE the handler, so "dark" is provable as: the request
// issued zero SQL. Mutate the hook out of routes/publications/index.ts and the
// dark cases go red because queries start flowing.
//
// Spec: docs/adr/PUBLICATIONS-SUSPENSION-PLAN.md · shared/src/lib/env.ts
// =============================================================================

let calls: Array<{ sql: string; params: unknown[] }> = [];

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  // Answer the shapes the handlers ask for; empty is fine — no test below
  // depends on a handler SUCCEEDING, only on whether it ran at all.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const READER = "00000000-0000-4000-8000-00000000aaaa";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

const { publicationRoutes } = await import("../src/routes/publications/index.js");
const { subscriptionPublicationRoutes } = await import(
  "../src/routes/subscriptions/publication.js"
);
const { subscriptionWriterRoutes } = await import(
  "../src/routes/subscriptions/writer.js"
);
const { freezeSource } = await import("../src/routes/feeds/formulas.js");

const PUB = "00000000-0000-4000-8000-00000000bbbb";

function dark() {
  delete process.env.PUBLICATIONS_ENABLED;
}
function live() {
  process.env.PUBLICATIONS_ENABLED = "1";
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  delete process.env.PUBLICATIONS_ENABLED;
});

// -----------------------------------------------------------------------------

describe("the composed publications plugin", () => {
  async function buildApp() {
    const app = Fastify();
    await app.register(publicationRoutes, { prefix: "/api/v1" });
    await app.ready();
    return app;
  }

  it("404s a public publication route while dark, without touching the database", async () => {
    dark();
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/publications/some-slug/public`,
    });
    expect(res.statusCode).toBe(404);
    // The real proof: the handler never ran.
    expect(calls).toHaveLength(0);
  });

  it("404s an authenticated publication route while dark, without touching the database", async () => {
    dark();
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/my/publications" });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses to CREATE a publication while dark, without touching the database", async () => {
    dark();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/publications",
      payload: { name: "The New Title", slug: "the-new-title" },
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("CONTROL: the same route reaches its handler when the flag is on", async () => {
    live();
    const app = await buildApp();
    await app.inject({ method: "GET", url: "/api/v1/my/publications" });
    // Without this control every assertion above would also pass against a
    // route that was simply broken, or deleted.
    expect(calls.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------

describe("publication subscriptions (per-route gate)", () => {
  async function buildApp() {
    const app = Fastify();
    // Registered together exactly as routes/subscriptions/index.ts composes
    // them — the point of this block is that they share one encapsulation
    // context, so a plugin-level hook here would have darkened the writer
    // routes too. That is why the gate is per route.
    await app.register(async (inner) => {
      await subscriptionWriterRoutes(inner);
      await subscriptionPublicationRoutes(inner);
    });
    await app.ready();
    return app;
  }

  it("404s subscribe while dark, without touching the database", async () => {
    dark();
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/publication/${PUB}`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("unsubscribe stays LIVE while dark — a reader can always withdraw", async () => {
    dark();
    const app = await buildApp();
    await app.inject({
      method: "DELETE",
      url: `/subscriptions/publication/${PUB}`,
    });
    // Query count, NOT status code (same reasoning as the writer-routes test
    // below: the empty mocked DB answers 404 "no such subscription", which is
    // byte-identical to the suspension 404). That it issued SQL proves the
    // handler ran. Cancel is deliberately ungated: an auto-renew subscription
    // is a standing recurring charge, and a cancel that 404s during the dark
    // window is LOST — re-enabling the flag would then charge a reader who
    // provably tried to stop it. Re-add requirePublicationsEnabled() to the
    // DELETE route and this goes red, which is the point of it.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("leaves the WRITER subscription routes alone — no collateral darkening", async () => {
    dark();
    const app = await buildApp();
    await app.inject({
      method: "DELETE",
      url: `/subscriptions/${READER}`,
    });
    // Query count, NOT status code — this route answers 404 against the empty
    // mocked DB ("no such subscription"), which is byte-identical to the
    // suspension 404 and so cannot tell the two apart. That it issued SQL is
    // the proof it reached its handler: writer subscriptions are not suspended.
    // Mutate the per-route gate in subscriptions/publication.ts into a
    // plugin-level addHook and this goes red, which is the whole point of it.
    expect(calls.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------

describe("formula projection (feeds/formulas.ts::freezeSource)", () => {
  const row = {
    source_type: "publication" as const,
    publication_pubkey: "a".repeat(64),
    publication_name: "The Title",
    account_pubkey: null,
    account_display_name: null,
    account_username: null,
    tag_name: null,
    external_protocol: null,
    external_source_uri: null,
    weight: "1",
    sampling_mode: "all",
    exclude_replies: false,
  };

  it("excludes a publication source while dark", () => {
    dark();
    // null is what the caller counts as `excludedCount` — so the source is
    // COUNTED AND SHOWN to the sharer, never silently dropped (ADR §6).
    expect(freezeSource(row as never)).toBeNull();
  });

  it("CONTROL: the same row travels when the flag is on", () => {
    live();
    const frozen = freezeSource(row as never);
    expect(frozen).not.toBeNull();
    expect(frozen?.sourceType).toBe("publication");
    expect(frozen?.tagValue).toBe("a".repeat(64));
  });
});
