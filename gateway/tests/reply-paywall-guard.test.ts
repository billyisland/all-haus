import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /replies CARRIES THE GATE (ARTICLE-HEADED-CONVERSATIONS-ADR D7, ship 1).
//
// WHY IT EXISTS. `POST /replies` is the only path that creates a kind-1111
// comment, and for as long as the route had existed it verified the target
// exists, that comments are enabled and that the author is not blocked — and
// never once asked whether the caller could READ the piece. The GET twenty
// lines below it did. The rule was enforced by the article page declining to
// draw a composer, and by nothing else: a UI rule is not an access control, and
// the hole was reachable by anyone who could form the request.
//
// THE SECOND TEST IS THE MORE IMPORTANT ONE. `checkArticleAccess` carries no
// `access_mode` term — for a free article by somebody else it returns
// {hasAccess: false} exactly as it does for an unpaid paywalled one — so the
// guard built as a BARE CALL 403s every comment on every free article on the
// site. That failure is total rather than partial, and a suite whose only new
// fixture is paywalled goes green against it. Hence the free-article case, and
// hence its assertion that the checker was never REACHED rather than merely
// that the status was 201.
//
// Mutation-proved both ways: drop the `access_mode === "paywalled"` branch and
// the free case goes red; drop the guard entirely and the paywalled case does.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const PAYWALLED_ARTICLE = "00000000-0000-4000-8000-0000000000c3";
const FREE_ARTICLE = "00000000-0000-4000-8000-0000000000d4";
const NEW_COMMENT = "00000000-0000-4000-8000-0000000000e5";

const PAYWALLED_EVENT = "a".repeat(64);
const FREE_EVENT = "b".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
let accessCalls: Array<unknown[]> = [];
let accessAnswer = { hasAccess: false };

function ran(fragment: string): boolean {
  return calls.some((c) => c.sql.includes(fragment));
}

// The mock answers FROM THE SQL IT IS HANDED (house rule), and hands out COPIES
// so no request can observe another's rows.
function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM articles") && sql.includes("access_mode")) {
    const ev = params[0];
    if (ev === PAYWALLED_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: PAYWALLED_ARTICLE,
            writer_id: WRITER,
            comments_enabled: true,
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
            comments_enabled: true,
            access_mode: "public",
            publication_id: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("FROM blocks")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("INSERT INTO comments")) {
    return Promise.resolve({ rows: [{ id: NEW_COMMENT }], rowCount: 1 });
  }

  // Notification context: the bare `SELECT id FROM articles` after the insert.
  if (sql.includes("SELECT id FROM articles")) {
    return Promise.resolve({ rows: [{ id: FREE_ARTICLE }], rowCount: 1 });
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
    req.session = { sub: READER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

// The checker itself is proven by access.test.ts; what is under test here is
// WHETHER IT IS REACHED, and on which articles.
vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async (...args: unknown[]) => {
    accessCalls.push(args);
    return { ...accessAnswer };
  },
}));

const { replyRoutes } = await import("../src/routes/replies.js");

async function build() {
  const app = Fastify();
  await app.register(replyRoutes);
  return app;
}

function post(app: Awaited<ReturnType<typeof build>>, targetEventId: string) {
  return app.inject({
    method: "POST",
    url: "/replies",
    payload: {
      nostrEventId: "f".repeat(64),
      targetEventId,
      targetKind: 30023,
      content: "A comment on a piece.",
    },
  });
}

beforeEach(() => {
  calls = [];
  accessCalls = [];
  accessAnswer = { hasAccess: false };
});

describe("POST /replies — the paywall guard (D7)", () => {
  it("403s a paywalled article for a reader without access", async () => {
    const app = await build();
    const res = await post(app, PAYWALLED_EVENT);
    expect(res.statusCode).toBe(403);
    // And it got there by ASKING, not by refusing everything paywalled.
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]).toEqual([READER, PAYWALLED_ARTICLE, WRITER, null]);
    // Nothing was written.
    expect(ran("INSERT INTO comments")).toBe(false);
    await app.close();
  });

  it("201s a paywalled article for a reader who HAS access", async () => {
    accessAnswer = { hasAccess: true };
    const app = await build();
    const res = await post(app, PAYWALLED_EVENT);
    expect(res.statusCode).toBe(201);
    expect(res.json().commentId).toBe(NEW_COMMENT);
    expect(accessCalls).toHaveLength(1);
    await app.close();
  });

  // THE ONE THAT CATCHES THE BARE CALL. With the guard written as an
  // unconditional `checkArticleAccess`, this reader — who is not the writer —
  // is refused, and so is every other commenter on every free article.
  it("201s a FREE article for a reader who is not its author, without asking the checker at all", async () => {
    const app = await build();
    const res = await post(app, FREE_EVENT);
    expect(res.statusCode).toBe(201);
    expect(res.json().commentId).toBe(NEW_COMMENT);
    expect(accessCalls).toHaveLength(0);
    expect(ran("INSERT INTO comments")).toBe(true);
    await app.close();
  });

  // The guard's ingredients ride on the FIRST article read, not a second one:
  // the widened SELECT is what makes the branch possible at all.
  it("the target read carries id, access_mode and publication_id", async () => {
    const app = await build();
    await post(app, FREE_EVENT);
    const target = calls.find(
      (c) => c.sql.includes("FROM articles") && c.sql.includes("WHERE nostr_event_id"),
    );
    expect(target).toBeDefined();
    expect(target!.sql).toContain("access_mode");
    expect(target!.sql).toContain("publication_id");
    await app.close();
  });
});
