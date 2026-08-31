import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Task } from "graphile-worker";

// =============================================================================
// feed_ingest_atproto_backfill — failure accounting + retry semantics
// (2026-07-09 audit F2). A failed backfill must record error_count/last_error
// (deactivating at the cap) and RE-THROW so graphile-worker retries — there is
// no poll fallback for atproto while Jetstream is healthy. Success resets the
// accounting; a mid-pagination failure keeps the partial backfill as success.
// =============================================================================

const mockPool = { query: vi.fn() };
const mockSafeFetch = vi.fn();

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: mockPool,
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  ),
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: mockSafeFetch,
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("../lib/atproto-ingest.js", () => ({
  insertAtprotoItem: vi.fn().mockResolvedValue(false),
}));

const { feedIngestAtprotoBackfill } = await import(
  "./feed-ingest-atproto-backfill.js"
);

const SOURCE_ID = "00000000-0000-0000-0000-0000000000aa";

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_ID,
    source_uri: "did:plc:abc123",
    // Handle already known — keeps the enrichment self-heal path (its own
    // accounting, listener-owned retries) out of these tests.
    handle: "alice.bsky.social",
    display_name: "Alice",
    avatar_url: null,
    error_count: 0,
    ...overrides,
  };
}

// Script the pool: the source SELECT returns `row`; everything else records
// and returns no rows.
function scriptPool(row: unknown) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(
    (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("protocol = 'atproto' AND is_active"))
        return Promise.resolve({ rows: row ? [row] : [] });
      return Promise.resolve({ rows: [] });
    },
  );
  return calls;
}

// Script safeFetch: getProfile fails soft (returns null upstream — no
// enrichment writes since the source already has a handle); getAuthorFeed
// consumes `feedResponses` in order (an Error rejects, anything else resolves).
type FetchResponse = { ok: boolean; status: number; text: string };
function scriptFetch(feedResponses: Array<FetchResponse | Error>) {
  mockSafeFetch.mockReset();
  mockSafeFetch.mockImplementation((url: string) => {
    if (url.includes("getProfile"))
      return Promise.resolve({ ok: false, status: 500, text: "" });
    const next = feedResponses.shift();
    if (!next) return Promise.resolve({ ok: false, status: 599, text: "" });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
}

function makeHelpers() {
  return { addJob: vi.fn() } as unknown as Parameters<Task>[1];
}

function run() {
  return feedIngestAtprotoBackfill({ sourceId: SOURCE_ID }, makeHelpers());
}

const errorUpdate = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.includes("error_count = $2"));
const successUpdate = (calls: Array<{ sql: string; params: unknown[] }>) =>
  calls.find((c) => c.sql.includes("error_count = 0"));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("feed_ingest_atproto_backfill failure accounting (audit F2)", () => {
  it("first-page HTTP failure records error accounting and re-throws", async () => {
    const calls = scriptPool(sourceRow());
    scriptFetch([{ ok: false, status: 502, text: "" }]);

    await expect(run()).rejects.toThrow("getAuthorFeed HTTP 502");

    const upd = errorUpdate(calls);
    expect(upd).toBeDefined();
    // [sourceId, newErrorCount, lastError, deactivate, backoffSeconds]
    expect(upd!.params[0]).toBe(SOURCE_ID);
    expect(upd!.params[1]).toBe(1);
    expect(upd!.params[2]).toContain("HTTP 502");
    expect(upd!.params[3]).toBe(false);
    expect(upd!.params[4]).toBe(600); // 300 * 2^min(1,6)
    expect(successUpdate(calls)).toBeUndefined();
  });

  it("deactivates at the max-error cap", async () => {
    const calls = scriptPool(sourceRow({ error_count: 9 }));
    scriptFetch([{ ok: false, status: 400, text: "" }]);

    await expect(run()).rejects.toThrow("getAuthorFeed HTTP 400");

    const upd = errorUpdate(calls);
    expect(upd!.params[1]).toBe(10);
    expect(upd!.params[3]).toBe(true); // error_count reached default cap 10
  });

  it("a thrown network error takes the same accounting path and re-throws", async () => {
    const calls = scriptPool(sourceRow());
    scriptFetch([new Error("connect ETIMEDOUT")]);

    await expect(run()).rejects.toThrow("connect ETIMEDOUT");

    const upd = errorUpdate(calls);
    expect(upd).toBeDefined();
    expect(upd!.params[1]).toBe(1);
    expect(upd!.params[2]).toContain("ETIMEDOUT");
  });

  it("success resets error accounting and does not throw", async () => {
    const calls = scriptPool(sourceRow({ error_count: 3 }));
    scriptFetch([{ ok: true, status: 200, text: JSON.stringify({ feed: [] }) }]);

    await expect(run()).resolves.toBeUndefined();

    expect(successUpdate(calls)).toBeDefined();
    expect(errorUpdate(calls)).toBeUndefined();
  });

  it("mid-pagination failure keeps the partial backfill as a success", async () => {
    const calls = scriptPool(sourceRow());
    // Page 0 succeeds (repost-only entries — skipped, no inserts needed) and
    // hands back a cursor; page 1 fails → break, not throw.
    const page0 = {
      cursor: "next",
      feed: [
        {
          post: {
            uri: "at://did:plc:abc123/app.bsky.feed.post/1",
            cid: "cid1",
            author: { did: "did:plc:abc123", handle: "alice.bsky.social" },
            record: { $type: "app.bsky.feed.post", text: "x", createdAt: new Date().toISOString() },
            indexedAt: new Date().toISOString(),
          },
          reason: { $type: "app.bsky.feed.defs#reasonRepost" },
        },
      ],
    };
    scriptFetch([
      { ok: true, status: 200, text: JSON.stringify(page0) },
      { ok: false, status: 503, text: "" },
    ]);

    await expect(run()).resolves.toBeUndefined();

    expect(successUpdate(calls)).toBeDefined();
    expect(errorUpdate(calls)).toBeUndefined();
  });
});
