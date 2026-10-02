import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

// =============================================================================
// /extract HAS A BUDGET, AND IT IS THE MEMBER'S (CA-D8).
//
// Each call fetches up to 5 MB and parses it synchronously on the event loop;
// with the limiter `global: false` and no route config, nothing bounded it.
// The budget is keyed on the SESSION at `preHandler` — at the default
// `onRequest` hook the session is not yet there and every member would share
// the one `req.ip` bucket, which only a test driving TWO members through one
// instance can see.
//
// The cases assert whether the FETCH ran, never only the status code.
//
// MUTATION: drop `config: extractLimit` → the budget case goes red; drop
// `hook: "preHandler"` → the second-member case does (both fall back to ip).
// =============================================================================

const fetches: string[] = [];

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: async (url: string) => {
    fetches.push(url);
    return {
      ok: true,
      status: 200,
      text: "<html><head><title>T</title></head><body><article><p>" +
        "Words enough for Readability to call this an article. ".repeat(20) +
        "</p></article></body></html>",
    };
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: {
    headers: Record<string, string | undefined>;
    session?: { sub: string };
  }) => {
    req.session = { sub: req.headers["x-test-member"] ?? "member-a" };
  },
}));

const { extractRoutes } = await import("../src/routes/extract.js");

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(rateLimit, { global: false });
  await app.register(extractRoutes);
  return app;
}

// Distinct URLs, so the in-process cache never answers for the limiter.
let n = 0;
const get = (app: FastifyInstance, member = "member-a") =>
  app.inject({
    method: "GET",
    url: `/extract?url=${encodeURIComponent(`https://example.com/a?${n++}`)}`,
    headers: { "x-test-member": member },
  });

beforeEach(() => {
  fetches.length = 0;
});

describe("GET /extract — the per-member budget", () => {
  it("the 31st call in a minute is refused WITHOUT fetching", async () => {
    const app = await build();
    for (let i = 0; i < 30; i++) expect((await get(app)).statusCode).toBe(200);
    expect(fetches).toHaveLength(30);
    const res = await get(app);
    expect(res.statusCode).toBe(429);
    expect(fetches).toHaveLength(30);
  });

  it("a second member is not in the first one's bucket", async () => {
    const app = await build();
    for (let i = 0; i < 30; i++) await get(app, "member-a");
    const res = await get(app, "member-b");
    expect(res.statusCode).toBe(200);
    expect(fetches).toHaveLength(31);
  });
});
