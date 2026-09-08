import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { CONTEXT_FEED_ITEM_INSERT_SQL } from "../src/lib/external-items-shared.js";
import { RECONCILE_EXTERNAL_INSERT_SQL } from "../../feed-ingest/src/tasks/feed-items-reconcile.js";

// =============================================================================
// §8.13 — an on-demand context row must get its feed_items twin immediately.
//
// The parent / quote / thread fetchers each write an `is_context_only` row to
// external_items so the tile can be drawn. That row is invisible in feeds by
// design — but `GET /thread/:postId` resolves an external focal through
// `feed_items WHERE post_id = $1`, and post_id is minted by the identity
// trigger ON feed_items. So a context row without its twin cannot be re-rooted
// onto: the reader clicks the tile they are looking at and gets a 404, until
// the nightly reconcile mints the row and it silently starts working.
//
// Only the quote fetcher had this; parent and thread did not. It is also the
// mechanism behind §8.13's "external_items grew by 71 while feed_items gained
// none" — which was filed as a dual-write divergence in the INGEST path and is
// not one: those four writers dual-write inside one transaction, and dev holds
// 0 orphans across 166,754 rows with ten days of exactly equal daily arrivals.
//
// Runs the module's own SQL against a live Postgres, inside a transaction that
// is ALWAYS rolled back. Skipped without a DB URL — CI supplies one (it boots
// Postgres and FAILS on a skip).
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** The SELECT list of an INSERT … SELECT, whitespace-flattened. */
function projection(sql: string): string {
  const body = sql.slice(sql.indexOf("SELECT"));
  return body
    .slice(0, body.indexOf("FROM external_items"))
    .replace(/\s+/g, " ")
    .trim();
}

describe("the context-row projection agrees with the reconcile pass", () => {
  it("is the same SELECT list, byte for byte once flattened", () => {
    // Not tidiness. `feed_items_reconcile` runs nightly over every external row
    // with no twin and REPAIRS it; if this helper wrote a different author_name
    // or avatar, reconcile would rewrite every row it touched, report the
    // rewrite as dual-write drift at WARN, and the fetcher would put the old
    // value straight back on the next request — a nightly alarm with no fault
    // behind it, which is the alarm an operator learns to ignore.
    expect(projection(CONTEXT_FEED_ITEM_INSERT_SQL)).toBe(
      projection(RECONCILE_EXTERNAL_INSERT_SQL),
    );
  });
});

describe.skipIf(!DB_URL)("ensureContextFeedItem's SQL", () => {
  let client: pg.Client;
  let sourceId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, avatar_url)
       VALUES ('atproto', $1, 'https://src.example/av.png') RETURNING id`,
      [`did:plc:ctxfixture${process.hrtime.bigint().toString(16)}`],
    );
    sourceId = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** A context-only external item with no feed_items twin — what a fetcher leaves. */
  async function contextItem(opts: { authorName: string | null }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, author_name, content_text,
          published_at, is_context_only)
       VALUES ($1, 'atproto', 'tier3', $2, $3, 'a parent post', now(), TRUE)
       RETURNING id`,
      [sourceId, `at://ctx/${process.hrtime.bigint().toString(16)}`, opts.authorName],
    );
    return rows[0].id;
  }

  it("mints the twin, and the twin carries a post_id the projector can resolve", async () => {
    const extId = await contextItem({ authorName: "Parent Author" });

    // The state the bug leaves behind: the row exists and is unreachable.
    const before = await client.query(
      `SELECT 1 FROM feed_items WHERE external_item_id = $1`,
      [extId],
    );
    expect(before.rowCount).toBe(0);

    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);

    const { rows } = await client.query<{
      post_id: string | null;
      author_name: string | null;
      author_avatar: string | null;
      item_type: string;
    }>(
      `SELECT post_id, author_name, author_avatar, item_type
         FROM feed_items WHERE external_item_id = $1`,
      [extId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].item_type).toBe("external");
    // post_id is the whole point: it is what /thread/:postId looks the focal up
    // by, and it is minted by the trigger on THIS table, not the other one.
    expect(rows[0].post_id).toBeTruthy();
    expect(rows[0].author_name).toBe("Parent Author");
    // The avatar's source fallback, kept because reconcile keeps it (ADR Q2).
    expect(rows[0].author_avatar).toBe("https://src.example/av.png");
  });

  it("is idempotent — every fetcher can call it on every request", async () => {
    const extId = await contextItem({ authorName: "Parent Author" });
    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);
    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);
    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);

    const { rows } = await client.query(
      `SELECT id FROM feed_items WHERE external_item_id = $1`,
      [extId],
    );
    expect(rows.length).toBe(1);
  });

  it("writes NULL rather than '' for a nameless author (migration 184)", async () => {
    // The byline's last resort is the FRONTEND's protocol label; the column
    // holds the item's own author or NULL, never a placeholder and never ''.
    const extId = await contextItem({ authorName: "" });
    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);

    const { rows } = await client.query<{ author_name: string | null }>(
      `SELECT author_name FROM feed_items WHERE external_item_id = $1`,
      [extId],
    );
    expect(rows[0].author_name).toBeNull();
  });

  it("leaves a soft-deleted context row alone", async () => {
    const extId = await contextItem({ authorName: "Gone" });
    await client.query(`UPDATE external_items SET deleted_at = now() WHERE id = $1`, [
      extId,
    ]);
    await client.query(CONTEXT_FEED_ITEM_INSERT_SQL, [extId]);

    const { rows } = await client.query(
      `SELECT id FROM feed_items WHERE external_item_id = $1`,
      [extId],
    );
    expect(rows.length).toBe(0);
  });
});
