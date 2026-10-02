import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// THE FLUSH WRITES THE STREAM WATERMARK, AND A DELETE IS KEYED ON THE URI
// (CA-C7 + CA-C11, 2026-09-29) — the listener half.
//
// C7: after the per-source UPDATE lands, the flush UPSERTs `jetstream_cursor`
// with the batch's newest success, held below any ingest that failed since
// the last resume, under GREATEST so an out-of-order batch never moves it
// back. Runtime state, never seeded, read-only in the admin editor.
//
// C11: a context row inherits the hydrating focal's source_id until real
// ingest promotes it, and the backfill never re-offers an older post, so a
// delete matched on `source_id = $1` missed a subscribed author's older post
// held only as a thread parent. Matched on (protocol, source_item_uri) now.
//
// Both are STRUCTURAL pins on SQL Postgres evaluates.
//
// MUTATION CHECKS: drop the watermark UPSERT → "the flush writes…"; write the
// batch max regardless of the floor → "…held below a failure"; put
// `source_id = $1` back in handleDelete → "a delete is keyed…".
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
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    }),
  ),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/platform-config.js", () => ({
  getPlatformConfig: vi.fn(async () => new Map<string, string>()),
}));

const { JetstreamListener } = await import("./listener.js");

interface Private {
  recordCursor(sourceId: string, timeUs: number): void;
  recordFailure(timeUs: number): void;
  flushCursors(): Promise<void>;
  handleDelete(sourceId: string, did: string, rkey: string, timeUs: number): Promise<void>;
  watermark: bigint | null;
}

const SRC = "00000000-0000-0000-0000-0000000000aa";
const watermarkWrite = () =>
  calls.find((c) => c.sql.includes("'jetstream_cursor'") && c.sql.includes("INSERT INTO platform_config"));

beforeEach(() => {
  calls.length = 0;
});

describe("Jetstream watermark", () => {
  it("the flush writes the batch's newest success, under GREATEST, after the per-source update", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    l.recordCursor(SRC, 1_000);
    l.recordCursor("00000000-0000-0000-0000-0000000000bb", 3_000);
    await l.flushCursors();

    const perSource = calls.findIndex((c) => c.sql.includes("UPDATE external_sources AS s"));
    const wm = watermarkWrite();
    expect(wm).toBeDefined();
    expect(calls.indexOf(wm!)).toBeGreaterThan(perSource);
    expect(wm!.params[0]).toBe("3000");
    expect(wm!.sql).toContain("GREATEST(platform_config.value::bigint, EXCLUDED.value::bigint)");
    expect(l.watermark).toBe(3_000n);
  });

  it("…held below a failure since the last resume", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    l.recordFailure(2_000);
    l.recordCursor(SRC, 3_000);
    await l.flushCursors();
    expect(watermarkWrite()!.params[0]).toBe("2000");
  });

  it("an empty flush writes no watermark", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    await l.flushCursors();
    expect(watermarkWrite()).toBeUndefined();
  });
});

describe("Jetstream delete", () => {
  it("a delete is keyed on (protocol, source_item_uri) on both tables — never on source_id", async () => {
    const l = new JetstreamListener("wss://jetstream.example") as unknown as Private;
    await l.handleDelete(SRC, "did:plc:abc", "rkey1", 5_000);

    const updates = calls.filter((c) => c.sql.includes("SET deleted_at = now()"));
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.sql).not.toMatch(/source_id\s*=/);
      expect(u.sql).toContain("source_item_uri = $1");
      expect(u.params).toEqual(["at://did:plc:abc/app.bsky.feed.post/rkey1"]);
    }
    expect(updates[0]!.sql).toContain("external_items");
    expect(updates[1]!.sql).toContain("feed_items");
  });
});
