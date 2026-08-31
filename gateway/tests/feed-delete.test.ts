import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// DELETE /workspace/feeds/:id
//
// This file is what SURVIVES the starter-template guard, which retired with
// `feeds.is_starter_template` in migration 179 (FEED-FORMULAS-ADR D6, Phase 2
// step 2). Its predecessor — feed-delete-starter-guard.test.ts — was written
// around that guard, and three of the behaviours it pinned are nothing to do
// with the flag and would otherwise have gone unheld on a destructive route:
//
//   - only feed              → 409, before anything is read or torn down.
//   - ordinary delete        → 204, and removeSource runs per external source
//                              BEFORE the feed row goes. Ordering is the
//                              substance, not decoration: a bare DELETE
//                              cascades feed_sources away without passing
//                              through the feed-derived-subscription teardown,
//                              so the derived external_subscriptions row would
//                              survive, the source would poll forever, and the
//                              author card would read "Following" with no
//                              surface left to undo it (H6).
//   - genuinely absent       → 404.
//
// What is deliberately NOT here: any assertion that the DELETE carries a flag
// predicate. There is no flag. A feed on this floor is load-bearing for its
// owner alone — the designated seed FORMULA that replaced the template has no
// `feeds` row for anyone to delete, which is the whole reason the guard could
// go rather than needing to be made stronger.
// =============================================================================

/** Every SQL statement and, interleaved in order, each removeSource call. */
let calls: Array<{ sql: string; params: unknown[] }> = [];
let feedCount = 3;
let externalSources: Array<{ id: string }> = [];
let deleteRowCount = 1;

const removeSourceMock = vi.fn(() => {
  // Recorded into the same log as the SQL so ordering is assertable — the
  // teardown-before-delete property is exactly an ordering property.
  calls.push({ sql: "<removeSource>", params: [] });
  return Promise.resolve(undefined);
});

function scripted(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  // loadFeed — the only SELECT carrying the derived source_count column.
  if (sql.includes("source_count"))
    return Promise.resolve({
      rows: [
        {
          id: FEED,
          name: "A feed",
          appearance: {},
          sort_rank: 1,
          hidden: false,
          created_at: new Date(),
          updated_at: new Date(),
          source_count: 2,
          from_starter: false,
        },
      ],
      rowCount: 1,
    });
  if (sql.includes("COUNT(*) AS count FROM feeds"))
    return Promise.resolve({ rows: [{ count: String(feedCount) }], rowCount: 1 });
  if (sql.includes("FROM feed_sources"))
    return Promise.resolve({
      rows: externalSources,
      rowCount: externalSources.length,
    });
  if (sql.includes("DELETE FROM feeds"))
    return Promise.resolve({ rows: [], rowCount: deleteRowCount });
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[]) => scripted(sql, params) },
  withTransaction: (cb: (c: { query: typeof scripted }) => Promise<unknown>) =>
    cb({ query: scripted }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/routes/feeds/sources.js", () => ({
  removeSource: (...args: unknown[]) => removeSourceMock(...(args as [])),
}));

const OWNER = "00000000-0000-4000-8000-00000000aaaa";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: OWNER };
  },
}));

import { registerFeedCrudRoutes } from "../src/routes/feeds/crud.js";

const FEED = "11111111-0000-4000-8000-000000000001";

async function del() {
  const app = Fastify();
  registerFeedCrudRoutes(app);
  await app.ready();
  const res = await app.inject({ method: "DELETE", url: `/feeds/${FEED}` });
  await app.close();
  return res;
}

const indexOfSql = (needle: string) =>
  calls.findIndex((c) => c.sql.includes(needle));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  feedCount = 3;
  externalSources = [
    { id: "aaaaaaaa-0000-4000-8000-00000000000a" },
    { id: "bbbbbbbb-0000-4000-8000-00000000000b" },
  ];
  deleteRowCount = 1;
});

describe("DELETE /feeds/:id", () => {
  it("refuses to delete an owner's only feed, and tears nothing down", async () => {
    feedCount = 1;

    const res = await del();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Cannot delete your only feed" });
    expect(removeSourceMock).not.toHaveBeenCalled();
    expect(indexOfSql("DELETE FROM feeds")).toBe(-1);
  });

  it("tears every external source down through removeSource BEFORE the delete", async () => {
    const res = await del();

    expect(res.statusCode).toBe(204);
    // One call per external source — not one for the feed.
    expect(removeSourceMock).toHaveBeenCalledTimes(2);
    const lastTeardown = calls.map((c) => c.sql).lastIndexOf("<removeSource>");
    const deleteAt = indexOfSql("DELETE FROM feeds");
    expect(deleteAt).toBeGreaterThan(-1);
    expect(lastTeardown).toBeLessThan(deleteAt);
    // recordExclusion:false — deleting a feed is not a curation edit, so a
    // later re-add through follow-import must not be blocked by an exclusion
    // this delete wrote.
    expect(removeSourceMock.mock.calls[0]).toEqual([
      FEED,
      OWNER,
      "aaaaaaaa-0000-4000-8000-00000000000a",
      { recordExclusion: false },
    ]);
  });

  it("404s when the feed went away under the delete", async () => {
    deleteRowCount = 0;

    const res = await del();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Feed not found" });
  });
});
