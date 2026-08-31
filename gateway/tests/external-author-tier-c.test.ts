import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";

// =============================================================================
// BYLINE-AND-PROVENANCE-ADR D3/D4/D5/D6 (S3, migration 183) — the source-scoped
// tier-C author mint, against a live Postgres. The mint is a TRIGGER
// (feed_items_post_identity), so only Postgres can evaluate it: a mocked
// pool.query would pin the mock's idea of a mint and pass green against a
// migration that never ran.
//
// Two regimes:
//
//   "mint"      — client-threaded fixtures in a transaction that is ALWAYS
//                 rolled back; the target DB is never mutated.
//   "resolver"  — the known-world projection (D6 ⟂⟂) runs on the SHARED pool
//                 through the real `resolve()`, which cannot see an uncommitted
//                 fixture, so that half COMMITS one rss source and cleans up in
//                 afterAll (external_items / feed_items / external_authors all
//                 CASCADE from external_sources — which is itself D6's cascade
//                 under test).
//
// Mutation-proved: with the trigger's tier-C arm removed (migration 105's body)
// the "mint" cases fail; with the resolver's CASE projection removed, the
// resolver case fails on `<uuid>#` leaking into sourceUri.
//
// Run locally (BOTH env vars — the resolver half reads the shared pool):
//   export DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub
//   TEST_DATABASE_URL="$DATABASE_URL" npx vitest run tests/external-author-tier-c.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

interface Q {
  query: pg.PoolClient["query"];
}

let uriSeq = 0;
async function createRssSource(
  q: Q,
  opts: { displayName?: string; active?: boolean } = {},
): Promise<string> {
  uriSeq++;
  const { rows } = await q.query(
    `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
     VALUES ('rss', $1, $2, $3) RETURNING id`,
    [
      `https://tierc-test.invalid/${process.pid}-${uriSeq}/feed.xml`,
      opts.displayName ?? `Tier-C Test Paper ${uriSeq}`,
      opts.active ?? true,
    ],
  );
  return rows[0].id;
}

// One rss item + its feed_items row; returns what the trigger stamped.
async function insertRssItem(
  q: Q,
  opts: { sourceId: string; authorName: string | null; publishedMinutesAgo?: number },
): Promise<{
  feedItemId: string;
  externalItemId: string;
  externalAuthorId: string | null;
  biddabilityTier: string;
}> {
  uriSeq++;
  const uri = `https://tierc-test.invalid/item/${process.pid}-${uriSeq}`;
  const ei = await q.query(
    `INSERT INTO external_items (
       source_id, protocol, tier, source_item_uri, author_name,
       content_text, published_at, interaction_data
     ) VALUES ($1, 'rss', 'tier4', $2, $3, 'body',
               now() - ($4 || ' minutes')::interval, '{}'::jsonb)
     RETURNING id`,
    [opts.sourceId, uri, opts.authorName, String(opts.publishedMinutesAgo ?? uriSeq)],
  );
  const fi = await q.query(
    `INSERT INTO feed_items (
       item_type, external_item_id, author_name, content_preview,
       published_at, source_protocol, source_item_uri, source_id, media, is_reply
     ) VALUES ('external', $1, $2, 'body',
               now() - ($4 || ' minutes')::interval, 'rss', $3, $5, '[]'::jsonb, FALSE)
     RETURNING id, external_author_id, biddability_tier`,
    [ei.rows[0].id, opts.authorName ?? "", uri, String(opts.publishedMinutesAgo ?? uriSeq), opts.sourceId],
  );
  return {
    feedItemId: fi.rows[0].id,
    externalItemId: ei.rows[0].id,
    externalAuthorId: fi.rows[0].external_author_id,
    biddabilityTier: fi.rows[0].biddability_tier,
  };
}

async function loadAuthor(q: Q, id: string) {
  const { rows } = await q.query(
    `SELECT protocol::text AS protocol, stable_handle, tier, display_name, source_id
       FROM external_authors WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe.skipIf(!DB_URL)("tier-C author mint (migration 183)", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("mints a source-scoped tier-C record for an rss byline and stamps the row", async () => {
    const sourceId = await createRssSource(client);
    const row = await insertRssItem(client, { sourceId, authorName: "Aditya Chakrabortty" });
    expect(row.externalAuthorId).not.toBeNull();
    const xa = await loadAuthor(client, row.externalAuthorId!);
    expect(xa).toMatchObject({
      protocol: "rss",
      tier: "C",
      stable_handle: `${sourceId}#aditya chakrabortty`,
      display_name: "Aditya Chakrabortty",
      source_id: sourceId,
    });
  });

  it("D5 — the biddability ladder does not move: a bylined rss row stays tier D", async () => {
    const sourceId = await createRssSource(client);
    const row = await insertRssItem(client, { sourceId, authorName: "Aditya Chakrabortty" });
    expect(row.externalAuthorId).not.toBeNull();
    expect(row.biddabilityTier).toBe("D");
  });

  it("does not mint for a null or blank author name (the email adapter's \"\")", async () => {
    const sourceId = await createRssSource(client);
    const nullName = await insertRssItem(client, { sourceId, authorName: null });
    const blank = await insertRssItem(client, { sourceId, authorName: "   " });
    expect(nullName.externalAuthorId).toBeNull();
    expect(blank.externalAuthorId).toBeNull();
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM external_authors WHERE source_id = $1`,
      [sourceId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("D4 — casefold + whitespace collapse and NOTHING else; first spelling seen is the display name", async () => {
    const sourceId = await createRssSource(client);
    const a = await insertRssItem(client, { sourceId, authorName: "Kiran  Stacey", publishedMinutesAgo: 10 });
    const b = await insertRssItem(client, { sourceId, authorName: " kiran stacey ", publishedMinutesAgo: 5 });
    // A job title is part of the name: a different person as far as the key knows.
    const c = await insertRssItem(client, { sourceId, authorName: "Kiran Stacey Policy editor" });
    expect(a.externalAuthorId).toBe(b.externalAuthorId);
    expect(c.externalAuthorId).not.toBe(a.externalAuthorId);
    const xa = await loadAuthor(client, a.externalAuthorId!);
    expect(xa.stable_handle).toBe(`${sourceId}#kiran stacey`);
    expect(xa.display_name).toBe("Kiran  Stacey");
  });

  it("D4 — the same name in two sources is two records: the key claims no person", async () => {
    const guardian = await createRssSource(client);
    const kottke = await createRssSource(client);
    const a = await insertRssItem(client, { sourceId: guardian, authorName: "Guardian staff" });
    const b = await insertRssItem(client, { sourceId: kottke, authorName: "Guardian staff" });
    expect(a.externalAuthorId).not.toBe(b.externalAuthorId);
    expect((await loadAuthor(client, a.externalAuthorId!)).source_id).toBe(guardian);
    expect((await loadAuthor(client, b.externalAuthorId!)).source_id).toBe(kottke);
  });

  it("the rss arm is INSERT-only: a tier-D row later given a name does not mint on UPDATE", async () => {
    const sourceId = await createRssSource(client);
    const row = await insertRssItem(client, { sourceId, authorName: null });
    expect(row.externalAuthorId).toBeNull();
    await client.query(`UPDATE external_items SET author_name = 'Late Byline' WHERE id = $1`, [
      row.externalItemId,
    ]);
    // The hot-path UPDATE shape (feed_scores_refresh touches score only).
    await client.query(`UPDATE feed_items SET score = 1 WHERE id = $1`, [row.feedItemId]);
    const { rows } = await client.query(
      `SELECT external_author_id FROM feed_items WHERE id = $1`,
      [row.feedItemId],
    );
    expect(rows[0].external_author_id).toBeNull();
  });

  it("the A/B arm is untouched: a nostr row mints tier A with NO source_id", async () => {
    const { rows: src } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('nostr_external', $1, TRUE) RETURNING id`,
      ["f".repeat(63) + "1"],
    );
    uriSeq++;
    const uri = `nevent1tierctest${uriSeq}`;
    const ei = await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, author_name,
         content_text, published_at, interaction_data
       ) VALUES ($1, 'nostr_external', 'tier2', $2, 'Nostr Author', 'body', now(), $3)
       RETURNING id`,
      [src[0].id, uri, JSON.stringify({ id: "e".repeat(64), pubkey: "a".repeat(64), relays: [] })],
    );
    const fi = await client.query(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, 'Nostr Author', 'body', now(), 'nostr_external', $2, $3, '[]'::jsonb, FALSE)
       RETURNING external_author_id`,
      [ei.rows[0].id, uri, src[0].id],
    );
    const xa = await loadAuthor(client, fi.rows[0].external_author_id);
    expect(xa).toMatchObject({ tier: "A", stable_handle: "a".repeat(64), source_id: null });
  });

  it("D6 — deleting the source takes its tier-C authors with it (and RI holds)", async () => {
    const sourceId = await createRssSource(client);
    const row = await insertRssItem(client, { sourceId, authorName: "Aditya Chakrabortty" });
    await client.query(`DELETE FROM external_sources WHERE id = $1`, [sourceId]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM external_authors WHERE id = $1`,
      [row.externalAuthorId],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe.skipIf(!DB_URL)("tier-C author in the resolver's known-world index (D6 ⟂⟂)", () => {
  // Names chosen to be unique across any real dataset so the trigram search
  // returns only this fixture.
  const PAPER = "Zqxjv Tiercee Gazette";
  const JOURNALIST = "Ormondine Zqxjv Plackett";
  let pool: pg.Pool;
  let sourceId: string;
  let sourceUri: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
    const client = await pool.connect();
    try {
      // A fixture an interrupted earlier run left behind would collide on
      // the unique display-name search below; sweep it first.
      await client.query(`DELETE FROM external_sources WHERE display_name = $1`, [PAPER]);
      sourceId = await createRssSource(client, { displayName: PAPER });
      const { rows } = await client.query(`SELECT source_uri FROM external_sources WHERE id = $1`, [sourceId]);
      sourceUri = rows[0].source_uri;
      const row = await insertRssItem(client, { sourceId, authorName: JOURNALIST });
      expect(row.externalAuthorId).not.toBeNull();
    } finally {
      client.release();
    }
  });
  afterAll(async () => {
    // external_items / feed_items / external_authors all cascade from here.
    await pool.query(`DELETE FROM external_sources WHERE id = $1`, [sourceId]);
    await pool.end();
  });

  it("projects a journalist's name onto their paper, never leaking the <uuid># key into sourceUri", async () => {
    const { resolve } = await import("../src/lib/resolver.js");
    const result = await resolve(JOURNALIST, "subscribe");
    const external = result.matches.filter((m) => m.type === "external_source");
    expect(external.length).toBeGreaterThan(0);
    for (const m of external) {
      expect(m.externalSource?.sourceUri).not.toContain("#");
    }
    const hit = external.find((m) => m.externalSource?.sourceUri === sourceUri);
    expect(hit).toBeDefined();
    expect(hit!.externalSource).toMatchObject({ protocol: "rss", displayName: PAPER });
  });

  it("typing the paper's own name still yields exactly one hit for it (twin-dedupe)", async () => {
    const { resolve } = await import("../src/lib/resolver.js");
    const result = await resolve(PAPER, "subscribe");
    const hits = result.matches.filter(
      (m) => m.type === "external_source" && m.externalSource?.sourceUri === sourceUri,
    );
    expect(hits).toHaveLength(1);
  });
});
