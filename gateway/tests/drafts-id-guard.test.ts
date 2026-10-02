import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A draft's path id is guarded before it reaches SQL (S18, ARTICLE-EDITOR-PLAN
// slice 4's drive-by).
//
// All four `/drafts/:id` routes put `req.params.id` straight into a uuid
// comparison. Postgres answers a malformed one with `invalid input syntax for
// type uuid`, which `lib/error-handler.ts` turns into `internal_error` 500 —
// measured, not hypothetical: it was met by sending `undefined` while writing
// the slice-1 driver, and the preview route is the first thing anybody will
// reach with a hand-edited URL.
//
// WHAT THESE CASES ASSERT, AND WHY NOT ONLY THE STATUS CODE. A route that
// refuses AFTER issuing the query has still spent a connection on a request it
// refused, and — the reason the rule exists at all — a 500 carrying Postgres's
// own message is the gateway telling the caller about its schema. So each case
// asserts THE QUERY NEVER RAN. A status assertion alone passes against a route
// that runs the query and then formats the error nicely.
//
// THE ANSWER IS THE ONE THE ROUTE ALREADY GIVES A WELL-FORMED ID NAMING NO ROW,
// because those two are the same answer to the caller and splitting them makes
// the route an oracle for which drafts exist. Three routes report absence, so
// they 404. DELETE /drafts/:id is idempotent and reports nothing, so it 200s —
// and every case below is PAIRED with its well-formed control asserting the two
// are indistinguishable, which is the only thing that says so.
//
// AND EVERY CASE CARRIES A VALID-ID CONTROL. A guard written as a blanket
// refusal breaks every draft on the site, and a suite that only sends junk goes
// green against it.
//
// Mutation-proved: drop any one guard and its malformed case goes red (500,
// query ran); make `isUuid` always false and all four controls go red.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const REAL_DRAFT = "00000000-0000-4000-8000-0000000000d1";
const ABSENT_DRAFT = "00000000-0000-4000-8000-0000000000d2";

// Every spelling a hand-edited URL actually produces. `undefined` is in here
// because that is the one this was met as.
const MALFORMED = ["not-a-uuid", "undefined", "null", "123", "../../admin", "%20"];

let calls: Array<{ sql: string; params: unknown[] }> = [];

const ran = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  // The writer gate's read (lib/writer-gate.ts). Every author in this file is
  // an admitted writer; the reader cases live in writer-gate.test.ts.
  if (sql.includes("AS can_write")) return Promise.resolve({ rows: [{ can_write: true }], rowCount: 1 });
  calls.push({ sql, params });

  // Answered from the id it is HANDED, never from a fixture — a mock that
  // returns its row whatever the param is pinning the mock, not the route.
  if (sql.includes("FROM article_drafts")) {
    if (params[0] === REAL_DRAFT) {
      return Promise.resolve({
        rows: [
          {
            id: REAL_DRAFT,
            title: "A draft",
            dek: null,
            content_raw: "Body",
            nostr_d_tag: null,
            gate_position_pct: 50,
            price_pence: 0,
            publication_id: null,
            cover_image_url: null,
            comments_enabled: true,
            auto_saved_at: "2026-09-11T12:00:00.000Z",
            scheduled_at: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("UPDATE article_drafts")) {
    if (params.includes(REAL_DRAFT)) {
      return Promise.resolve({
        rows: [{ id: REAL_DRAFT, scheduled_at: "2099-01-01T00:00:00.000Z" }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("DELETE FROM article_drafts")) {
    return Promise.resolve({ rows: [], rowCount: params[0] === REAL_DRAFT ? 1 : 0 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: WRITER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: WRITER };
  },
}));

async function buildApp() {
  const { draftRoutes } = await import("../src/routes/drafts.js");
  const app = Fastify({ logger: false });
  await app.register(draftRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  calls = [];
});

// The four routes, each with the answer it gives a well-formed id naming no row.
const ROUTES = [
  { name: "GET /drafts/:id", method: "GET" as const, path: (id: string) => `/drafts/${id}`, absent: 404, table: "FROM article_drafts" },
  { name: "DELETE /drafts/:id", method: "DELETE" as const, path: (id: string) => `/drafts/${id}`, absent: 200, table: "DELETE FROM article_drafts" },
  // `table` is THE STATEMENT THAT PRODUCES THIS ROUTE'S ABSENT ANSWER, which
  // for the schedule route is the SELECT rather than the UPDATE: it now reads
  // the draft first, to ask whether a paywalled one may be scheduled at all
  // (the Writer Agreement gate), and a draft that is not there is answered
  // from that read. The property under test is unchanged — a malformed id is
  // refused before any SQL, and a well-formed absent one is answered by the
  // route's own query.
  { name: "POST /drafts/:id/schedule", method: "POST" as const, path: (id: string) => `/drafts/${id}/schedule`, absent: 404, table: "FROM article_drafts", body: { scheduledAt: "2099-01-01T00:00:00.000Z" } },
  { name: "DELETE /drafts/:id/schedule", method: "DELETE" as const, path: (id: string) => `/drafts/${id}/schedule`, absent: 404, table: "UPDATE article_drafts" },
];

for (const route of ROUTES) {
  describe(route.name, () => {
    for (const bad of MALFORMED) {
      it(`refuses \`${bad}\` without touching the database`, async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: route.method,
          url: route.path(encodeURIComponent(bad)),
          payload: route.body,
        });
        // Never a 500 — that is the defect, and it carried Postgres's own
        // message before the error funnel landed.
        expect(res.statusCode).toBe(route.absent);
        // The refusal lands BEFORE the query, or the route has spent a
        // connection on a request it refused whatever it then answers.
        expect(ran(route.table)).toBe(false);
        await app.close();
      });
    }

    it("gives a malformed id the SAME answer as a well-formed one naming no row", async () => {
      const app = await buildApp();
      const malformed = await app.inject({
        method: route.method,
        url: route.path("not-a-uuid"),
        payload: route.body,
      });
      calls = [];
      const absent = await app.inject({
        method: route.method,
        url: route.path(ABSENT_DRAFT),
        payload: route.body,
      });
      expect(malformed.statusCode).toBe(absent.statusCode);
      expect(malformed.body).toBe(absent.body);
      // The control's query DID run — otherwise this is two guards agreeing
      // rather than a guard agreeing with the route.
      expect(ran(route.table)).toBe(true);
      await app.close();
    });

    it("still serves a real draft — the guard is a shape check, not a wall", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: route.method,
        url: route.path(REAL_DRAFT),
        payload: route.body,
      });
      expect(res.statusCode).toBe(200);
      expect(ran(route.table)).toBe(true);
      await app.close();
    });
  });
}
