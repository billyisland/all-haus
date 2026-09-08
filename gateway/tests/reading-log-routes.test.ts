import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import pg from "pg";

// =============================================================================
// THE READING ROUTES ANSWER, AND ANSWER WITH A ROW
// (READING-LOG-AND-LIBRARY-ADR; operator decision, CONSOLIDATED-TODO §0v.)
//
// WHY THIS FILE IS THE SHAPE IT IS. The feature this replaced —
// `/my/reading-history` — returned 500 to every caller from the day it was
// written, for its whole life, and nobody knew. Not because it was untested in
// some general way, but because of a specific pair of facts: its client
// swallowed the failure into an empty state by design, and an empty tab is
// exactly what a reader with no history sees. The bug and the correct behaviour
// rendered identically. That ADR's own rail says this tab must be proved "by
// driving it and asserting a row — never by its silence".
//
// So this suite asserts the narrowest thing that would have caught that, across
// every route in the feature: **a 2xx, and where there should be a row, a row**.
// It is deliberately not a behavioural pin — paging, projection shape and the
// mapper are pinned elsewhere (`reading-log-paging.test.ts`) or still moving,
// and a suite that froze them here would have to be edited on every change,
// which is how a smoke test quietly becomes an obstacle and then a rubber stamp.
//
// IT IS DB-BACKED AND USES THE REAL SQL. A mocked `pool.query` cannot fail the
// way the predecessor failed: the fault was in the statement, and a mock is told
// what the statement returns. The shared `pool` is redirected at this file's
// client, inside a transaction that is always rolled back, so what runs is the
// shipping query against the real schema — the `feed_items` join included, which
// is the part with somewhere to go wrong.
//
// NOT COVERED, deliberately and on the record: the retention sweep. It is the
// one that DELETES, and it deserves its own suite rather than a corner of this
// one; the operator's call was to prove the routes first.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/reading-log-routes.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let client: pg.Client;
let READER = "";

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

const { readingLogRoutes } = await import("../src/routes/reading-log.js");
const { libraryRoutes } = await import("../src/routes/library.js");

describe.skipIf(!DB_URL)("the reading routes answer", () => {
  let seq = 0;
  const uniq = () => `rlr-${Date.now().toString(36)}-${seq++}`;
  let postId = "";
  let writerId = "";
  let articleId = "";

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    READER = await insertAccount();
    writerId = await insertAccount();
    const s = uniq();
    const { rows: art } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             access_mode, price_pence, published_at)
       VALUES ($1, $2, $3, $4, $5, 'paywalled', 300, now()) RETURNING id`,
      [writerId, s.padEnd(64, "0"), s, `Piece ${s}`, s],
    );
    articleId = art[0].id;
    // A feed_items row so the log's join has something to resolve. `post_id` is
    // left NULL on purpose: the `feed_items_post_identity` trigger mints it, and
    // reading it back is what every reader of this table is supposed to do
    // rather than re-deriving the coord (D7).
    const { rows: fi } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, article_id, author_id, title,
                               nostr_event_id, published_at)
       VALUES ('article', $1, $2, $3, $4, now()) RETURNING post_id`,
      [articleId, writerId, `Piece ${s}`, s.padEnd(64, "0")],
    );
    postId = fi[0].post_id;
    expect(postId, "the trigger must mint a post_id").toMatch(/^[0-9a-f]{64}$/);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    return rows[0].id;
  }

  async function buildLog() {
    const app = Fastify();
    await app.register(readingLogRoutes);
    return app;
  }
  async function buildLibrary() {
    const app = Fastify();
    await app.register(libraryRoutes);
    return app;
  }

  it("POST /reading-log records an open, and GET hands it back", async () => {
    const app = await buildLog();
    const post = await app.inject({
      method: "POST",
      url: "/reading-log",
      payload: { postId },
    });
    expect(post.statusCode).toBeLessThan(300);

    const get = await app.inject({ method: "GET", url: "/reading-log" });
    expect(get.statusCode).toBe(200);
    // THE ROW, not the 200. An empty 200 is what the predecessor's swallowing
    // client rendered for its whole broken life.
    const items = get.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].post.id).toBe(postId);
    expect(items[0].openedAt).toBeTruthy();
    await app.close();
  });

  it("re-opening a piece moves it, and does not add to it (D3)", async () => {
    // The dedup is the PRIMARY KEY at the write, not a DISTINCT at the read, so
    // it is worth one assertion that the write really is an upsert.
    const app = await buildLog();
    await app.inject({ method: "POST", url: "/reading-log", payload: { postId } });
    await app.inject({ method: "POST", url: "/reading-log", payload: { postId } });
    const get = await app.inject({ method: "GET", url: "/reading-log" });
    expect(get.json().items).toHaveLength(1);
    await app.close();
  });

  it("DELETE clears the caller's log, and only the caller's", async () => {
    const app = await buildLog();
    await app.inject({ method: "POST", url: "/reading-log", payload: { postId } });

    // Somebody else's row, written directly — the route is caller-scoped by
    // construction, so this is the only way to put one there.
    const other = await insertAccount();
    await client.query(
      `INSERT INTO reading_log (user_id, post_id) VALUES ($1, $2)`,
      [other, postId],
    );

    const del = await app.inject({ method: "DELETE", url: "/reading-log" });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(1);
    expect((await app.inject({ method: "GET", url: "/reading-log" })).json().items)
      .toHaveLength(0);

    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM reading_log WHERE user_id = $1`,
      [other],
    );
    expect(rows[0].n).toBe("1");
    await app.close();
  });

  it("GET /my/library answers with what was acquired", async () => {
    // The library's key is a `read_event`, not a log entry — the two lists are
    // not filters of one another, so this fixture writes no log row at all.
    await client.query(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, amount_pence, state)
       VALUES ($1, $2, $3, 300, 'platform_settled')`,
      [READER, articleId, writerId],
    );
    const app = await buildLibrary();
    const res = await app.inject({ method: "GET", url: "/my/library" });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].articleId).toBe(articleId);
    expect(items[0].isPaywalled).toBe(true);
    await app.close();
  });

  it("both surfaces answer 200 and EMPTY for a reader with nothing", async () => {
    // The other half of the predecessor's failure: empty and broken looked the
    // same. Having pinned that a row comes back, pin that no row also comes
    // back cleanly — so a future reader of this file knows the empty case is
    // covered rather than merely unobserved.
    const log = await buildLog();
    const l = await log.inject({ method: "GET", url: "/reading-log" });
    expect(l.statusCode).toBe(200);
    expect(l.json().items).toEqual([]);
    expect(l.json().hasMore).toBe(false);
    await log.close();

    const lib = await buildLibrary();
    const b = await lib.inject({ method: "GET", url: "/my/library" });
    expect(b.statusCode).toBe(200);
    expect(b.json().items).toEqual([]);
    await lib.close();
  });
});
