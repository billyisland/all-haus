import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /notifications — what the pager carries, and what it refuses.
//
// Two rules, one route.
//
// (1) The cursor is the `created_at::text` projection, never the row's `Date`.
//     This is a DESCENDING cursor compared with `<`, so a position truncated
//     to the millisecond is EARLIER than the row it came from and the
//     notifications inside the lost microseconds land in neither page —
//     silently, permanently, and looking exactly like "no more history". What
//     the truncation itself does is Postgres's business and is pinned in the
//     DB-backed `timestamp-cursor-precision.test.ts`; what THIS file pins is
//     that the route reads the un-truncated projection. Both are needed:
//     either alone passes against the bug.
//
// (2) A malformed cursor is a 400, not a 500. The value goes straight into a
//     `$3::timestamptz` cast, so Postgres raises and the route answered with a
//     database message in its body.
//
// THE MOCK ANSWERS FROM THE SQL AND PARAMS IT IS HANDED where it can: the
// fixture's `created_at_exact` carries microseconds its `created_at` Date
// cannot represent, so a route that reverted to `.created_at.toISOString()`
// returns a DIFFERENT string and fails here rather than passing against a
// fixture that agrees with it. (Mutation-checked both ways: reverting the
// projection fails the cursor test; dropping the shape gate fails the 400 test
// on `queries.length`.)
// =============================================================================

let queries: Array<{ sql: string; params: unknown[] }> = [];
let rows: Record<string, unknown>[] = [];

function query(sql: string, params: unknown[] = []) {
  queries.push({ sql, params });
  if (sql.includes("COUNT(*)")) {
    return Promise.resolve({ rows: [{ cnt: "0" }], rowCount: 1 });
  }
  return Promise.resolve({ rows, rowCount: rows.length });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: "reader-id" };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: "reader-id" };
    done();
  },
}));

const { notificationRoutes } = await import("../src/routes/notifications.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(notificationRoutes);
  return app;
}

/** A row whose exact stamp is NOT representable as a JS Date. */
const EXACT = "2026-09-10 12:00:00.001002+00";

function notification(id: string) {
  return {
    id,
    type: "new_comment",
    read: false,
    created_at: new Date("2026-09-10T12:00:00.001Z"),
    created_at_exact: EXACT,
    actor_id: null,
    actor_username: null,
    actor_display_name: null,
    actor_avatar: null,
    article_id: null,
    article_title: null,
    article_slug: null,
    article_writer_username: null,
    comment_id: null,
    comment_content: null,
    note_id: null,
    note_nostr_event_id: null,
    conversation_id: null,
    drive_id: null,
    offer_id: null,
    offer_code: null,
    offer_revoked: null,
  };
}

beforeEach(() => {
  queries = [];
  rows = [];
});

describe("GET /notifications — the cursor", () => {
  it("mints it from the ::text projection, not from the row's Date", async () => {
    // 31 rows for a limit of 30 ⇒ hasMore, so a cursor is minted from row 30.
    rows = Array.from({ length: 31 }, (_, i) => notification(`n${i}`));

    const app = await build();
    const res = await app.inject({ method: "GET", url: "/notifications" });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    // The timestamp projection, then the row id as the tiebreak (CA-B12): two
    // rows sharing an instant cannot straddle a page boundary.
    expect(body.nextCursor).toBe(`${EXACT}|n29`);
    // The value a Date-carried cursor would have produced. Named so the
    // difference is legible rather than implied.
    expect(body.nextCursor).not.toMatch(/^2026-09-10T12:00:00\.001Z/);
    await app.close();
  });

  it("compares a composite cursor as a ROW, ordered on the same two columns (CA-B12)", async () => {
    rows = [notification("n0")];
    const app = await build();
    const id = "aaaaaaaa-0000-4000-8000-000000000029";
    const res = await app.inject({
      method: "GET",
      url: `/notifications?cursor=${encodeURIComponent(`${EXACT}|${id}`)}`,
    });
    expect(res.statusCode).toBe(200);
    const list = queries.find((q) => q.sql.includes("FROM notifications n"))!;
    expect(list.sql).toContain("(n.created_at, n.id) < ($3::timestamptz, $4::uuid)");
    expect(list.sql).toContain("ORDER BY n.created_at DESC, n.id DESC");
    expect(list.params[2]).toBe(EXACT);
    expect(list.params[3]).toBe(id);
    await app.close();
  });

  it("refuses a composite cursor whose id half is not a uuid, before the database", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: `/notifications?cursor=${encodeURIComponent(`${EXACT}|not-an-id`)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("selects the projection it pages on", async () => {
    // Structural, and said out loud: only Postgres evaluates a cast, so this
    // asserts the query's SHAPE and not its behaviour.
    rows = [notification("n0")];
    const app = await build();
    await app.inject({ method: "GET", url: "/notifications" });
    const list = queries.find((q) => q.sql.includes("FROM notifications n"))!;
    expect(list.sql).toContain("n.created_at::text");
    await app.close();
  });

  it("passes a well-formed cursor through as a cast comparison", async () => {
    rows = [notification("n0")];
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: `/notifications?cursor=${encodeURIComponent(EXACT)}`,
    });
    expect(res.statusCode).toBe(200);

    const list = queries.find((q) => q.sql.includes("FROM notifications n"))!;
    expect(list.sql).toContain("n.created_at < $3::timestamptz");
    expect(list.params[2]).toBe(EXACT);
    await app.close();
  });

  it("refuses a malformed cursor with a 400, and never reaches the database", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/notifications?cursor=not-a-time",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_cursor" });
    // The status code alone would pass against a route that ran the query,
    // caught the cast error and rewrote it — which is a different thing, and
    // one that has already spent a connection on a request it refused.
    expect(queries).toHaveLength(0);
    await app.close();
  });

  it("still honours a millisecond cursor a client minted before this change", async () => {
    // Refusing these would 400 every pagination open across the deploy. They
    // are lossy — that is the defect — but no lossier than yesterday, and the
    // page they return mints a full-precision replacement.
    rows = [notification("n0")];
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/notifications?cursor=2026-09-10T12:00:00.001Z",
    });
    expect(res.statusCode).toBe(200);
    expect(queries.some((q) => q.sql.includes("FROM notifications n"))).toBe(true);
    await app.close();
  });
});
