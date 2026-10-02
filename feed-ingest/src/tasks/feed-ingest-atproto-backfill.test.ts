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
const mockInsert = vi.fn().mockResolvedValue(false);
vi.mock("../lib/atproto-ingest.js", () => ({
  insertAtprotoItem: (...a: unknown[]) => mockInsert(...a),
}));
const mockRecordRepostEdge = vi.fn().mockResolvedValue(true);
vi.mock("../lib/repost-edge.js", () => ({
  recordRepostEdge: (...a: unknown[]) => mockRecordRepostEdge(...a),
}));

const { feedIngestAtprotoBackfill, ATPROTO_ENRICH_FAILED_ERROR } = await import(
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

// Script safeFetch: getProfile answers the known handle (so the enrichment
// marker — its own accounting, CA-C9 below — stays out of the F2 cases);
// getAuthorFeed consumes `feedResponses` in order (an Error rejects, anything
// else resolves).
type FetchResponse = { ok: boolean; status: number; text: string };
function scriptFetch(
  feedResponses: Array<FetchResponse | Error>,
  profile: FetchResponse = {
    ok: true,
    status: 200,
    text: JSON.stringify({ handle: "alice.bsky.social", displayName: "Alice" }),
  },
) {
  mockSafeFetch.mockReset();
  mockSafeFetch.mockImplementation((url: string) => {
    if (url.includes("getProfile")) return Promise.resolve(profile);
    const next = feedResponses.shift();
    if (!next) return Promise.resolve({ ok: false, status: 599, text: "" });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
}

function makeHelpers(addJob: ReturnType<typeof vi.fn> = vi.fn()) {
  return { addJob } as unknown as Parameters<Task>[1];
}

function run(helpers = makeHelpers()) {
  return feedIngestAtprotoBackfill({ sourceId: SOURCE_ID }, helpers);
}

const NOW = new Date().toISOString();
function postEntry(n: number, record: Record<string, unknown> = {}) {
  return {
    post: {
      uri: `at://did:plc:abc123/app.bsky.feed.post/${n}`,
      cid: `cid${n}`,
      author: { did: "did:plc:abc123", handle: "alice.bsky.social" },
      record: { $type: "app.bsky.feed.post", text: `p${n}`, createdAt: NOW, ...record },
      indexedAt: NOW,
    },
  };
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
    // Page 0 succeeds (one post, no inserts needed — the writer mock answers
    // false) and hands back a cursor; page 1 fails → break, not throw.
    const page0 = { cursor: "next", feed: [postEntry(1)] };
    scriptFetch([
      { ok: true, status: 200, text: JSON.stringify(page0) },
      { ok: false, status: 503, text: "" },
    ]);

    await expect(run()).resolves.toBeUndefined();

    expect(successUpdate(calls)).toBeDefined();
    expect(errorUpdate(calls)).toBeUndefined();
  });
});

// =============================================================================
// A REPOST IN THE HISTORY IS AN EDGE, NOT A SKIP (CA-C14, 2026-09-29).
//
// `detectAtprotoRepostFromReason` existed for exactly this path and was
// imported by nothing but its own unit test; the backfill `continue`d past
// every `reason` entry as "future work". A fresh subscription's history now
// carries the author's boosts as repost edges, the same edge the listener
// records for a live `app.bsky.feed.repost` commit.
//
// MUTATION CHECKS: restore `if (entry.reason) continue;` → "a reposted entry…";
// drop the try/catch around the edge → "a failing edge write…".
// =============================================================================

describe("feed_ingest_atproto_backfill reposts (CA-C14)", () => {
  it("a reposted entry is recorded as a repost edge to the boosted post, never inserted as a post", async () => {
    const calls = scriptPool(sourceRow());
    mockRecordRepostEdge.mockClear();
    mockInsert.mockClear();
    const boosted = {
      ...postEntry(7),
      post: {
        ...postEntry(7).post,
        uri: "at://did:plc:someoneelse/app.bsky.feed.post/7",
        author: { did: "did:plc:someoneelse", handle: "bob.bsky.social" },
      },
      reason: {
        $type: "app.bsky.feed.defs#reasonRepost",
        by: { did: "did:plc:abc123" },
        indexedAt: NOW,
      },
    };
    scriptFetch([
      { ok: true, status: 200, text: JSON.stringify({ feed: [boosted, postEntry(1)] }) },
    ]);

    await expect(run()).resolves.toBeUndefined();

    expect(mockRecordRepostEdge).toHaveBeenCalledTimes(1);
    expect(mockRecordRepostEdge.mock.calls[0]![1]).toMatchObject({
      protocol: "atproto",
      targetProtocol: "atproto",
      targetHandle: "at://did:plc:someoneelse/app.bsky.feed.post/7",
      actorHandle: "did:plc:abc123",
      originUri: null,
    });
    // The boosted post is somebody else's THING and is not written under this
    // source; only the author's own post reaches the writer.
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(successUpdate(calls)).toBeDefined();
  });

  it("a failing edge write is that edge's failure — the backfill completes", async () => {
    const calls = scriptPool(sourceRow());
    mockRecordRepostEdge.mockRejectedValueOnce(new Error("deadlock detected"));
    const boosted = {
      ...postEntry(8),
      reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { did: "did:plc:abc123" } },
    };
    scriptFetch([
      { ok: true, status: 200, text: JSON.stringify({ feed: [boosted] }) },
    ]);

    await expect(run()).resolves.toBeUndefined();
    expect(successUpdate(calls)).toBeDefined();
    expect(errorUpdate(calls)).toBeUndefined();
  });
});

// =============================================================================
// A FAILED PREFETCH ENQUEUE IS LOGGED, NEVER UNHANDLED (CA-C10, 2026-09-29).
//
// `void helpers.addJob(...)` left the rejection to nobody, and feed-ingest
// registers no `unhandledRejection` handler — so one DB hiccup on the enqueue
// crashed the worker process. It is now awaited inside the per-item catch: the
// row is committed, the prefetch is lost, the backfill goes on.
//
// MUTATION CHECK: put the `void` back → the rejection escapes the test as an
// unhandled rejection and vitest fails the run.
// =============================================================================

describe("feed_ingest_atproto_backfill prefetch enqueue (CA-C10)", () => {
  it("a rejected addJob does not escape — the next item is still written", async () => {
    const calls = scriptPool(sourceRow());
    mockInsert.mockClear();
    mockInsert.mockResolvedValue(true);
    const addJob = vi.fn().mockRejectedValueOnce(new Error("connection terminated"));
    const reply = postEntry(2, {
      reply: {
        root: { uri: "at://did:plc:x/app.bsky.feed.post/r", cid: "c" },
        parent: { uri: "at://did:plc:x/app.bsky.feed.post/r", cid: "c" },
      },
    });
    scriptFetch([
      { ok: true, status: 200, text: JSON.stringify({ feed: [reply, postEntry(3)] }) },
    ]);

    await expect(run(makeHelpers(addJob))).resolves.toBeUndefined();

    expect(addJob).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(successUpdate(calls)).toBeDefined();
    mockInsert.mockResolvedValue(false);
  });
});

// =============================================================================
// THE ENRICHMENT MARKER IS WRITTEN WHENEVER THE PROFILE IS MISSING (CA-C9).
//
// `enrichmentFailed` was `!profile && !source.handle`, so a source that
// already HAD a handle never got the marker — yet the listener's
// enrichMissingHandles filter names `last_error = ATPROTO_ENRICH_FAILED_ERROR`
// as its rename-retry class (§0i.10). That class was dead: a rename whose
// one-shot getProfile failed transiently kept the old handle for ever.
//
// MUTATION CHECK: `!profile && (!source.handle || …)` back → the first case.
// =============================================================================

describe("feed_ingest_atproto_backfill enrichment marker (CA-C9)", () => {
  it("a source WITH a handle whose getProfile fails gets the marker, not the success update", async () => {
    const calls = scriptPool(sourceRow({ handle: "alice.bsky.social" }));
    scriptFetch(
      [{ ok: true, status: 200, text: JSON.stringify({ feed: [] }) }],
      { ok: false, status: 502, text: "" },
    );

    await expect(run()).resolves.toBeUndefined();

    const marker = calls.find((c) => c.sql.includes("error_count = error_count + 1"));
    expect(marker).toBeDefined();
    expect(marker!.params[1]).toBe(ATPROTO_ENRICH_FAILED_ERROR);
    expect(successUpdate(calls)).toBeUndefined();
    expect(errorUpdate(calls)).toBeUndefined();
  });

  it("a source with NO handle takes the same path (the class it always covered)", async () => {
    const calls = scriptPool(sourceRow({ handle: null }));
    scriptFetch(
      [{ ok: true, status: 200, text: JSON.stringify({ feed: [] }) }],
      { ok: false, status: 502, text: "" },
    );
    await expect(run()).resolves.toBeUndefined();
    expect(calls.find((c) => c.sql.includes("error_count = error_count + 1"))).toBeDefined();
  });

  it("a resolved profile clears it — the success update runs", async () => {
    const calls = scriptPool(sourceRow({ error_count: 2, handle: "old.bsky.social" }));
    scriptFetch([{ ok: true, status: 200, text: JSON.stringify({ feed: [] }) }]);
    await expect(run()).resolves.toBeUndefined();
    const handleWrite = calls.find((c) => c.sql.includes("SET handle = $2"));
    expect(handleWrite?.params[1]).toBe("alice.bsky.social");
    expect(successUpdate(calls)).toBeDefined();
  });
});
