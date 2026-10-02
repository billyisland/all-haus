import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A QUIET POLL STILL BEATS THE HEART (CA-C6, 2026-09-29).
//
// The heartbeat is an ABSENCE the poll must keep refuting: /admin/overview
// alarms when `feed_ingest_heartbeat` is older than 600s. The poll returned
// early when no source was due, BEFORE the write at its foot — so ten quiet
// minutes (every non-atproto source inside its interval) presented exactly
// like a dead worker. The early return now beats first.
//
// The other half is the control: a poll that THROWS must stay stale, which is
// why the fix is at the return and not in a `finally`.
//
// MUTATION CHECKS: drop the `await writeIngestHeartbeat()` at the empty return
// → "nothing due"; move the write into a `finally` → "a throwing poll".
// =============================================================================

const calls: string[] = [];
let dueRows: unknown[] = [];
let selectThrows: Error | null = null;

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("FROM ranked")) {
        if (selectThrows) throw selectThrows;
        return { rows: dueRows, rowCount: dueRows.length };
      }
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

const { feedIngestPoll } = await import("./feed-ingest-poll.js");

const helpers = { addJob: vi.fn(async () => undefined) } as never;
const heartbeats = () =>
  calls.filter((sql) => sql.includes("'feed_ingest_heartbeat'")).length;

beforeEach(() => {
  calls.length = 0;
  dueRows = [];
  selectThrows = null;
});

describe("feed_ingest_poll heartbeat", () => {
  it("nothing due: the heartbeat is still written", async () => {
    await feedIngestPoll({}, helpers);
    expect(heartbeats()).toBe(1);
  });

  it("sources due: the heartbeat is written once, after the enqueue", async () => {
    dueRows = [
      {
        id: "src-1",
        protocol: "rss",
        source_uri: "https://example.org/feed.xml",
        relay_urls: null,
      },
    ];
    await feedIngestPoll({}, helpers);
    expect(heartbeats()).toBe(1);
  });

  it("a throwing poll stays stale — no heartbeat", async () => {
    selectThrows = new Error("connection terminated");
    await expect(feedIngestPoll({}, helpers)).rejects.toThrow(
      "connection terminated",
    );
    expect(heartbeats()).toBe(0);
  });
});
