import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  sourceBlockedSql,
  npubBlockedSql,
  isSourceBlocked,
  isSourceUriBlocked,
} from "@platform-pub/shared/lib/platform-blocks.js";

// =============================================================================
// A blocked source produces no external_items row (L6.5; D1 §9.6, D7 §5/§7)
//
// D7 §7 says source blocking "is applied on the same judgement tests where
// content would fail them", and until migration 224 there was no mechanism for
// it at all — `blocks` and `mutes` are rows a MEMBER writes about a MEMBER, and
// `feed_sources.muted_at` is one feed owner's preference on their own feed.
//
// WHY THIS IS DB-BACKED AND NOT MOCKED. Every part of the guard is SQL that
// only Postgres evaluates: the composite match on (protocol, source_uri) with
// `protocol` cast from text to an enum, the unique index that makes a block
// idempotent, and the `NOT EXISTS` the poll selector and the Jetstream DID set
// both splice in. A mocked `pool.query` told the predicate matches would agree
// with a predicate that matches nothing.
//
// THE TWO FAILURE DIRECTIONS ARE BOTH SILENT, which is why the negative
// controls carry the same weight as the positives. A block that matches nothing
// looks exactly like a source that has gone quiet; a block that matches too
// much silently stops carrying a source nobody objected to. So every test here
// asserts what was blocked AND what was not.
//
// Fixtures live inside a transaction that is ALWAYS rolled back. Skipped
// without a DB URL, and CI attaches one and fails on a skip. Run locally, from
// feed-ingest/:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/platform-block-ingest-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** The poll selector's own predicate, as it splices it. */
const POLL_SELECT = `
  SELECT id FROM external_sources es
   WHERE is_active = TRUE
     AND NOT ${sourceBlockedSql("es")}
     AND id = ANY($1::uuid[])
`;

describe.skipIf(!DB_URL)("a blocked source is not ingested", () => {
  let client: pg.Client;
  let blockedId: string;
  let cleanId: string;
  let tag: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    tag = process.hrtime.bigint().toString(16);
    const mk = async (uri: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO external_sources (protocol, source_uri, is_active)
         VALUES ('rss', $1, TRUE) RETURNING id`,
        [uri],
      );
      return rows[0].id;
    };
    blockedId = await mk(`https://blocked-${tag}.example.com/feed.xml`);
    cleanId = await mk(`https://clean-${tag}.example.com/feed.xml`);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function block(uri: string, protocol = "rss") {
    await client.query(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
       VALUES ('source', $2::external_protocol, $1, 'test')`,
      [uri, protocol],
    );
  }

  it("drops the blocked source out of the poll selection and leaves the other", async () => {
    const uri = `https://blocked-${tag}.example.com/feed.xml`;
    await block(uri);

    const { rows } = await client.query<{ id: string }>(POLL_SELECT, [
      [blockedId, cleanId],
    ]);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(blockedId);
    // THE NEGATIVE CONTROL. A predicate that matched everything would also
    // pass the assertion above.
    expect(ids).toContain(cleanId);
  });

  it("refuses the blocked source at the per-task guard, and only that one", async () => {
    await block(`https://blocked-${tag}.example.com/feed.xml`);
    // The guard every fetch task runs before spending an HTTP request. `client`
    // is passed in so it reads the uncommitted fixture rather than the pool's
    // own view of a row that does not exist outside this transaction.
    expect(await isSourceBlocked(blockedId, client as never)).toBe(true);
    expect(await isSourceBlocked(cleanId, client as never)).toBe(false);
  });

  it("answers FALSE for a source id that names no row", async () => {
    // "Not blocked" is the honest answer about a source that does not exist —
    // every caller loads the row separately and has its own handling for a
    // missing one. A guard that answered TRUE here would silently stop every
    // job whose source had just been garbage-collected.
    expect(
      await isSourceBlocked("00000000-0000-4000-8000-000000000000", client as never),
    ).toBe(false);
  });

  it("matches on the PAIR, so the same handle on another network is untouched", async () => {
    // The block is (protocol, source_uri). Matching the uri alone would block
    // one identity everywhere at once — and for atproto and nostr, where the
    // uri is a DID or a pubkey, that is a different person's identifier on a
    // different network.
    const uri = `did:plc:block${tag}`;
    const { rows: atp } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('atproto', $1, TRUE) RETURNING id`,
      [uri],
    );
    const { rows: ap } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('activitypub', $1, TRUE) RETURNING id`,
      [uri],
    );
    await block(uri, "atproto");

    expect(await isSourceBlocked(atp[0].id, client as never)).toBe(true);
    expect(await isSourceBlocked(ap[0].id, client as never)).toBe(false);
  });

  it("is answerable BEFORE the source row exists — the add path", async () => {
    // `addSource` asks after canonicalisation and before any write, because a
    // blocked source that can still be added mints a subscription and a feed
    // slot that will never fill.
    const uri = `https://blocked-${tag}.example.com/feed.xml`;
    await block(uri);
    expect(await isSourceUriBlocked("rss", uri, client as never)).toBe(true);
    expect(
      await isSourceUriBlocked("rss", `https://clean-${tag}.example.com/feed.xml`, client as never),
    ).toBe(false);
    // The protocol is part of the question here too.
    expect(await isSourceUriBlocked("atproto", uri, client as never)).toBe(false);
  });

  it("is idempotent — the same refusal written twice is one row", async () => {
    const uri = `https://blocked-${tag}.example.com/feed.xml`;
    await block(uri);
    await client.query(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
       VALUES ('source', 'rss', $1, 'again')
       ON CONFLICT (kind, protocol, target_key) DO UPDATE SET reason = EXCLUDED.reason`,
      [uri],
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM platform_blocks WHERE target_key = $1`,
      [uri],
    );
    expect(rows[0].n).toBe("1");
  });
});

describe.skipIf(!DB_URL)("a blocked npub is not delivered", () => {
  let client: pg.Client;

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

  it("matches a hex pubkey and nothing else", async () => {
    const hex = "a".repeat(64);
    const other = "b".repeat(64);
    await client.query(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
       VALUES ('npub', 'nostr_external', $1, 'test')`,
      [hex],
    );
    const { rows } = await client.query<{ blocked: boolean; clean: boolean; missing: boolean }>(
      `SELECT ${npubBlockedSql("$1")} AS blocked,
              ${npubBlockedSql("$2")} AS clean,
              ${npubBlockedSql("NULL")} AS missing`,
      [hex, other],
    );
    expect(rows[0].blocked).toBe(true);
    expect(rows[0].clean).toBe(false);
    // A post with no author row compares against NULL, which must keep the
    // item rather than dropping it — the feed arm LEFT JOINs `external_authors`
    // and most tier-C/D rows have none.
    expect(rows[0].missing).toBe(false);
  });

  it("refuses an npub block on any protocol but nostr", async () => {
    // The CHECK is the wall: an npub is a nostr identity or it is not an npub,
    // and a row that said otherwise would make the predicate above — which does
    // not filter on protocol — mean something different.
    await expect(
      client.query(
        `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
         VALUES ('npub', 'rss', $1, 'test')`,
        ["c".repeat(64)],
      ),
    ).rejects.toThrow();
  });

  it("requires a reason, in the schema", async () => {
    // The operator act leaves evidence, and a CHECK is what makes that true of
    // every writer rather than of the one route we happened to build.
    await expect(
      client.query(
        `INSERT INTO platform_blocks (kind, protocol, target_key, reason)
         VALUES ('npub', 'nostr_external', $1, '   ')`,
        ["d".repeat(64)],
      ),
    ).rejects.toThrow();
  });
});
