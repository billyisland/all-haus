import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// THE CURSOR FLUSH KEEPS THE ENRICHMENT MARKER (CA-C9, 2026-09-29).
//
// Every live Jetstream event flushed `error_count = 0, last_error = NULL` onto
// its source. That is how a poll-fallback error heals when live events prove
// the source alive — and it also wiped `ATPROTO_ENRICH_FAILED_ERROR`, the
// marker the listener's own enrichMissingHandles filter names as its
// rename-retry class, and reset that class's backoff for any posting source.
// The flush now clears only what is NOT the marker.
//
// The CASE is Postgres's to evaluate, so this is a STRUCTURAL PIN: it proves
// the statement still asks to keep the marker and its count, and that the
// marker it compares against is the one the backfill writes.
//
// MUTATION CHECK: `error_count = 0, last_error = NULL` back → both cases.
// =============================================================================

const calls: Array<{ sql: string; params: unknown[] }> = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(),
  },
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));

const { JetstreamListener } = await import("./listener.js");
const { ATPROTO_ENRICH_FAILED_ERROR } = await import(
  "../tasks/feed-ingest-atproto-backfill.js"
);

interface Private {
  recordCursor(sourceId: string, timeUs: number): void;
  flushCursors(): Promise<void>;
}

beforeEach(() => {
  calls.length = 0;
});

describe("Jetstream cursor flush", () => {
  it("clears the error state only where it is not the enrichment marker", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    l.recordCursor("00000000-0000-0000-0000-0000000000aa", 1_700_000_000_000_000);
    await l.flushCursors();

    const upd = calls.find((c) => c.sql.includes("UPDATE external_sources AS s"));
    expect(upd).toBeDefined();
    const marker = upd!.params.length; // the last placeholder
    expect(upd!.params[marker - 1]).toBe(ATPROTO_ENRICH_FAILED_ERROR);
    expect(upd!.sql).toContain(
      `error_count = CASE WHEN s.last_error = $${marker} THEN s.error_count ELSE 0 END`,
    );
    expect(upd!.sql).toContain(
      `last_error = CASE WHEN s.last_error = $${marker} THEN s.last_error ELSE NULL END`,
    );
    // …and the cursor half is untouched.
    expect(upd!.sql).toContain("GREATEST(COALESCE(s.cursor::BIGINT, 0), v.cursor)");
  });

  it("the marker placeholder sits AFTER every (id, cursor) pair, so a two-source batch does not shift it", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    l.recordCursor("00000000-0000-0000-0000-0000000000aa", 1);
    l.recordCursor("00000000-0000-0000-0000-0000000000bb", 2);
    await l.flushCursors();

    const upd = calls.find((c) => c.sql.includes("UPDATE external_sources AS s"))!;
    expect(upd.params).toHaveLength(5);
    expect(upd.params[4]).toBe(ATPROTO_ENRICH_FAILED_ERROR);
    expect(upd.sql).toContain("s.last_error = $5");
    expect(upd.sql).toContain("($1::uuid, $2::bigint), ($3, $4)");
  });
});
