import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// THE ACTIVITYPUB CAP IS A RESUME POINT, AND ONE POISON ITEM IS NOT THE SOURCE
// (CA-C1 + CA-C2, 2026-09-29; the rule is `planNostrPollBatch`'s).
//
// Two defects in one loop. (1) The task sliced the NEWEST `maxItems` off a
// newest-first walk and wrote the cursor as the newest item the WALK saw, so
// everything past the cap fell into a gap the next poll — which stops at that
// cursor — never revisited. (2) `withTransaction(insertActivityPubItem)` had no
// per-item catch, so one item Postgres refuses (a NUL in a title) escaped to
// the outer catch as a fact about the SOURCE: error_count + 1, backoff, cursor
// untouched — and because the walk restarts at the top every poll, the same
// item threw every time until `maxErrors` set is_active = FALSE.
//
// The planner cases assert the cursor AGAINST the batch, the only relationship
// that makes the gap impossible. The task cases assert what the OTHER items
// did — a status code, a thrown type and a return value all pass against the
// aborting loop; only the neighbours' inserts and the success UPDATE tell it
// from a per-item catch.
//
// MUTATION CHECKS (each fails the named case):
//   `seen.slice(0, cap)` (keep newest)       → "over the cap: the OLDEST are kept…"
//   cursor = seen[0].cursorId (newest seen)   → the same case, on `newCursor`
//   drop the null-cursorId skip               → "an entry with no id is never the cursor"
//   drop the per-item try/catch in the task   → "a poison item is skipped, counted…"
//   `.slice(0, maxItems)` back in the task    → "the task hands the cap to the adapter"
// =============================================================================

interface Call {
  sql: string;
  params: unknown[];
}
const calls: Call[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT id, source_uri")) {
        return {
          rows: [
            {
              id: "src-1",
              source_uri: "https://mastodon.example/users/alice",
              cursor: "https://mastodon.example/users/alice/statuses/1/activity",
              error_count: 0,
              display_name: "Alice",
              avatar_url: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));

const logs = { warn: vi.fn(), info: vi.fn() };
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: {
    info: (...a: unknown[]) => logs.info(...a),
    warn: (...a: unknown[]) => logs.warn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@platform-pub/shared/lib/platform-blocks.js", () => ({
  isSourceBlocked: vi.fn(async () => false),
}));

const mockInsert = vi.fn();
vi.mock("../lib/activitypub-ingest.js", () => ({
  insertActivityPubItem: (...a: unknown[]) => mockInsert(...a),
  recordInstanceSuccess: vi.fn(async () => undefined),
  recordInstanceFailure: vi.fn(async () => undefined),
}));

vi.mock("../lib/repost-edge.js", () => ({
  recordRepostEdge: vi.fn(async () => true),
}));

const config = new Map<string, string>();
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => config),
}));

const mockFetchActor = vi.fn();
const mockFetchOutbox = vi.fn();
vi.mock("../adapters/activitypub.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/activitypub.js")>();
  return {
    ...actual,
    fetchActor: (...a: unknown[]) => mockFetchActor(...a),
    fetchOutbox: (...a: unknown[]) => mockFetchOutbox(...a),
    fetchMastodonTimeline: vi.fn(),
  };
});

const { planActivityPubBatch } = await import("../adapters/activitypub.js");
const { feedIngestActivityPub } = await import("./feed-ingest-activitypub.js");
type Item = import("../adapters/activitypub.js").NormalisedActivityPubItem;

const ACTOR = "https://mastodon.example/users/alice";

function item(n: number, extra: Partial<Item> = {}): Item {
  return {
    sourceItemUri: `${ACTOR}/statuses/${n}`,
    title: null,
    authorName: "Alice",
    authorHandle: "alice@mastodon.example",
    authorAvatarUrl: null,
    authorUri: ACTOR,
    contentText: `post ${n}`,
    contentHtml: `<p>post ${n}</p>`,
    language: null,
    media: [],
    sourceReplyUri: null,
    sourceQuoteUri: null,
    contentWarning: null,
    publishedAt: new Date(1_700_000_000_000 + n * 1000),
    webUrl: null,
    interactionData: { id: `${ACTOR}/statuses/${n}` },
    ...extra,
  };
}

const seenEntry = (n: number, withItem = true, withId = true) => ({
  cursorId: withId ? `${ACTOR}/statuses/${n}/activity` : null,
  item: withItem ? item(n) : null,
});

describe("planActivityPubBatch", () => {
  it("under the cap: everything is handed over and the cursor is the newest seen", () => {
    const plan = planActivityPubBatch([seenEntry(3), seenEntry(2), seenEntry(1)], 10);
    expect(plan.items.map((i) => i.sourceItemUri)).toEqual([
      `${ACTOR}/statuses/3`,
      `${ACTOR}/statuses/2`,
      `${ACTOR}/statuses/1`,
    ]);
    expect(plan.deferred).toBe(0);
    expect(plan.newCursor).toBe(`${ACTOR}/statuses/3/activity`);
  });

  it("over the cap: the OLDEST are kept and the cursor stops at the newest KEPT", () => {
    // Newest-first, as the walk produces it.
    const seen = [5, 4, 3, 2, 1].map((n) => seenEntry(n));
    const plan = planActivityPubBatch(seen, 3);
    expect(plan.items.map((i) => i.sourceItemUri)).toEqual([
      `${ACTOR}/statuses/3`,
      `${ACTOR}/statuses/2`,
      `${ACTOR}/statuses/1`,
    ]);
    expect(plan.deferred).toBe(2);
    // The whole point: 4 and 5 were NOT handed over, so the cursor must not be
    // past them. Under the old shape the task kept 5, 4 and 3, wrote 5's
    // activity as the cursor, and 2 and 1 fell into a gap no poll revisits.
    expect(plan.newCursor).toBe(`${ACTOR}/statuses/3/activity`);
  });

  it("the next poll resumes with nothing missed", () => {
    // The walk stops on the cursor id, so the refetch is exactly the items
    // newer than the newest kept.
    const all = [5, 4, 3, 2, 1].map((n) => seenEntry(n));
    const first = planActivityPubBatch(all, 3);
    const refetched = all.filter(
      (e) => e.cursorId !== first.newCursor && Number(e.item!.sourceItemUri.split("/").pop()) > 3,
    );
    const second = planActivityPubBatch(refetched, 3);
    const both = [...first.items, ...second.items].map((i) => i.sourceItemUri);
    expect(new Set(both).size).toBe(5);
    expect(second.newCursor).toBe(`${ACTOR}/statuses/5/activity`);
  });

  it("an entry the walk accepted but could not normalise still moves the cursor", () => {
    // The cursor is a max over what was CONSIDERED. A batch of nothing but
    // unnormalisable entries would otherwise spin the source on one window.
    const plan = planActivityPubBatch([seenEntry(2, false), seenEntry(1, false)], 10);
    expect(plan.items).toEqual([]);
    expect(plan.newCursor).toBe(`${ACTOR}/statuses/2/activity`);
  });

  it("an entry with no id is never the cursor — the newest kept entry that has one is", () => {
    const plan = planActivityPubBatch([seenEntry(3, true, false), seenEntry(2), seenEntry(1)], 10);
    expect(plan.items).toHaveLength(3);
    expect(plan.newCursor).toBe(`${ACTOR}/statuses/2/activity`);
  });

  it("nothing seen: nothing handed over, and the cursor is left alone", () => {
    const plan = planActivityPubBatch([], 10);
    expect(plan).toEqual({ items: [], newCursor: null, deferred: 0 });
  });
});

// -----------------------------------------------------------------------------
// The task
// -----------------------------------------------------------------------------

const helpers = { addJob: vi.fn(async () => undefined) } as never;

function sourceUpdate(): Call | undefined {
  return calls.find(
    (c) =>
      c.sql.includes("UPDATE external_sources") &&
      c.sql.includes("last_fetched_at"),
  );
}

beforeEach(() => {
  calls.length = 0;
  config.clear();
  mockInsert.mockReset();
  mockFetchActor.mockReset();
  mockFetchOutbox.mockReset();
  logs.warn.mockReset();
  logs.info.mockReset();
  (helpers as { addJob: ReturnType<typeof vi.fn> }).addJob.mockReset();
  mockFetchActor.mockResolvedValue({
    id: ACTOR,
    name: "Alice",
    summary: null,
    icon: null,
    preferredUsername: "alice",
    host: "mastodon.example",
    outbox: `${ACTOR}/outbox`,
    reader: "outbox",
    apiAccountId: null,
  });
});

async function run() {
  await feedIngestActivityPub({ sourceId: "src-1" }, helpers);
}

describe("feed_ingest_activitypub", () => {
  it("the task hands the cap to the adapter and processes what it is given, unsliced", async () => {
    config.set("feed_ingest_max_items_per_fetch", "2");
    // The adapter owns the cap; the task must not slice again. The mock hands
    // back MORE than the cap on purpose: a second `.slice(0, maxItems)` in the
    // task is the exact shape of the defect (it keeps the newest), and this is
    // the only way to see it from outside.
    mockFetchOutbox.mockResolvedValue({
      items: [item(3), item(2), item(1)],
      reposts: [],
      newCursor: `${ACTOR}/statuses/3/activity`,
      deferred: 7,
    });
    mockInsert.mockResolvedValue(true);

    await run();

    expect(mockFetchOutbox).toHaveBeenCalledTimes(1);
    const opts = mockFetchOutbox.mock.calls[0]![1] as { maxItems: number };
    expect(opts.maxItems).toBe(2);
    expect(mockInsert).toHaveBeenCalledTimes(3);
    // The cursor written is the adapter's, verbatim.
    const upd = sourceUpdate();
    expect(upd?.sql).toContain("error_count     = 0");
    expect(upd?.params[1]).toBe(`${ACTOR}/statuses/3/activity`);
    // …and the shortfall the cap left is said out loud.
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({ inserted: 3, skipped: 0, deferred: 7 }),
      expect.any(String),
    );
  });

  it("a poison item is skipped, counted and logged — its neighbours are inserted and the cursor advances", async () => {
    mockFetchOutbox.mockResolvedValue({
      items: [item(3), item(2), item(1)],
      reposts: [],
      newCursor: `${ACTOR}/statuses/3/activity`,
      deferred: 0,
    });
    mockInsert.mockImplementation(async (_c: unknown, _s: unknown, it: Item) => {
      if (it.sourceItemUri.endsWith("/2"))
        throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
      return true;
    });

    await run();

    // What the OTHER units did: both neighbours were attempted and written.
    const attempted = mockInsert.mock.calls.map((c) => (c[2] as Item).sourceItemUri);
    expect(attempted).toEqual([
      `${ACTOR}/statuses/3`,
      `${ACTOR}/statuses/2`,
      `${ACTOR}/statuses/1`,
    ]);
    // The SUCCESS update ran, with the cursor: a fact about one item is not a
    // fact about the source. Under the aborting loop this was the error
    // UPDATE (error_count + 1, cursor untouched) — every poll, until
    // deactivation.
    const upd = sourceUpdate();
    expect(upd?.sql).toContain("error_count     = 0");
    expect(upd?.params[1]).toBe(`${ACTOR}/statuses/3/activity`);
    expect(calls.some((c) => c.sql.includes("is_active             = CASE"))).toBe(false);
    // The shortfall is COUNTED beside the total, and the item is named.
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uri: `${ACTOR}/statuses/2` }),
      expect.stringContaining("skipped"),
    );
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({ inserted: 2, skipped: 1 }),
      expect.any(String),
    );
  });

  it("a failed prefetch enqueue is the same kind of fact — counted, never the source's", async () => {
    mockFetchOutbox.mockResolvedValue({
      items: [item(2, { sourceReplyUri: `${ACTOR}/statuses/0` }), item(1)],
      reposts: [],
      newCursor: `${ACTOR}/statuses/2/activity`,
      deferred: 0,
    });
    mockInsert.mockResolvedValue(true);
    (helpers as { addJob: ReturnType<typeof vi.fn> }).addJob.mockRejectedValueOnce(
      new Error("connection terminated"),
    );

    await run();

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(sourceUpdate()?.sql).toContain("error_count     = 0");
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({ inserted: 2, skipped: 1 }),
      expect.any(String),
    );
  });

  it("a failure of the WALK is still the source's: the error UPDATE, and no cursor", async () => {
    // The control: the per-item catch must not have swallowed the outer one.
    mockFetchOutbox.mockRejectedValue(new Error("Outbox page is not valid JSON"));

    await run();

    const upd = sourceUpdate();
    expect(upd?.sql).toContain("error_count           = $2");
    expect(upd?.params[1]).toBe(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
