import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { keyRoutes } from "../src/routes/keys.js";
import { rateLimitPluginOptions } from "../src/lib/rate-limit.js";

// =============================================================================
// One bucket per identity, not one bucket for the platform (MIRROR-AUDIT §2.13).
//
// The limiter used to be registered globally with a single keyGenerator that
// read `x-reader-id` and fell back to `req.ip`. Every WRITER route sends no
// reader id, so vault publish, the vault PATCH, the editor's paywall-content
// load, the writer key export and the gateway's own liveness probe all fell
// back to the same key — the gateway container's IP — and shared ONE 10/min
// bucket platform-wide. A writer publishing eleven paywalled pieces in a minute
// therefore 429'd the key-fishing budget, the export, and the parity probe.
//
// HOW THIS DRIVES THE REAL ROUTES. The limiter runs on `onRequest`, which is
// before the plugin-scope internal-secret preHandler and long before any
// handler, so every request here is sent with NO `x-internal-secret`: the
// expected answer is 401 while there is budget and 429 once there is not. That
// is the limiter's own decision, observed on the real route objects with their
// real `config.rateLimit`, and it needs no database and no secrets.
//
// MUTATION CHECK, and one thing it does NOT catch through the four routes.
// Point a route's keyGenerator at the wrong header, or drop `statusCode` from
// the error builder, and these fail. Flipping `global` back to `true` does not
// — a route's own `config.rateLimit` wins over the global params either way, so
// every route here is unmoved by it. What `global: false` decides is what
// happens to a route added LATER with no config of its own: unlimited (and
// obviously so) rather than silently rejoined to a shared platform-wide bucket
// keyed on the gateway's IP, which is the bug this whole change is about. That
// is pinned by its own case below, on a probe route, because it is a fact about
// the options object and not about any of the five real routes.
// =============================================================================

const VAULT = "/api/v1/articles/" + "a".repeat(64) + "/vault";
const KEY = "/api/v1/articles/" + "a".repeat(64) + "/key";
const EXPORT = "/api/v1/writers/export-keys";
const AUTH_CHECK = "/api/v1/auth-check";
const PAYWALL_CONTENT =
  "/api/v1/articles/3f0a2b1c-0000-4000-8000-000000000001/paywall-content";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  // The REAL options object src/index.ts registers, not a copy of it — a test
  // that rebuilt the registration would pass against a broken one. (That is not
  // hypothetical: the first draft of this file did exactly that, and so agreed
  // with itself while the service answered 500 on every 429.)
  await app.register(rateLimit, rateLimitPluginOptions);
  await app.register(keyRoutes, { prefix: "/api/v1" });
  // A route with no `config.rateLimit`, to observe what the plugin does with
  // one. See the mutation note above.
  app.get("/unconfigured", async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function hit(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });
  return res.statusCode;
}

describe("key-service rate-limit buckets", () => {
  it("exhausting a reader's key budget leaves the writer routes untouched", async () => {
    const reader = { "x-reader-id": "reader-alpha", "x-reader-pubkey": "f".repeat(64) };
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push(await hit("POST", KEY, reader));

    // The reader's own bucket is 10/min and it is spent.
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);

    // A writer publishing at the same moment is unaffected — this is the whole
    // finding: under `global: true` these shared the reader's spent bucket.
    expect(await hit("POST", VAULT, { "x-writer-id": "writer-alpha" })).toBe(401);
    expect(await hit("GET", EXPORT, { "x-writer-id": "writer-alpha" })).toBe(401);
  });

  it("keeps the liveness probe exempt", async () => {
    // The gateway hits this every five minutes and at every boot. A 429 is
    // classified "unreachable" by classifyParityStatus, which leaves key-service
    // reading "never confirmed" — the third state the probe exists to keep
    // distinct from "fine".
    for (let i = 0; i < 30; i++) {
      expect(await hit("GET", AUTH_CHECK, {})).toBe(401);
    }
  });

  it("gives each writer their own publish budget", async () => {
    // 60/min per writer; spend one writer's entirely and the next writer still
    // publishes. Keyed on x-writer-id, so a busy author costs nobody else.
    for (let i = 0; i < 60; i++) {
      expect(await hit("POST", VAULT, { "x-writer-id": "writer-busy" })).toBe(401);
    }
    expect(await hit("POST", VAULT, { "x-writer-id": "writer-busy" })).toBe(429);
    expect(await hit("POST", VAULT, { "x-writer-id": "writer-quiet" })).toBe(401);
  });

  it("leaves a route that declares no budget unlimited, not silently pooled", async () => {
    // `global: false`. Well past the 10/min default: a future route added
    // without a config must not land in one shared bucket keyed on the
    // gateway's IP, which is exactly how the four keyed routes came to share
    // one. Unlimited is the safer default here — key-service is reachable only
    // from inside the compose network, behind the internal-secret gate.
    for (let i = 0; i < 25; i++) {
      expect(await hit("GET", "/unconfigured", {})).toBe(200);
    }
  });

  it("keeps the export budget tight and counted APART from the same writer's publishing", async () => {
    // Each route with its own `config.rateLimit` gets its own store
    // (`store.child()` builds a fresh LRU), so the budgets are separate
    // counters and not merely different ceilings on one. Prove it the decisive
    // way round: spend this writer's 60 publish slots first — on a shared
    // counter the export below would already be 61 over a max of 5 and answer
    // 429 on its first call.
    const w = { "x-writer-id": "writer-exporter" };
    for (let i = 0; i < 60; i++) expect(await hit("POST", VAULT, w)).toBe(401);
    expect(await hit("POST", VAULT, w)).toBe(429);

    for (let i = 0; i < 5; i++) expect(await hit("GET", EXPORT, w)).toBe(401);
    expect(await hit("GET", EXPORT, w)).toBe(429);

    // And the editor read is a third counter, untouched by both.
    expect(await hit("GET", PAYWALL_CONTENT, w)).toBe(401);
  });
});
