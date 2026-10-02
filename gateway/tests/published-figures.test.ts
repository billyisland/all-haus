import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { describe, it, expect, vi } from "vitest";

// =============================================================================
// GET /published-figures answers the LIVE dials, unauthenticated.
//
// The About page names the platform's cut and a new account's allowance, and
// both are `platform_config` dials. The route must hand back what
// `loadConfig` holds (a retuned value, not the default), take no session, and
// ignore the closed beta. Unlike `/auth/open`, whose 404 IS the closed-beta
// answer, these are facts About states to everybody.
// =============================================================================

vi.mock("@platform-pub/shared/db/client.js", () => ({
  loadConfig: vi.fn(async () => ({
    platformFeeBps: 850,
    freeAllowancePence: 250,
    tabCeilingPence: 999,
  })),
}));

const { publishedFiguresRoutes } = await import("../src/routes/published-figures.js");

async function app() {
  const a = Fastify();
  await a.register(rateLimit, { global: false });
  await a.register(publishedFiguresRoutes, { prefix: "/api/v1" });
  return a;
}

describe("GET /published-figures", () => {
  it("answers the dials as loadConfig holds them, with no session", async () => {
    const res = await (await app()).inject({ method: "GET", url: "/api/v1/published-figures" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platformFeeBps: 850, freeAllowancePence: 250 });
  });

  it("sends only the figures public copy names", async () => {
    const res = await (await app()).inject({ method: "GET", url: "/api/v1/published-figures" });
    expect(Object.keys(res.json()).sort()).toEqual(["freeAllowancePence", "platformFeeBps"]);
  });
});
