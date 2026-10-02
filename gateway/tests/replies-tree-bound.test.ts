import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /replies/:targetEventId IS BOUNDED, AND ITS TOTAL IS A FACT ABOUT THE
// TABLE RATHER THAN ABOUT THE PAGE
//
// The route selected EVERY comment on a piece — no LIMIT of any kind — and
// assembled a two-level tree out of them in memory, on a path `optionalAuth`
// serves to anybody. One popular article, or one flood under any article at all
// (a reply costs an account and nothing else), is an unbounded row count and an
// unbounded response body.
//
// THE SECOND HALF IS THE ONE WORTH A TEST. Capping the page moves `totalCount`
// from correct to wrong for free, because it was computed as
// `rows.filter(...).length` — over the rows the cap returned. A total derived
// from a truncated page reads as a complete one, which is this repo's standing
// failure in its most ordinary form: the empty denominator, the capped sample
// reported as a total, the tri-state NULL. So the count is its own statement
// over `comments`, and the cap is declared with `truncated` rather than left to
// be inferred from `comments.length < totalCount` — which does not subtract
// cleanly, deleted rows being counted OUT of the total and IN to the page.
//
// WHAT THIS PINS AND WHAT IT DOES NOT. The mock answers from the SQL it is
// handed, so the count-from-source claim is behavioural: the fixture below
// gives the page query fewer rows than the count query reports, and a route
// that still derived the total from its rows cannot produce the expected
// number. The LIMIT itself is a STRUCTURAL pin — that the page statement
// carries one and spends the cap as its parameter — because whether Postgres
// then honours it is Postgres's business and not something a mock can evaluate.
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const AUTHOR = "00000000-0000-4000-8000-0000000000b2";
const TARGET_EVENT = "a".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];

// How many comment rows the page query is scripted to return, and how many the
// table is scripted to hold. They DIFFER on purpose: equal fixtures pass
// against both spellings of the total, which is the trap this file is about.
const PAGE_ROWS = 12;
const TOTAL_IN_TABLE = 4321;

function row(i: number) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    nostr_event_id: String(i).padStart(64, "c"),
    parent_comment_id: null,
    content: `reply ${i}`,
    published_at: new Date(1_700_000_000_000 + i * 1000),
    deleted_at: null,
    author_id: AUTHOR,
    author_username: "someone",
    author_display_name: "Someone",
    author_pip_status: null,
  };
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  // The target lookup — an ordinary free article with replies enabled.
  if (sql.includes("FROM articles") && sql.includes("comments_enabled")) {
    return Promise.resolve({
      rows: [
        {
          comments_enabled: true,
          id: "00000000-0000-4000-8000-0000000000c3",
          access_mode: "public",
          writer_id: AUTHOR,
          publication_id: null,
        },
      ],
      rowCount: 1,
    });
  }

  // THE DISCRIMINATOR. Both statements read `comments` and both are keyed on
  // `target_event_id`; what tells them apart is that one is an aggregate. Keyed
  // any more loosely than this the mock would answer the count query with the
  // page — which is precisely the confusion under test.
  if (sql.includes("count(*)") && sql.includes("FROM comments")) {
    return Promise.resolve({ rows: [{ n: String(TOTAL_IN_TABLE) }], rowCount: 1 });
  }
  if (sql.includes("FROM comments c")) {
    const rows = Array.from({ length: PAGE_ROWS }, (_, i) => ({ ...row(i) }));
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  if (sql.includes("FROM mutes")) return Promise.resolve({ rows: [], rowCount: 0 });
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
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
}));

vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async () => ({ hasAccess: true }),
}));

const { replyRoutes } = await import("../src/routes/replies.js");

async function get() {
  const app = Fastify();
  await app.register(replyRoutes);
  return app.inject({ method: "GET", url: `/replies/${TARGET_EVENT}` });
}

beforeEach(() => {
  calls = [];
});

describe("GET /replies is bounded", () => {
  it("bounds the page statement with a LIMIT it spends the cap on", async () => {
    await get();
    const page = calls.find((c) => c.sql.includes("FROM comments c"));
    expect(page, "the page query ran").toBeDefined();
    expect(page!.sql).toMatch(/LIMIT \$2/);
    // A structural pin, and the number matters: a LIMIT whose parameter came
    // from somewhere else would satisfy the regex above.
    expect(typeof page!.params[1]).toBe("number");
    expect(page!.params[1] as number).toBeGreaterThan(0);
    // Ordered ascending, which is what makes a prefix closed under parenthood —
    // a reply is published after the comment it replies to, so truncating the
    // tail drops leaves and can never orphan a comment the page keeps. Flip
    // this to DESC and the cap starts cutting parents away from their children.
    expect(page!.sql).toMatch(/ORDER BY c\.published_at ASC/);
  });

  it("reports the total from the TABLE, not from the page it returned", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The page held 12 rows. Anything deriving the total from them answers 12.
    expect(body.totalCount).toBe(TOTAL_IN_TABLE);
    expect(body.totalCount).not.toBe(PAGE_ROWS);
    const count = calls.find(
      (c) => c.sql.includes("count(*)") && c.sql.includes("FROM comments"),
    );
    expect(count, "the total came from its own statement over comments").toBeDefined();
    expect(count!.params[0]).toBe(TARGET_EVENT);
  });

  it("does not claim truncation for a page that fits", async () => {
    // The control. Without it, `truncated: true` hard-coded would pass the
    // suite, and a tree that always says it is short is as useless as one that
    // never does.
    const body = (await get()).json();
    expect(body.truncated).toBe(false);
    expect(body.comments).toHaveLength(PAGE_ROWS);
  });
});
