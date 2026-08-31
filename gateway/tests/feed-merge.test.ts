import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /workspace/feeds/:id/merge
//
// What survives feed-merge-starter-guard.test.ts, whose subject —
// `feeds.is_starter_template` — was dropped in migration 179 (FEED-FORMULAS-ADR
// D6, Phase 2 step 2). The guard is gone because the object it protected is:
// merge is asymmetric and DESTRUCTIVE (it moves the source feed's sources into
// the target and then DELETEs the source feed), and in 2026-07-22 that gesture
// destroyed the one flagged row every new signup was cloned from. The
// designated seed formula that replaced it has no `feeds` row for a merge to
// consume.
//
// So the ordinary merge, which was that file's control case, is now the whole
// of what needs holding — plus the two ownership arms, since a merge that
// mistook whose feed it was reading would move one member's sources into
// another's:
//
//   - happy path      → sources moved, leftovers cleared, saves copied, and
//                       the SOURCE feed (never the target) deleted.
//   - not owned       → 403, and nothing is written.
//   - absent          → 404, and nothing is written.
//   - self-merge      → 400 before the transaction opens at all.
// =============================================================================

let txCalls: Array<{ sql: string; params: unknown[] }> = [];
let feedRows: Array<Record<string, unknown>> = [];

const mockPoolQuery = vi.fn();

function scriptedQuery(sql: string, params: unknown[] = []) {
  txCalls.push({ sql, params });
  if (sql.includes("FROM feeds WHERE id = ANY"))
    return Promise.resolve({ rows: feedRows, rowCount: feedRows.length });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OWNER = "00000000-0000-4000-8000-00000000aaaa";
const STRANGER = "00000000-0000-4000-8000-00000000bbbb";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: OWNER };
  },
}));

import { registerFeedCrudRoutes } from "../src/routes/feeds/crud.js";

const TARGET = "11111111-0000-4000-8000-000000000001";
const SOURCE = "22222222-0000-4000-8000-000000000002";

const LOADED_FEED = {
  id: TARGET,
  name: "Target",
  appearance: {},
  sort_rank: 1,
  hidden: false,
  created_at: new Date(),
  updated_at: new Date(),
  source_count: 3,
  from_starter: false,
};

function feed(id: string, ownerId = OWNER) {
  return { id, owner_id: ownerId };
}

async function merge(sourceFeedId: string = SOURCE) {
  const app = Fastify();
  registerFeedCrudRoutes(app);
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: `/feeds/${TARGET}/merge`,
    payload: { sourceFeedId },
  });
  await app.close();
  return res;
}

const wrote = () =>
  txCalls.some(
    (c) =>
      c.sql.includes("DELETE FROM feeds") ||
      c.sql.includes("UPDATE feed_sources SET feed_id") ||
      c.sql.includes("feed_saves"),
  );

beforeEach(() => {
  vi.clearAllMocks();
  txCalls = [];
  feedRows = [feed(TARGET), feed(SOURCE)];
  // loadFeed (step 6's re-read) — always resolves.
  mockPoolQuery.mockImplementation(() =>
    Promise.resolve({ rows: [LOADED_FEED], rowCount: 1 }),
  );
});

describe("feed merge", () => {
  it("moves sources into the target and deletes the SOURCE feed", async () => {
    const res = await merge();

    expect(res.statusCode).toBe(200);
    const move = txCalls.find((c) =>
      c.sql.includes("UPDATE feed_sources SET feed_id"),
    );
    expect(move?.params).toEqual([TARGET, SOURCE]);
    // Duplicates that could not move are cleared rather than orphaned.
    expect(
      txCalls.find((c) => c.sql.includes("DELETE FROM feed_sources"))?.params,
    ).toEqual([SOURCE]);
    expect(
      txCalls.find((c) => c.sql.includes("feed_saves"))?.params,
    ).toEqual([TARGET, SOURCE]);
    // The direction is the whole asymmetry of this route.
    expect(
      txCalls.find((c) => c.sql.includes("DELETE FROM feeds"))?.params,
    ).toEqual([SOURCE]);
  });

  it("locks both rows in a deterministic order, so opposing merges queue", async () => {
    // Structural pin (only Postgres evaluates it): A→B and B→A racing each
    // other take the two row locks in the same order and block instead of
    // deadlocking.
    await merge();

    const read = txCalls.find((c) => c.sql.includes("FROM feeds WHERE id = ANY"));
    expect(read?.sql).toContain("ORDER BY id");
    expect(read?.sql).toContain("FOR UPDATE");
  });

  it("403s on a feed owned by someone else, and writes nothing", async () => {
    feedRows = [feed(TARGET), feed(SOURCE, STRANGER)];

    const res = await merge();

    expect(res.statusCode).toBe(403);
    expect(wrote()).toBe(false);
  });

  it("404s when the source feed does not exist, and writes nothing", async () => {
    feedRows = [feed(TARGET)];

    const res = await merge();

    expect(res.statusCode).toBe(404);
    expect(wrote()).toBe(false);
  });

  it("refuses to merge a feed into itself before opening a transaction", async () => {
    const res = await merge(TARGET);

    expect(res.statusCode).toBe(400);
    expect(txCalls).toHaveLength(0);
  });
});
