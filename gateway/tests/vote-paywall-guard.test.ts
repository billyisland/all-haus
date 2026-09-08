import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /votes CARRIES THE GATE (CONSOLIDATED-TODO §0w item 1; the same class
// ARTICLE-HEADED-CONVERSATIONS-ADR D7 closed for POST /replies).
//
// WHY IT EXISTS. The vote route resolved the author for kind 30023/1/1111 and
// checked only existence and self-vote; nothing server-side refused a vote on a
// paywalled article, or on a comment whose root is paywalled. D6 suppresses the
// control on `rootLocked` in PostActions — which is exactly the shape the
// CLAUDE.md invariant names: a UI that declines to draw the control is not an
// access control, and the request is formable from any surface.
//
// THE FREE-ARTICLE TEST IS THE ONE THAT MATTERS. `checkArticleAccess` carries no
// `access_mode` term, so a guard built as a BARE CALL 403s every vote on every
// free article on the site — a total failure a paywalled-only suite goes green
// against. Hence the free case asserts the checker was never REACHED.
//
// The checker and the root resolver are proven elsewhere (access.test.ts;
// root-locked-key / root-locked-parity, DB-backed). What is under test here is
// WHETHER each is reached, on which targets, and with which key — so both are
// mocked and their call arguments asserted. Mutation-proved: drop the
// `access_mode === 'paywalled'` branch and the free case goes red; drop the
// article guard and the paywalled case does; drop the comment branch and the
// locked-root comment case does.
// =============================================================================

const VOTER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const COMMENTER = "00000000-0000-4000-8000-0000000000d4";
const PAYWALLED_ARTICLE = "00000000-0000-4000-8000-0000000000c3";
const FREE_ARTICLE = "00000000-0000-4000-8000-0000000000d4";

const PAYWALLED_EVENT = "a".repeat(64);
const FREE_EVENT = "b".repeat(64);
// A comment under the paywalled article, and one under the free article.
const LOCKED_COMMENT_EVENT = "c".repeat(64);
const OPEN_COMMENT_EVENT = "d".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
let accessCalls: Array<unknown[]> = [];
let accessAnswer = { hasAccess: false };
let lockedRootCalls: Array<[string | null, string[]]> = [];
let lockedRoots = new Set<string>();

function ran(fragment: string): boolean {
  return calls.some((c) => c.sql.includes(fragment));
}

// The mock answers FROM THE SQL IT IS HANDED (house rule) and hands out COPIES.
function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM articles") && sql.includes("WHERE nostr_event_id")) {
    const ev = params[0];
    if (ev === PAYWALLED_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: PAYWALLED_ARTICLE,
            writer_id: WRITER,
            access_mode: "paywalled",
            publication_id: null,
          },
        ],
        rowCount: 1,
      });
    }
    if (ev === FREE_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: FREE_ARTICLE,
            writer_id: WRITER,
            access_mode: "public",
            publication_id: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("FROM comments") && sql.includes("WHERE nostr_event_id")) {
    const ev = params[0];
    if (ev === LOCKED_COMMENT_EVENT) {
      return Promise.resolve({
        rows: [{ author_id: COMMENTER, target_event_id: PAYWALLED_EVENT }],
        rowCount: 1,
      });
    }
    if (ev === OPEN_COMMENT_EVENT) {
      return Promise.resolve({
        rows: [{ author_id: COMMENTER, target_event_id: FREE_EVENT }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("pg_advisory_xact_lock")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("SELECT COUNT(*) AS count FROM votes")) {
    return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1 });
  }
  if (sql.includes("INSERT INTO votes")) {
    return Promise.resolve({ rows: [{ id: "vote-1" }], rowCount: 1 });
  }
  if (sql.includes("INSERT INTO vote_tallies")) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("FROM vote_tallies")) {
    return Promise.resolve({
      rows: [{ upvote_count: 1, downvote_count: 0, net_score: 1 }],
      rowCount: 1,
    });
  }

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

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VOTER };
  },
}));

vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async (...args: unknown[]) => {
    accessCalls.push(args);
    return { ...accessAnswer };
  },
}));

vi.mock("../src/lib/root-locked.js", () => ({
  resolveLockedRoots: async (viewerId: string | null, roots: string[]) => {
    lockedRootCalls.push([viewerId, [...roots]]);
    return new Set(roots.filter((r) => lockedRoots.has(r)));
  },
}));

const { voteRoutes } = await import("../src/routes/votes.js");

async function build() {
  const app = Fastify();
  await app.register(voteRoutes);
  return app;
}

function vote(
  app: Awaited<ReturnType<typeof build>>,
  targetEventId: string,
  targetKind: number,
) {
  return app.inject({
    method: "POST",
    url: "/votes",
    payload: { targetEventId, targetKind, direction: "up" },
  });
}

beforeEach(() => {
  calls = [];
  accessCalls = [];
  accessAnswer = { hasAccess: false };
  lockedRootCalls = [];
  lockedRoots = new Set();
});

describe("POST /votes — the paywall guard on an ARTICLE target", () => {
  it("403s a paywalled article for a voter without access, and writes nothing", async () => {
    const app = await build();
    const res = await vote(app, PAYWALLED_EVENT, 30023);
    expect(res.statusCode).toBe(403);
    // By ASKING, not by refusing everything paywalled.
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]).toEqual([VOTER, PAYWALLED_ARTICLE, WRITER, null]);
    expect(ran("INSERT INTO votes")).toBe(false);
    expect(ran("INSERT INTO vote_tallies")).toBe(false);
    await app.close();
  });

  it("201s a paywalled article for a voter who HAS access", async () => {
    accessAnswer = { hasAccess: true };
    const app = await build();
    const res = await vote(app, PAYWALLED_EVENT, 30023);
    expect(res.statusCode).toBe(201);
    expect(res.json().counted).toBe(true);
    expect(accessCalls).toHaveLength(1);
    expect(ran("INSERT INTO votes")).toBe(true);
    await app.close();
  });

  // THE ONE THAT CATCHES THE BARE CALL.
  it("201s a FREE article for a voter who is not its author, without asking the checker at all", async () => {
    const app = await build();
    const res = await vote(app, FREE_EVENT, 30023);
    expect(res.statusCode).toBe(201);
    expect(accessCalls).toHaveLength(0);
    expect(lockedRootCalls).toHaveLength(0);
    expect(ran("INSERT INTO votes")).toBe(true);
    await app.close();
  });

  it("the article read carries id, access_mode and publication_id", async () => {
    const app = await build();
    await vote(app, FREE_EVENT, 30023);
    const target = calls.find(
      (c) => c.sql.includes("FROM articles") && c.sql.includes("WHERE nostr_event_id"),
    );
    expect(target).toBeDefined();
    expect(target!.sql).toContain("access_mode");
    expect(target!.sql).toContain("publication_id");
    await app.close();
  });
});

describe("POST /votes — the paywall guard on a COMMENT target (kind 1111)", () => {
  it("403s a comment whose root is locked to the voter, keyed on the comment's target_event_id", async () => {
    lockedRoots = new Set([PAYWALLED_EVENT]);
    const app = await build();
    const res = await vote(app, LOCKED_COMMENT_EVENT, 1111);
    expect(res.statusCode).toBe(403);
    // The resolver is asked about the ROOT (the comment's target), not the
    // comment's own event id — that is the key that joins `articles`.
    expect(lockedRootCalls).toEqual([[VOTER, [PAYWALLED_EVENT]]]);
    expect(ran("INSERT INTO votes")).toBe(false);
    await app.close();
  });

  it("201s a comment whose root is open to the voter", async () => {
    const app = await build();
    const res = await vote(app, OPEN_COMMENT_EVENT, 1111);
    expect(res.statusCode).toBe(201);
    expect(lockedRootCalls).toEqual([[VOTER, [FREE_EVENT]]]);
    expect(accessCalls).toHaveLength(0);
    expect(ran("INSERT INTO votes")).toBe(true);
    await app.close();
  });

  it("the comment read carries target_event_id", async () => {
    const app = await build();
    await vote(app, OPEN_COMMENT_EVENT, 1111);
    const target = calls.find(
      (c) => c.sql.includes("FROM comments") && c.sql.includes("WHERE nostr_event_id"),
    );
    expect(target).toBeDefined();
    expect(target!.sql).toContain("target_event_id");
    await app.close();
  });
});

describe("POST /votes — validation envelope", () => {
  // Tail (f) of the same audit: a raw flatten() as `error` renders
  // "[object Object]" client-side; the shared envelope is the rule.
  it("answers a malformed body with the shared validation_failed envelope", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/votes",
      payload: { targetEventId: "", targetKind: 1, direction: "sideways" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_failed");
    expect(typeof body.message).toBe("string");
    expect(body.details).toBeDefined();
    await app.close();
  });
});
