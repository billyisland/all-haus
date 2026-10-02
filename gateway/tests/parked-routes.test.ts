import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// TWO PARKED SUBSYSTEMS ARE CLOSED AT THE GATEWAY, NOT ONLY HIDDEN IN THE WEB
// (walkthrough A15 + A18)
//
// Trust and traffology were parked by a web flag alone: the browser drew no
// control, and every route still answered. A vouch written against the open
// route was a row its author could neither see nor withdraw. Each plugin now
// carries one preHandler on its flag (TRUST_SYSTEM_ENABLED,
// TRAFFOLOGY_ENABLED), the publications shape.
//
// THE DISCRIMINATOR IS QUERY COUNT, NOT STATUS CODE — as in
// publications-suspended.test.ts: several of these routes answer 404 from
// their own handler against an empty mocked DB, byte-identical to the gate's.
// So "dark" is: 404 AND zero SQL (or outbound fetch). And the LIVE control matters as much: the
// same requests with the flag on must REACH the handler (SQL flows), or a gate
// that refused everything would pass every dark case.
//
// MUTATION CHECK: delete either addHook and that plugin's dark cases go red;
// invert its condition and the live cases go red.
// =============================================================================

let calls: Array<{ sql: string; params: unknown[] }> = [];

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
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

// One traffology route asks the ingest service rather than the database, so an
// outbound fetch counts as "reached the handler" too.
vi.stubGlobal("fetch", async (url: string) => {
  calls.push({ sql: `FETCH ${url}`, params: [] });
  return new Response("{}", { status: 503 });
});

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VIEWER = "00000000-0000-4000-8000-00000000aaaa";
const OTHER = "00000000-0000-4000-8000-00000000bbbb";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
}));

const { trustRoutes } = await import("../src/routes/trust.js");
const { traffologyRoutes } = await import("../src/routes/traffology.js");

type Req = { method: "GET" | "POST" | "DELETE"; url: string; payload?: object };

const TRUST: Req[] = [
  { method: "GET", url: `/api/v1/trust/${OTHER}` },
  {
    method: "POST",
    url: "/api/v1/vouches",
    payload: { subjectId: OTHER, dimension: "humanity", value: "affirm", visibility: "public" },
  },
  { method: "DELETE", url: `/api/v1/vouches/${OTHER}` },
  { method: "GET", url: "/api/v1/my/vouches" },
  { method: "GET", url: `/api/v1/trust/polls/${OTHER}` },
  { method: "POST", url: `/api/v1/trust/polls/${OTHER}`, payload: { question: "humanity", answer: "yes" } },
  { method: "DELETE", url: `/api/v1/trust/polls/${OTHER}`, payload: { question: "humanity" } },
];

const TRAFFOLOGY: Req[] = [
  { method: "GET", url: `/api/v1/traffology/concurrent/${OTHER}` },
  { method: "GET", url: "/api/v1/traffology/concurrent" },
  { method: "GET", url: "/api/v1/traffology/feed" },
  { method: "GET", url: `/api/v1/traffology/piece/${OTHER}` },
  { method: "GET", url: "/api/v1/traffology/overview" },
];

const FLAGS = ["TRUST_SYSTEM_ENABLED", "TRAFFOLOGY_ENABLED"];

beforeEach(() => {
  calls = [];
  for (const f of FLAGS) delete process.env[f];
});
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

async function build(plugin: typeof trustRoutes) {
  const app = Fastify();
  await app.register(plugin, { prefix: "/api/v1" });
  await app.ready();
  return app;
}

describe.each([
  { name: "trust", plugin: trustRoutes, flag: "TRUST_SYSTEM_ENABLED", reqs: TRUST },
  { name: "traffology", plugin: traffologyRoutes, flag: "TRAFFOLOGY_ENABLED", reqs: TRAFFOLOGY },
])("$name routes", ({ plugin, flag, reqs }) => {
  it(`covers every route the plugin registers (${reqs.length})`, async () => {
    const app = Fastify();
    const seen: string[] = [];
    app.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") seen.push(`${m} ${r.url}`);
    });
    await app.register(plugin, { prefix: "/api/v1" });
    await app.ready();
    expect(seen).toHaveLength(reqs.length);
  });

  it.each(reqs)("dark: $method $url 404s without touching the database", async (r) => {
    const app = await build(plugin);
    const res = await app.inject(r);
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each(reqs)("live: $method $url reaches its handler", async (r) => {
    process.env[flag] = "1";
    const app = await build(plugin);
    await app.inject(r);
    expect(calls.length).toBeGreaterThan(0);
  });
});
