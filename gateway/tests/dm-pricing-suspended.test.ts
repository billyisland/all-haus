import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// PRICED DMs ARE SUSPENDED, AND THE BRAKE IS AT THE ROUTES.
//
// `dm_pricing` was written and read back by its own settings form and by
// nothing else — no send path has ever consulted it — so the fee a member set
// on the Network page ("discourage unwanted messages by setting a fee") stopped
// nobody. It was never retired; it was never finished. `DM_PRICING_ENABLED`
// (off by default) darkens the four routes that are the whole of the entry to
// the four service functions.
//
// Three things this pins, and the third is the one worth a test of its own.
//
//   1. OFF ⇒ 404, not 403. The web reads that 404 as "the feature is not here"
//      and cuts the surface; 403 would read as "you may not" to a member who
//      has done nothing, and would leave the panel rendering.
//   2. OFF ⇒ THE SERVICE IS NEVER REACHED, on the writes as much as the read.
//      A member holding a stale tab must not be able to save a figure that will
//      never be charged, and "the route answered 404" is not the same claim as
//      "nothing was written" — a guard placed after the work would pass a
//      status-code assertion and still write the row.
//   3. ON ⇒ THE ROUTES WORK. A brake that darkens a feature permanently is
//      indistinguishable from deleting it, and the whole point of suspending
//      rather than deleting is that the flag is the only thing standing in the
//      way. Without this case, removing the service call entirely would pass.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const service = {
  getDmPricing: vi.fn(async () => ({ defaultPricePence: 250, overrides: [] })),
  setDefaultDmPrice: vi.fn(async () => {}),
  setDmPriceOverride: vi.fn(async () => {}),
  removeDmPriceOverride: vi.fn(async () => {}),
};

// The route module reads this at import time (a zod enum), so the mock has to
// carry it or nothing registers at all.
vi.mock("../src/services/messages.js", () => ({
  ...service,
  DM_REACTION_TYPES: ["like", "love", "laugh", "wow", "sad", "angry"] as const,
}));

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({})),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: "11111111-1111-4111-8111-111111111111" };
    done();
  },
  optionalAuth: (_req: any, _reply: any, done: any) => done(),
}));

const { messageRoutes } = await import("../src/routes/messages.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(messageRoutes);
  return app;
}

const TARGET = "22222222-2222-4222-8222-222222222222";

// The four routes, with a body where the handler parses one.
const ROUTES = [
  { method: "GET" as const, url: "/settings/dm-pricing" },
  {
    method: "PUT" as const,
    url: "/settings/dm-pricing",
    payload: { defaultPricePence: 250 },
  },
  {
    method: "PUT" as const,
    url: `/settings/dm-pricing/override/${TARGET}`,
    payload: { pricePence: 500 },
  },
  {
    method: "DELETE" as const,
    url: `/settings/dm-pricing/override/${TARGET}`,
  },
];

beforeEach(() => {
  for (const fn of Object.values(service)) fn.mockClear();
  delete process.env.DM_PRICING_ENABLED;
});

describe("DM pricing is dark by default", () => {
  it("is off when the variable is unset — the shipping state", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/settings/dm-pricing" });
    expect(res.statusCode).toBe(404);
  });

  it("is off for any value but the literal '1' — and a near-miss SAYS SO", async () => {
    // "true"/"yes"/"0" all mean off: an operator's near-miss must not
    // half-open a money-adjacent feature. But OFF is only half the contract.
    // `"0"` and an empty value are legal spellings of off and stay silent;
    // `"true"` is MALFORMED, and the first version of this test pinned the
    // silence — an operator who set the flag the way `docker-compose.yml`
    // spells its own booleans got a feature that never appeared and nothing
    // anywhere saying why (`envFlag`, shared/src/lib/env.ts).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const v of ["0", "true", "yes", ""]) {
        process.env.DM_PRICING_ENABLED = v;
        warn.mockClear();
        const app = await build();
        const res = await app.inject({
          method: "GET",
          url: "/settings/dm-pricing",
        });
        expect(res.statusCode, `DM_PRICING_ENABLED=${JSON.stringify(v)}`).toBe(
          404,
        );
        const said = warn.mock.calls.some((c) =>
          String(c[0]).includes("DM_PRICING_ENABLED"),
        );
        // Warn-once is per variable for the process, so only the first
        // malformed value in this loop can carry the line — which is exactly
        // the contract, and why the legal spellings are asserted SILENT
        // ahead of it.
        if (v === "0" || v === "") {
          expect(said, `${JSON.stringify(v)} is a legal off`).toBe(false);
        } else if (v === "true") {
          expect(said, "a malformed flag says so").toBe(true);
        }
      }
    } finally {
      warn.mockRestore();
    }
  });

  for (const route of ROUTES) {
    it(`404s ${route.method} ${route.url} and reaches no service call`, async () => {
      const app = await build();
      const res = await app.inject(route);
      expect(res.statusCode).toBe(404);
      // Not 403: dark means "not here", which is what the web reads to decide
      // whether the surface exists at all.
      expect(res.statusCode).not.toBe(403);
      // The guard is BEFORE the work, so nothing was written. A guard placed
      // after the service call answers 404 too — and still writes the row.
      for (const [name, fn] of Object.entries(service)) {
        expect(fn, `${name} must not run while the feature is dark`).not
          .toHaveBeenCalled();
      }
    });
  }
});

describe("DM pricing with the brake off — suspended, not deleted", () => {
  beforeEach(() => {
    process.env.DM_PRICING_ENABLED = "1";
  });

  it("the read reaches the service and returns its figures", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/settings/dm-pricing" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ defaultPricePence: 250, overrides: [] });
    expect(service.getDmPricing).toHaveBeenCalledOnce();
  });

  it("each write reaches its own service function", async () => {
    const app = await build();
    for (const route of ROUTES.slice(1)) {
      const res = await app.inject(route);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(200);
    }
    expect(service.setDefaultDmPrice).toHaveBeenCalledOnce();
    expect(service.setDmPriceOverride).toHaveBeenCalledOnce();
    expect(service.removeDmPriceOverride).toHaveBeenCalledOnce();
  });

  it("still validates — the brake replaces no guard it sat in front of", async () => {
    // 404, not 400: a path id answers absent and malformed alike, or the route
    // tells a caller which user ids exist (`lib/request-inputs.ts`). The
    // assertion that carries the weight is the service call — a route that let
    // the id through would reach Postgres and answer 500 through the funnel,
    // which is also "not 200".
    const app = await build();
    const bad = await app.inject({
      method: "PUT",
      url: "/settings/dm-pricing/override/not-a-uuid",
      payload: { pricePence: 500 },
    });
    expect(bad.statusCode).toBe(404);
    expect(service.setDmPriceOverride).not.toHaveBeenCalled();

    const badDelete = await app.inject({
      method: "DELETE",
      url: "/settings/dm-pricing/override/not-a-uuid",
    });
    expect(badDelete.statusCode).toBe(404);
    expect(service.removeDmPriceOverride).not.toHaveBeenCalled();
  });
});
