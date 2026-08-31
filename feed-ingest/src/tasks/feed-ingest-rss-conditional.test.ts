import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  conditionalHeadersFor,
  RSS_SOURCE_LOAD_SQL,
} from "./feed-ingest-rss.js";

// =============================================================================
// §8.16 — hold no items, send no validators.
//
// The bug: a validator is a claim about the ORIGIN's state, and we acted on it
// as though it were a claim about ours. external_items_prune deletes on our
// INSERT date, so a live-but-infrequent feed loses its whole window; the stored
// validator then makes every later fetch a CORRECT 304 and the source sits
// empty forever, subscribed and green. A live subscribed feed did exactly
// that for about a fortnight before anyone noticed.
//
// Two halves, and they need different kinds of test:
//
//   1. The DECISION (conditionalHeadersFor) is pure, so it is tested directly —
//      no mock, nothing to drift. The important case is the ETag one: measured
//      against the live origin, the stored ETag returned 304 while the stored
//      date returned 200, so a guard that dropped only `lastModified` would
//      have left the bug fully intact while looking fixed.
//
//   2. The PREMISE (`holds_items`) is a SQL predicate about our own data, and a
//      mocked pool.query would simply hand back whichever value the test
//      author already believed — pinning the belief, not the query. That is the
//      exact epistemic mistake §8.16 IS. So it runs against real Postgres, in a
//      rolled-back transaction, through the task's own exported SQL.
//
// Skipped unless a DB URL is supplied (CI's no-Postgres `test` job stays green).
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/feed-ingest-rss-conditional.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// A real cursor, read off a live subscribed source on 2026-08-13.
const LIVE_CURSOR = JSON.stringify({
  etag: 'W/"74f5c395cd1b87c9f079cc8813c01810"',
  lastModified: "Fri, 24 Apr 2026 20:43:16 GMT",
});

describe("conditionalHeadersFor — the §8.16 decision", () => {
  it("drops BOTH validators when the source holds no items", () => {
    const h = conditionalHeadersFor(LIVE_CURSOR, false);

    // The ETag is the one that mattered: it is what the origin honoured with a
    // 304 while the date alone would have produced a 200.
    expect(h.etag).toBeNull();
    expect(h.lastModified).toBeNull();
    expect(h.suppressed).toBe(true);
  });

  it("CONTROL: sends both when the source holds items", () => {
    const h = conditionalHeadersFor(LIVE_CURSOR, true);

    // Without this the guard could pass by never sending validators at all —
    // which would silently discard the bandwidth saving the cursor exists for.
    expect(h.etag).toBe('W/"74f5c395cd1b87c9f079cc8813c01810"');
    expect(h.lastModified).toBe("Fri, 24 Apr 2026 20:43:16 GMT");
    expect(h.suppressed).toBe(false);
  });

  it("an etag-only cursor is still suppressed (the prod-shaped case)", () => {
    // A guard written around `lastModified` would leave this one sending its
    // ETag and the loop would survive the fix untouched.
    const h = conditionalHeadersFor(JSON.stringify({ etag: '"abc"' }), false);
    expect(h.etag).toBeNull();
    expect(h.suppressed).toBe(true);
  });

  it("a date-only cursor is suppressed too", () => {
    const h = conditionalHeadersFor(
      JSON.stringify({ lastModified: "Fri, 24 Apr 2026 20:43:16 GMT" }),
      false,
    );
    expect(h.lastModified).toBeNull();
    expect(h.suppressed).toBe(true);
  });

  it("reports nothing suppressed when there was nothing to suppress", () => {
    // A brand-new source is empty and cursor-less; it must not be logged as a
    // §8.16 recovery every poll, or the log line stops meaning anything.
    for (const cursor of [null, "", "{}", "not json at all"]) {
      const h = conditionalHeadersFor(cursor, false);
      expect(h.suppressed).toBe(false);
      expect(h.etag).toBeNull();
      expect(h.lastModified).toBeNull();
    }
  });

  it("survives a corrupt cursor without throwing", () => {
    const h = conditionalHeadersFor("{ndjson-ish", true);
    expect(h).toEqual({ etag: null, lastModified: null, suppressed: false });
  });
});

describe.skipIf(!DB_URL)("RSS_SOURCE_LOAD_SQL — the holds_items premise", () => {
  let client: pg.Client;
  let sourceId: string;
  let seq = 0;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const tag = `s816-${Date.now().toString(36)}-${seq++}`;
    const { rows: [s] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, cursor)
       VALUES ('rss', $1, $2) RETURNING id`,
      [`https://example.test/${tag}/feed.xml`, LIVE_CURSOR],
    );
    sourceId = s.id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  const holdsItems = async (): Promise<boolean> => {
    const { rows } = await client.query<{ holds_items: boolean }>(
      RSS_SOURCE_LOAD_SQL,
      [sourceId],
    );
    return rows[0].holds_items;
  };

  it("is false for a source with a cursor and no items — the live case", async () => {
    expect(await holdsItems()).toBe(false);

    // End to end: that premise, through the real decision, drops the ETag.
    const { rows: [row] } = await client.query<{ cursor: string }>(
      `SELECT cursor FROM external_sources WHERE id = $1`,
      [sourceId],
    );
    expect(conditionalHeadersFor(row.cursor, await holdsItems())).toEqual({
      etag: null,
      lastModified: null,
      suppressed: true,
    });
  });

  it("flips to true as soon as one item exists, so the guard self-heals", async () => {
    await client.query(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, fetched_at)
       VALUES ($1,'rss','tier4',$2, now(), now())`,
      [sourceId, `https://example.test/item-${seq}`],
    );

    expect(await holdsItems()).toBe(true);
    // …and the very next poll resumes conditional GETs by itself.
    expect(conditionalHeadersFor(LIVE_CURSOR, true).suppressed).toBe(false);
  });

  it("counts only THIS source's items, never another's", async () => {
    // The failure this rules out is a predicate that lost its correlation and
    // reads true whenever the table is non-empty — which on a populated
    // database is indistinguishable from a correct one, and would make the
    // whole guard dead code exactly where it is needed.
    const { rows: [other] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ('rss', $1) RETURNING id`,
      [`https://example.test/other-${seq}/feed.xml`],
    );
    await client.query(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, fetched_at)
       VALUES ($1,'rss','tier4',$2, now(), now())`,
      [other.id, `https://example.test/other-item-${seq}`],
    );

    expect(await holdsItems()).toBe(false);
  });
});
