import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { EXTERNAL_ITEMS_PRUNE_SQL } from "./external-items-prune.js";

// =============================================================================
// M15 — external_items_prune reference guards + the permanent wedge.
//
// The prune runs a bare DELETE (no passed client — it uses the pool directly),
// so there is no pure function to unit-test; the whole risk lives in the SQL's
// interaction with the schema's FK actions. This runs the REAL DELETE text
// against a live Postgres, fixtures seeded in an always-rolled-back transaction.
//
// Three claims, each with its negative control being the pre-M15 query (643fab3),
// pinned verbatim as BUGGY_DELETE:
//   1. WEDGE — citation_edges.source_external_item_id has NO on-delete action, so
//      deleting a cited item raises a RESTRICT (23503) violation that fails the
//      WHOLE daily batch — after which nothing is ever pruned again (unbounded
//      growth). The fix skips cited items. Control: BUGGY_DELETE throws 23503.
//   2. GUARDS — a cited item and a native reply's external parent
//      (notes.external_parent_id, ON DELETE SET NULL — deleting it silently
//      breaks the thread) must both survive the prune.
//   3. RETENTION/PRIVACY inversion — the old `deleted_at IS NULL` filter EXCLUDED
//      author-tombstoned items, retaining exactly the content a user deleted
//      forever. The fix drops that filter, so a tombstoned old item is pruned.
//
// Driven on the running dev stack before writing this: BUGGY threw 23503; FIXED
// deleted plain+tomb, spared cited+parent.
//
// Skipped unless a DB URL is supplied (CI's no-Postgres `test` job stays green).
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/external-items-prune-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The current (fixed) DELETE is imported, not copied, so this test breaks if the
// task's SQL regresses toward any of the three defects (the M4(b) lesson: a test
// that inlines a copy of production SQL proves the copy, not the code).
const FIXED_DELETE = EXTERNAL_ITEMS_PRUNE_SQL;

// The pre-M15 DELETE (643fab3), verbatim — the negative control. Its dead
// `WHERE FALSE` reply guard, its missing citation_edges guard, and its
// `deleted_at IS NULL` filter are the three defects M15 closed.
const BUGGY_DELETE = `
  DELETE FROM external_items ei
  WHERE ei.created_at < now() - ($1 || ' days')::interval
    AND ei.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM bookmarks b JOIN articles a ON a.nostr_event_id = b.article_id::text WHERE FALSE)
    AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.target_nostr_event_id = ei.id::text)
`;

describe.skipIf(!DB_URL)("external_items_prune — reference guards + wedge (M15)", () => {
  let client: pg.Client;
  let seq = 0;
  const uniq = () => `m15-${Date.now().toString(36)}-${seq++}`;

  // Fixture ids, rebuilt per test.
  let sourceId: string;
  let articleId: string;
  let ids: { plain: string; cited: string; parent: string; tomb: string };

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
    const { rows: [w] } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [tag.padEnd(64, "0")],
    );
    const { rows: [s] } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri) VALUES ('nostr_external', $1) RETURNING id`,
      [`src://${tag}`],
    );
    sourceId = s.id;
    const { rows: [a] } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [w.id, tag.padEnd(64, "0"), tag, "T", tag],
    );
    articleId = a.id;

    // Four items, all older than any retention window.
    const OLD = `now() - interval '200 days'`;
    const item = async (label: string): Promise<string> => {
      const { rows: [r] } = await client.query<{ id: string }>(
        `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, fetched_at, created_at)
         VALUES ($1,'nostr_external','tier2',$2, ${OLD}, ${OLD}, ${OLD}) RETURNING id`,
        [sourceId, `uri://${tag}/${label}`],
      );
      return r.id;
    };
    ids = {
      plain: await item("plain"), // no refs → prunable
      cited: await item("cited"), // citation_edges → spared
      parent: await item("parent"), // notes.external_parent_id → spared
      tomb: await item("tomb"), // deleted_at set → NOW prunable
    };

    await client.query(
      `INSERT INTO citation_edges (article_id, source_external_item_id, excerpt, excerpt_sha256, characterisation)
       VALUES ($1,$2,'x',repeat('a',64)::bytea,'supports')`,
      [articleId, ids.cited],
    );
    await client.query(
      `INSERT INTO notes (author_id, nostr_event_id, content, external_parent_id)
       VALUES ($1,$2,'reply',$3)`,
      [w.id, (tag + "n").padEnd(64, "0"), ids.parent],
    );
    await client.query(`UPDATE external_items SET deleted_at = now() WHERE id = $1`, [ids.tomb]);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // Run the batched FIXED delete to completion, like the task's loop — a single
  // LIMIT-ed call picks arbitrary rows and could miss the fixture's on a DB
  // with a large prunable backlog. Returns total rows deleted (DB-wide).
  const BATCH = 10_000;
  const runFixedToCompletion = async (): Promise<number> => {
    let total = 0;
    for (;;) {
      const { rowCount } = await client.query(FIXED_DELETE, ["90", BATCH]);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < BATCH) return total;
    }
  };

  const survivors = async (): Promise<string[]> => {
    const { rows } = await client.query<{ source_item_uri: string }>(
      `SELECT source_item_uri FROM external_items WHERE source_id = $1`,
      [sourceId],
    );
    // Return the trailing label (…/plain) sorted, for stable assertions.
    return rows.map((r) => r.source_item_uri.split("/").pop()!).sort();
  };

  it("FIXED: spares cited + native-reply-parent, prunes plain + tombstoned", async () => {
    const pruned = await runFixedToCompletion();
    // ≥, not an exact count (§0f-12): the DELETE has no source scoping, so on a
    // seasoned dev DB the total includes every unreferenced >90-day item DB-wide
    // (rolled back with the fixture). The per-fixture claim is `survivors()`.
    expect(pruned).toBeGreaterThanOrEqual(2);
    expect(await survivors()).toEqual(["cited", "parent"]);
  });

  it("CONTROL (the wedge): the pre-M15 query throws a RESTRICT FK violation on the cited item", async () => {
    // This is why nothing was ever pruned: one cited item in the whole retention
    // window fails the entire batch, every run, forever. If this stops throwing,
    // the schema's FK action changed and the guard rationale must be revisited.
    await expect(client.query(BUGGY_DELETE, ["90"])).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("CONTROL (privacy inversion): with the cited item removed, the pre-M15 query RETAINS the tombstoned item", async () => {
    // Isolate the deleted_at defect from the wedge: drop the citation so the old
    // query can run to completion, and show it keeps exactly the author-deleted
    // content (the inverted retention the fix corrects). Drop EVERY citation on
    // an in-window item, not just the fixture's — the unscoped BUGGY_DELETE
    // would otherwise 23503 on any pre-existing cited old item in a seasoned
    // dev DB (§0f-12; rolled back with the fixture).
    await client.query(
      `DELETE FROM citation_edges ce USING external_items ei
       WHERE ce.source_external_item_id = ei.id
         AND ei.created_at < now() - interval '90 days'`,
    );
    const { rowCount } = await client.query(BUGGY_DELETE, ["90"]);
    const after = await survivors();
    // Buggy keeps the tombstoned item; the fixed query (other test) prunes it.
    expect(after).toContain("tomb");
    // And it prunes cited too now (no guard) — confirming the delta is the
    // deleted_at filter, not some other difference.
    expect(after).not.toContain("cited");
    expect(rowCount).toBeGreaterThan(0);
  });

  it("a cited item whose citation is later removed becomes prunable (guard is live, not sticky)", async () => {
    await client.query(`DELETE FROM citation_edges WHERE source_external_item_id = $1`, [ids.cited]);
    await runFixedToCompletion();
    expect(await survivors()).toEqual(["parent"]); // cited now gone too
  });
});
