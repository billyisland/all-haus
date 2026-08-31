import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// FOLLOW-GRAPH-IMPORT-ADR §6.3 — exclusion hooks on BOTH membership-removal
// paths: removeSource (the DELETE route's core) and the move endpoint. A
// removal/move-out from an import-bound feed must append the source's
// canonical identity to feed_import_exclusions inside the same transaction,
// so "Sync now" never resurrects a deliberate local edit.
//
// The DB is a scripted transaction client; the INSERT…SELECT itself carries
// the binding/protocol filtering, so the unit contract here is: the hook runs,
// with the right (feedId, externalSourceId), in the right transaction, on the
// right paths — and never for non-external sources.
// =============================================================================

let txCalls: Array<{ sql: string; params: unknown[] }> = [];
// Configurable per-test responses for the scripted client.
let deleteReturns: Array<Record<string, unknown>> = [];
let moveReturns: Array<Record<string, unknown>> = [];
let remainingCount = 0;
let sourceProtocol = "atproto";

const mockPoolQuery = vi.fn();

function scriptedQuery(sql: string, params: unknown[] = []) {
  txCalls.push({ sql, params });
  if (sql.includes("DELETE FROM feed_sources"))
    return Promise.resolve({ rows: deleteReturns, rowCount: deleteReturns.length });
  if (sql.includes("UPDATE feed_sources SET feed_id"))
    return Promise.resolve({ rows: moveReturns, rowCount: moveReturns.length });
  if (sql.includes("AS remaining"))
    return Promise.resolve({ rows: [{ remaining: String(remainingCount) }], rowCount: 1 });
  if (sql.includes("SELECT protocol FROM external_sources"))
    return Promise.resolve({ rows: [{ protocol: sourceProtocol }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

const markFollowListDirty = vi.fn(async () => undefined);
vi.mock("../src/lib/discovery-publish.js", () => ({
  markFollowListDirty: (...a: unknown[]) => markFollowListDirty(...a),
}));

vi.mock("../src/lib/source-liveness.js", () => ({
  verifySourceLiveness: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OWNER = "00000000-0000-4000-8000-00000000aaaa";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: OWNER };
  },
}));

import {
  removeSource,
  registerFeedSourcesRoutes,
} from "../src/routes/feeds/sources.js";

const FEED = "11111111-0000-4000-8000-000000000001";
const TARGET_FEED = "22222222-0000-4000-8000-000000000002";
const SOURCE_ROW = "33333333-0000-4000-8000-000000000003";
const XS = "44444444-0000-4000-8000-000000000004";

const FEED_ROW = {
  id: FEED,
  name: "Bluesky follows",
  appearance: {},
  sort_rank: 1,
  hidden: false,
  created_at: new Date(),
  updated_at: new Date(),
  source_count: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  txCalls = [];
  deleteReturns = [];
  moveReturns = [];
  remainingCount = 0;
  sourceProtocol = "atproto";
  // loadFeed (and any other direct pool read) — always find the feed.
  mockPoolQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM feeds f"))
      return Promise.resolve({ rows: [FEED_ROW], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
});

function exclusionCalls() {
  return txCalls.filter((c) => c.sql.includes("feed_import_exclusions"));
}

describe("removeSource exclusion hook", () => {
  it("records an exclusion when an external source is removed, before the teardown decision", async () => {
    deleteReturns = [{ source_type: "external_source", external_source_id: XS }];
    remainingCount = 1; // still in another feed — no teardown

    const result = await removeSource(FEED, OWNER, SOURCE_ROW);

    expect(result).toEqual({ notFound: false, toreDownNostr: false });
    const excl = exclusionCalls();
    expect(excl).toHaveLength(1);
    expect(excl[0].params).toEqual([FEED, XS]);
    // Hook runs inside the transaction, after the DELETE, before the count.
    const order = txCalls.map((c) =>
      c.sql.includes("DELETE FROM feed_sources")
        ? "delete"
        : c.sql.includes("feed_import_exclusions")
          ? "exclude"
          : c.sql.includes("AS remaining")
            ? "count"
            : "other",
    );
    expect(order.indexOf("exclude")).toBeGreaterThan(order.indexOf("delete"));
    expect(order.indexOf("exclude")).toBeLessThan(order.indexOf("count"));
    // No teardown while the source remains in another feed.
    expect(
      txCalls.some((c) => c.sql.includes("DELETE FROM external_subscriptions")),
    ).toBe(false);
  });

  it("still tears down the last-feed subscription (and marks kind-3 dirty for nostr)", async () => {
    deleteReturns = [{ source_type: "external_source", external_source_id: XS }];
    remainingCount = 0;
    sourceProtocol = "nostr_external";

    const result = await removeSource(FEED, OWNER, SOURCE_ROW);

    expect(result.toreDownNostr).toBe(true);
    expect(exclusionCalls()).toHaveLength(1);
    expect(
      txCalls.some((c) => c.sql.includes("DELETE FROM external_subscriptions")),
    ).toBe(true);
    expect(
      txCalls.some((c) => c.sql.includes("SET orphaned_at = now()")),
    ).toBe(true);
    expect(markFollowListDirty).toHaveBeenCalledWith(OWNER);
  });

  it("records no exclusion for non-external sources", async () => {
    deleteReturns = [{ source_type: "account", external_source_id: null }];

    const result = await removeSource(FEED, OWNER, SOURCE_ROW);

    expect(result).toEqual({ notFound: false, toreDownNostr: false });
    expect(exclusionCalls()).toHaveLength(0);
  });

  it("returns notFound without any hook when the row doesn't exist", async () => {
    deleteReturns = [];

    const result = await removeSource(FEED, OWNER, SOURCE_ROW);

    expect(result.notFound).toBe(true);
    expect(exclusionCalls()).toHaveLength(0);
  });
});

describe("move endpoint exclusion hook", () => {
  async function buildApp() {
    const app = Fastify();
    registerFeedSourcesRoutes(app);
    await app.ready();
    return app;
  }

  it("records an exclusion against the SOURCE feed when an external source moves out", async () => {
    moveReturns = [{ source_type: "external_source", external_source_id: XS }];
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/feeds/${FEED}/sources/${SOURCE_ROW}/move`,
      payload: { targetFeedId: TARGET_FEED },
    });

    expect(res.statusCode).toBe(200);
    const excl = exclusionCalls();
    expect(excl).toHaveLength(1);
    // Excluded from the feed it LEFT, not the target.
    expect(excl[0].params).toEqual([FEED, XS]);
    await app.close();
  });

  it("records no exclusion when moving a native source", async () => {
    moveReturns = [{ source_type: "account", external_source_id: null }];
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/feeds/${FEED}/sources/${SOURCE_ROW}/move`,
      payload: { targetFeedId: TARGET_FEED },
    });

    expect(res.statusCode).toBe(200);
    expect(exclusionCalls()).toHaveLength(0);
    await app.close();
  });

  it("404s (no hook) when the source row isn't in the feed", async () => {
    moveReturns = [];
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/feeds/${FEED}/sources/${SOURCE_ROW}/move`,
      payload: { targetFeedId: TARGET_FEED },
    });

    expect(res.statusCode).toBe(404);
    expect(exclusionCalls()).toHaveLength(0);
    await app.close();
  });
});
