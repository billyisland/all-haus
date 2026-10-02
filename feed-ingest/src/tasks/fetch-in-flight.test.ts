import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

// =============================================================================
// ONE FETCH IN FLIGHT PER SOURCE (CA-C5, 2026-09-29).
//
// graphile-worker's `jobKey` strips the key from a LOCKED job and inserts a
// second beside it, and the poll re-selected on `last_fetched_at`, which the
// fetch tasks stamp only at completion — so a fetch longer than the 60s tick
// ran twice. The poll now stamps `fetch_enqueued_at` for what it enqueues, and
// `fetchInFlightSql` keeps an in-flight source out of the next selection.
//
// Two halves, because only Postgres evaluates the predicate:
//   (1) DB-backed: the predicate over the five states a source can be in —
//       never claimed, claimed and not done, claimed after an earlier
//       completion, completed since the claim, and a claim past the staleness
//       bound (a crashed worker must not strand its source).
//   (2) Mocked pool: the poll stamps exactly what it enqueued, AFTER the
//       enqueue, and stamps nothing when nothing was enqueued.
//
// MUTATIONS: drop the staleness term → "stale" goes in-flight; drop the
// `> last_fetched_at` term → "completed" goes in-flight; drop the UPDATE →
// half (2) fails.
// =============================================================================

const calls: Array<{ sql: string; params?: unknown[] }> = [];
let dueRows: unknown[] = [];
const order: string[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("fetch_enqueued_at = now()")) order.push("claim");
      if (sql.includes("FROM ranked")) return { rows: dueRows, rowCount: dueRows.length };
      return { rows: [], rowCount: 0 };
    }),
  },
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@platform-pub/shared/lib/platform-blocks.js", () => ({
  sourceBlockedSql: () => "FALSE",
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));

const { feedIngestPoll, fetchInFlightSql, FETCH_IN_FLIGHT_STALE_SECONDS } =
  await import("./feed-ingest-poll.js");

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("fetchInFlightSql — evaluated by Postgres", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("BEGIN");
  });
  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("holds back only a claim that is newer than the last completion and still fresh", async () => {
    const tag = `c5-${Date.now().toString(36)}`;
    const states: Record<string, [string | null, string | null]> = {
      // name: [fetch_enqueued_at, last_fetched_at]
      never: [null, "now() - interval '1 hour'"],
      claimed_first_time: ["now() - interval '1 minute'", null],
      claimed_after_earlier: ["now() - interval '1 minute'", "now() - interval '2 hours'"],
      completed_since: ["now() - interval '5 minutes'", "now() - interval '1 minute'"],
      stale: ["now() - interval '20 minutes'", "now() - interval '2 hours'"],
    };
    const ids: Record<string, string> = {};
    for (const [name, [claimed, fetched]] of Object.entries(states)) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO external_sources (protocol, source_uri, fetch_enqueued_at, last_fetched_at)
         VALUES ('rss', $1, ${claimed ?? "NULL"}, ${fetched ?? "NULL"}) RETURNING id`,
        [`https://${tag}.example/${name}`],
      );
      ids[name] = rows[0].id;
    }

    const { rows } = await client.query<{ id: string }>(
      `SELECT es.id FROM external_sources es
        WHERE es.id = ANY($1::uuid[]) AND ${fetchInFlightSql("es", "$2")}`,
      [Object.values(ids), FETCH_IN_FLIGHT_STALE_SECONDS],
    );
    const inFlight = new Set(rows.map((r) => r.id));
    const named = Object.keys(ids).filter((n) => inFlight.has(ids[n])).sort();

    expect(named).toEqual(["claimed_after_earlier", "claimed_first_time"]);
  });

  it("the staleness bound exceeds the longest honest fetch (20 AP pages at 10s)", () => {
    expect(FETCH_IN_FLIGHT_STALE_SECONDS).toBeGreaterThan(20 * 10 + 60);
  });
});

describe("feed_ingest_poll — the in-flight claim", () => {
  beforeEach(() => {
    calls.length = 0;
    order.length = 0;
    dueRows = [];
  });

  it("claims exactly the sources it enqueued, after enqueueing them", async () => {
    dueRows = [
      { id: "11111111-1111-4111-8111-111111111111", protocol: "rss", source_uri: "https://a.example/feed", relay_urls: null },
      { id: "22222222-2222-4222-8222-222222222222", protocol: "rss", source_uri: "https://b.example/feed", relay_urls: null },
      // No task for email: not enqueued, so not claimed.
      { id: "33333333-3333-4333-8333-333333333333", protocol: "email", source_uri: "x@y", relay_urls: null },
    ];
    const addJob = vi.fn(async () => {
      order.push("enqueue");
    });

    await feedIngestPoll({}, { addJob } as never);

    const claim = calls.find((c) => c.sql.includes("fetch_enqueued_at = now()"));
    expect(claim?.params?.[0]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(order).toEqual(["enqueue", "enqueue", "claim"]);
    // And the selection asks the predicate, bound to the constant.
    const select = calls.find((c) => c.sql.includes("FROM ranked"));
    expect(select?.sql).toContain("fetch_enqueued_at > now() - make_interval(secs => $3)");
    expect(select?.params?.[2]).toBe(FETCH_IN_FLIGHT_STALE_SECONDS);
  });

  it("claims nothing when nothing was enqueued", async () => {
    await feedIngestPoll({}, { addJob: vi.fn() } as never);
    expect(calls.some((c) => c.sql.includes("fetch_enqueued_at = now()"))).toBe(false);
  });
});
