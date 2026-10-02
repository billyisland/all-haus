import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

// =============================================================================
// The four outbound WRITE routes have a per-member budget (MIRROR-AUDIT §3, S16).
//
// `/external-items/:id/{like,repost,poll-vote,reply}` each post in the MEMBER'S
// OWN NAME on somebody else's platform, and `/reply` mints a note, a
// relay_outbox row and an outbound job per call. They carried no budget at all,
// so a runaway client — or a hostile one holding a session — could spend a
// member's Bluesky or Mastodon account straight into that platform's own abuse
// limits, and the bill lands on the member.
//
// WHY THE SECOND MEMBER IS THE WHOLE TEST. @fastify/rate-limit's default hook is
// `onRequest`, which runs BEFORE `requireAuth`, so a session-keyed generator
// reads `req.session` as undefined and every request falls through to `req.ip` —
// one nginx, one bucket, the entire platform in it. That reads as working from
// every angle except this one: the limiter limits, the routes answer, and only a
// drive of TWO identities through one instance can tell the two apart. It is the
// same defect S15 found on the signing routes and S7 found on key-service.
//
// Mutation: drop `hook: 'preHandler'` and the second-member case fails while
// everything else stays green.
// =============================================================================

const MEMBER_A = "00000000-0000-4000-8000-0000000000a1";
const MEMBER_B = "00000000-0000-4000-8000-0000000000b2";

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: async () => ({ rows: [], rowCount: 0 }) },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/key-custody-client.js", () => ({ signEvent: vi.fn() }));
vi.mock("../src/lib/outbound-enqueue.js", () => ({
  enqueueCrossPost: vi.fn(),
  enqueueLike: vi.fn(),
  enqueueRepost: vi.fn(),
  enqueuePollVote: vi.fn(),
  enqueueNostrOutbound: vi.fn(),
}));
// The identity comes off a header so one instance can drive two members. It is
// set in a `preHandler`, exactly where `requireAuth` sets it — which is the
// whole point: a limiter on the default `onRequest` hook runs before this and
// sees nothing.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: {
    session?: { sub: string };
    headers: Record<string, string | undefined>;
  }) => {
    req.session = { sub: req.headers["x-test-account"] ?? MEMBER_A };
  },
  optionalAuth: async () => {},
}));

async function build() {
  const { registerInteractionRoutes } = await import(
    "../src/routes/external-items/interactions.js"
  );
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { global: false });
  await app.register(async (i) => registerInteractionRoutes(i));
  await app.ready();
  return app;
}

const ITEM = "00000000-0000-4000-8000-0000000000c3";

describe("outbound interaction budgets", () => {
  it("429s a member past the compose budget, and the next member still has their own", async () => {
    const app = await build();
    const spend = (account: string) =>
      app.inject({
        method: "POST",
        url: `/external-items/${ITEM}/reply`,
        headers: { "x-test-account": account },
        payload: { linkedAccountId: "x", content: "hi" },
      });

    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await spend(MEMBER_A)).statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    expect(codes[20]).toBe(429);

    // The case the ip-keyed collapse fails: a DIFFERENT member, immediately
    // after, on the same instance.
    expect((await spend(MEMBER_B)).statusCode).not.toBe(429);
    await app.close();
  });

  it("gives the reaction routes their own, larger budget", async () => {
    // Flicking through a feed genuinely produces bursts of likes; composing 20
    // replies a minute does not happen. Sharing one budget would mean tuning for
    // the noisier of the two, which is how a limit ends up doing nothing.
    const app = await build();
    const hit = (account: string) =>
      app.inject({
        method: "POST",
        url: `/external-items/${ITEM}/like`,
        headers: { "x-test-account": account },
        payload: { linkedAccountId: "x" },
      });
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await hit(MEMBER_A)).statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(0);
    await app.close();
  });

  it("budgets every one of the four write routes", async () => {
    // A guard applied to three of four routes leaves the fourth as the whole
    // hole, and nothing else here would notice.
    const app = await build();
    const routes = ["like", "repost", "poll-vote", "reply"];
    for (const r of routes) {
      const codes: number[] = [];
      for (let i = 0; i < 61; i++) {
        codes.push(
          (
            await app.inject({
              method: "POST",
              url: `/external-items/${ITEM}/${r}`,
              headers: { "x-test-account": `${MEMBER_A}-${r}` },
              payload: { linkedAccountId: "x", content: "hi", choices: [0] },
            })
          ).statusCode,
        );
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    }
    await app.close();
  });
});
