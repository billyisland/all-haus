import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /reading-log — "SHORTER THAN ASKED FOR" IS NOT "THE END"
// (READING-LOG-AND-LIBRARY-ADR D7's corollary).
//
// The route pages the LOG and joins `feed_items` afterwards, deliberately: the
// log is a record of what happened rather than a set of live pointers, so a row
// whose piece has since been deleted is SKIPPED at render rather than raised as
// an error. The consequence is that a full page can arrive short.
//
// So "is there more" cannot be read off the rows that arrived, and for the whole
// of this feature's life it was: the client asked for `PAGE_SIZE + 1` and
// concluded the log had ended whenever fewer came back. One deleted piece
// anywhere in a page ended a reader's history early. It is the reassuring
// direction of a silent failure — the list can only ever be too short, and a log
// that stops early looks exactly like a log that stopped.
//
// WHAT THIS PINS, AND WHAT IT DOES NOT. The claim is about WHICH STATEMENT the
// answer comes from, so the mock is keyed on the two statements' shapes and the
// page is made deliberately short while the log query says there is another row.
// It is a structural pin: whether Postgres's `LIMIT 1 OFFSET (limit + offset)`
// really reads one row past the page is not something a mocked `pool.query` can
// evaluate, and this test would pass against an off-by-one in that offset. What
// it CANNOT pass against is the defect that shipped — an answer derived from the
// surviving rows — because here those two disagree by construction.
//
// Mutation-proved: compute `hasMore` from `items.length` and the first test goes
// red.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";

/** How many log rows the count statement should find beyond the page. */
let beyond = 0;
/** How many rows survive the join. Fewer than asked for is the whole point. */
let survivors = 0;
let calls: { sql: string; params: unknown[] }[] = [];

function row(n: number) {
  // Only the two columns the handler touches before `feedItemToPost` need to be
  // real; the mapper is proven elsewhere and is mocked away below.
  return { post_id: `${n}`.padStart(64, "0"), opened_at_epoch: 1_700_000_000 + n };
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  if (sql.includes("WITH page AS")) {
    return Promise.resolve({
      rows: Array.from({ length: survivors }, (_, i) => row(i)),
      rowCount: survivors,
    });
  }
  if (sql.includes("SELECT 1 FROM reading_log")) {
    return Promise.resolve({ rows: beyond ? [{}] : [], rowCount: beyond ? 1 : 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

vi.mock("../src/lib/post-mapper.js", () => ({
  POST_SELECT: "",
  POST_JOINS: "",
  feedItemToPost: (r: { post_id: string }) => ({ id: r.post_id }),
}));

const { readingLogRoutes } = await import("../src/routes/reading-log.js");

async function build() {
  const app = Fastify();
  await app.register(readingLogRoutes);
  return app;
}

beforeEach(() => {
  calls = [];
  beyond = 0;
  survivors = 0;
});

describe("GET /reading-log — hasMore", () => {
  it("says there is more even when the page came back SHORT", async () => {
    // A page of 20 asked for, 17 resolved (three pieces deleted since), and the
    // log holds more. Reading the answer off the 17 says "the end"; reading it
    // off the log says the truth.
    survivors = 17;
    beyond = 1;
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/reading-log?limit=20" });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(17);
    expect(res.json().hasMore).toBe(true);
    await app.close();
  });

  it("says there is no more when the log genuinely ends, page full or not", async () => {
    survivors = 20;
    beyond = 0;
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/reading-log?limit=20" });
    expect(res.json().items).toHaveLength(20);
    expect(res.json().hasMore).toBe(false);
    await app.close();
  });

  it("asks the log past the WHOLE window — limit PLUS offset", async () => {
    // Derived from the params the mock is handed, not asserted about the text:
    // the row it looks for is one past `limit + offset`. Past `limit` alone,
    // every page after the first reports more for ever and the "show more"
    // button never goes away.
    const app = await build();
    await app.inject({ method: "GET", url: "/reading-log?limit=20&offset=40" });
    const probe = calls.find((c) => c.sql.includes("SELECT 1 FROM reading_log"));
    expect(probe).toBeDefined();
    expect(probe!.params).toEqual([READER, 60]);
    // And the page itself still asks for its own window, unchanged.
    const page = calls.find((c) => c.sql.includes("WITH page AS"));
    expect(page!.params).toEqual([READER, 20, 40]);
    await app.close();
  });
});
