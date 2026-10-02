import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  conditionalHeadersFor,
  RSS_SOURCE_LOAD_SQL,
  RSS_WINDOW_RESEEN_SQL,
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
// Skipped unless a DB URL is supplied (CI supplies one and fails on a skip).
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

  // CA-C4. A source whose every item was first written by ANOTHER source held
  // nothing under the old `source_id` probe, so it sent no validators and
  // re-fetched in full on every poll. It holds what it SERVES.
  it("holds an item another source wrote first, once it has served it", async () => {
    const { rows: [other] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ('rss', $1) RETURNING id`,
      [`https://example.test/first-${seq}/feed.xml`],
    );
    const { rows: [it] } = await client.query<{ id: string }>(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, fetched_at)
       VALUES ($1,'rss','tier4',$2, now(), now()) RETURNING id`,
      [other.id, `https://example.test/shared-${seq}`],
    );
    expect(await holdsItems()).toBe(false);

    await client.query(
      `INSERT INTO external_item_sources (external_item_id, source_id) VALUES ($1, $2)`,
      [it.id, sourceId],
    );
    expect(await holdsItems()).toBe(true);
  });
});

// CA-G10b. A 304 means the origin still serves the window we last fetched, so
// that window is re-stamped SEEN — or a quiet feed's items are pruned at
// retention and re-inserted as new rows by the next full fetch. The window is
// found as the newest stamp among the source's own rows (the poll stamps a
// whole window with one transaction's now()). Stamps are literals here: inside
// the test's transaction now() never moves.
describe.skipIf(!DB_URL)("RSS_WINDOW_RESEEN_SQL — a 304 re-stamps the last window", () => {
  let client: pg.Client;
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
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  const source = async (): Promise<string> => {
    const { rows: [s] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri) VALUES ('rss', $1) RETURNING id`,
      [`https://example.test/g10b-${Date.now().toString(36)}-${seq++}/feed.xml`],
    );
    return s.id;
  };
  // The home membership is the trigger's; its stamp is set to the literal.
  const item = async (sourceId: string, label: string, seenDaysAgo: number): Promise<string> => {
    const { rows: [r] } = await client.query<{ id: string }>(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, fetched_at)
       VALUES ($1,'rss','tier4',$2, now() - interval '300 days', now()) RETURNING id`,
      [sourceId, `https://example.test/${sourceId}/${label}`],
    );
    await client.query(
      `UPDATE external_item_sources
          SET last_seen_at = date_trunc('second', now()) - make_interval(days => $2)
        WHERE external_item_id = $1`,
      [r.id, seenDaysAgo],
    );
    return r.id;
  };
  const reseen = async (sourceId: string): Promise<string[]> => {
    const { rows } = await client.query<{ source_item_uri: string }>(
      `SELECT ei.source_item_uri
         FROM external_item_sources m JOIN external_items ei ON ei.id = m.external_item_id
        WHERE m.source_id = $1 AND m.last_seen_at = now()`,
      [sourceId],
    );
    return rows.map((r) => r.source_item_uri.split("/").pop()!).sort();
  };

  it("re-stamps the rows of the newest window and nothing older", async () => {
    const src = await source();
    await item(src, "dropped-long-ago", 60);
    await item(src, "window-a", 30);
    await item(src, "window-b", 30);

    await client.query(RSS_WINDOW_RESEEN_SQL, [src]);

    expect(await reseen(src)).toEqual(["window-a", "window-b"]);
  });

  it("never touches another source's rows, however new", async () => {
    const src = await source();
    const other = await source();
    await item(src, "mine", 30);
    await item(other, "theirs", 1);

    await client.query(RSS_WINDOW_RESEEN_SQL, [src]);

    expect(await reseen(src)).toEqual(["mine"]);
    expect(await reseen(other)).toEqual([]);
  });

  // CA-C4. With the stamp on the ITEM, a window shared with another feed
  // carried whichever source stamped it last, so this source's newest stamp
  // could be the OTHER's — and its own window was missed. Per membership it is
  // exact: the shared item is re-stamped for this source alone.
  it("finds its own window exactly when an item of it is shared with a fresher source", async () => {
    const src = await source();
    const other = await source();
    const shared = await item(other, "shared", 1);
    await client.query(
      `INSERT INTO external_item_sources (external_item_id, source_id, last_seen_at)
       VALUES ($1, $2, date_trunc('second', now()) - interval '30 days')`,
      [shared, src],
    );
    await item(src, "mine", 30);

    await client.query(RSS_WINDOW_RESEEN_SQL, [src]);

    expect(await reseen(src)).toEqual(["mine", "shared"]);
    expect(await reseen(other)).toEqual([]);
  });

  it("is a no-op for a source that holds nothing", async () => {
    const src = await source();
    const { rowCount } = await client.query(RSS_WINDOW_RESEEN_SQL, [src]);
    expect(rowCount).toBe(0);
  });
});
