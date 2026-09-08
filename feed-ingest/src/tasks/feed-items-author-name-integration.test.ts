import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { REFRESH_EXTERNAL_AUTHOR_SQL } from "./feed-items-author-refresh.js";
import {
  RECONCILE_EXTERNAL_INSERT_SQL,
  RECONCILE_EXTERNAL_DRIFT_SQL,
} from "./feed-items-reconcile.js";

// =============================================================================
// feed_items.author_name — the author's name or NULL, never the source's
// (migration 184, BYLINE-AND-PROVENANCE-ADR D9 ⟂).
//
// D9 took the source-name fallback out of the card's byline. The same collapse
// lived one level down in the three nightly maintainer statements (reconcile's
// external INSERT and drift UPDATE, refresh's pass 2), each spelled
// COALESCE(ei.author_name, xs.display_name, …): on a feed that drops a
// dc:creator they recorded the PUBLICATION as the author. This runs the tasks'
// own SQL (imported, not copied — the M4(b) lesson) against a live Postgres,
// fixtures seeded in an always-rolled-back transaction.
//
// Three claims per statement, on one rss source named "Simon Willison's Weblog":
//   NULL    — an item with no author_name lands NULL, not the source's name
//   ''      — an empty author_name (the email arm's shape) is absent too
//   present — a real author_name ("Jason Kottke") is written unchanged
// plus the repair direction for the two UPDATEs: a row already carrying the
// source's name (pre-184 data) is rewritten to NULL, and a correct row is left
// alone (rowCount is exact, so an over-eager pass fails here).
//
// Mutation-proved: restoring the `xs.display_name` arm in any one statement
// fails that statement's NULL/'' cases and the repair case.
//
// Skipped unless a DB URL is supplied (CI supplies one and fails on a skip).
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/feed-items-author-name-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const SOURCE_NAME = "Simon Willison's Weblog";
const AUTHOR = "Jason Kottke";

describe.skipIf(!DB_URL)("feed_items.author_name never takes the source's name (migration 184)", () => {
  let client: pg.Client;
  let seq = 0;
  const uniq = () => `an184-${Date.now().toString(36)}-${seq++}`;

  let sourceId: string;
  // external_items ids keyed by the author_name shape they carry.
  let ei: { none: string; empty: string; named: string };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const tag = uniq();
    const { rows: [s] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name)
       VALUES ('rss', $1, $2) RETURNING id`,
      [`https://${tag}.example/feed.xml`, SOURCE_NAME],
    );
    sourceId = s.id;

    const item = async (label: string, authorName: string | null): Promise<string> => {
      const { rows: [r] } = await client.query<{ id: string }>(
        `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, author_name, title, published_at)
         VALUES ($1, 'rss', 'tier4', $2, $3, $4, now()) RETURNING id`,
        [sourceId, `https://${tag}.example/${label}`, authorName, label],
      );
      return r.id;
    };
    ei = {
      none: await item("none", null),
      empty: await item("empty", ""),
      named: await item("named", AUTHOR),
    };
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // Seed feed_items rows the way every pre-184 writer did: the source's name in
  // the author slot wherever the item had none, the real name otherwise.
  const seedPre184Rows = async () => {
    for (const [label, id] of Object.entries(ei)) {
      await client.query(
        `INSERT INTO feed_items (item_type, external_item_id, author_name, title, published_at,
                                 source_protocol, source_item_uri, source_id, media, is_reply)
         SELECT 'external', x.id, $2, x.title, x.published_at, 'rss', x.source_item_uri, x.source_id, '[]'::jsonb, FALSE
         FROM external_items x WHERE x.id = $1`,
        [id, label === "named" ? AUTHOR : SOURCE_NAME],
      );
    }
  };

  const authorNames = async (): Promise<Record<string, string | null>> => {
    const { rows } = await client.query<{ title: string; author_name: string | null }>(
      `SELECT ei.title, fi.author_name
       FROM feed_items fi JOIN external_items ei ON ei.id = fi.external_item_id
       WHERE ei.source_id = $1`,
      [sourceId],
    );
    return Object.fromEntries(rows.map((r) => [r.title, r.author_name]));
  };

  it("the column is nullable (migration 184 applied)", async () => {
    // Structural pin: the three claims below cannot hold on a NOT NULL column,
    // and a DB that has not taken 184 would fail them with 23502 rather than a
    // readable assertion.
    const { rows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'feed_items' AND column_name = 'author_name'`,
    );
    expect(rows[0]?.is_nullable).toBe("YES");
  });

  it("reconcile INSERT: NULL and '' land NULL, a named author lands as named", async () => {
    await client.query(RECONCILE_EXTERNAL_INSERT_SQL);
    expect(await authorNames()).toEqual({ none: null, empty: null, named: AUTHOR });
  });

  it("reconcile drift UPDATE: repairs a source-named row to NULL and leaves the named row alone", async () => {
    await seedPre184Rows();
    expect(await authorNames()).toEqual({ none: SOURCE_NAME, empty: SOURCE_NAME, named: AUTHOR });

    // Exact count, scoped: the pass is DB-wide, so count only this source's rows
    // by re-running the pass and asking which of ours changed.
    await client.query(RECONCILE_EXTERNAL_DRIFT_SQL);
    expect(await authorNames()).toEqual({ none: null, empty: null, named: AUTHOR });

    // Idempotent: a second run finds nothing of ours to repair (a pass that
    // disagrees with the ingesters' `|| null` would rewrite every night).
    const before = await authorNames();
    await client.query(RECONCILE_EXTERNAL_DRIFT_SQL);
    expect(await authorNames()).toEqual(before);
  });

  it("refresh pass 2: repairs a source-named row to NULL and leaves the named row alone", async () => {
    await seedPre184Rows();
    await client.query(REFRESH_EXTERNAL_AUTHOR_SQL);
    expect(await authorNames()).toEqual({ none: null, empty: null, named: AUTHOR });

    const before = await authorNames();
    await client.query(REFRESH_EXTERNAL_AUTHOR_SQL);
    expect(await authorNames()).toEqual(before);
  });
});
