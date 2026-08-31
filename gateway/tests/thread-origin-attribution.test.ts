import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { FEED_SELECT, FEED_JOINS } from "../src/lib/feed-sql.js";
import { POST_SELECT, POST_JOINS, feedItemToPost } from "../src/lib/post-mapper.js";

// =============================================================================
// The expanded card's parents/children must not be tagged with the EXPANDED
// author's source name (UNIVERSAL-POST-ADR §4 origin tag).
//
// A thread parent/child is minted by hydration and anchored on the HYDRATING
// FOCAL's source (EXTERNAL-AUTHOR-HISTORY-ADR §4.2), so xs.display_name names
// the account whose card was expanded, not the post's author — and the origin
// tag rendered it in the provenance slot between the network name and the
// (correct) handle: "VIA FEDIVERSE · Kaito · oli", where Kaito never wrote it.
//
// This is DB-backed on purpose. The defect lives in the JOIN — the mapper was
// faithfully reporting a column whose value belongs to a different row's author
// — so a mocked pool.query pinning a hand-written `source_display_name` would
// pass against the bug and against the fix alike. Driving the real
// FEED_SELECT/FEED_JOINS is what makes the source_id inheritance visible.
//
// Mutation check: drop the `row.ei_is_context_only ?` guard in post-mapper.ts
// and the context arm fails with sourceName "Kaito's Feed".
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/thread-origin-attribution.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const NODE_SQL = `SELECT ${FEED_SELECT}${POST_SELECT}
   FROM feed_items fi
   ${FEED_JOINS}
   ${POST_JOINS}
  WHERE fi.id = $1`;

describe.skipIf(!DB_URL)("thread node origin attribution", () => {
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

  let seq = 0;

  // One subscribed source ("Kaito"), two items hanging off it: the source's own
  // ingested post, and a reply by SOMEONE ELSE that thread hydration parked on
  // the same source_id. That inheritance is the whole bug.
  async function insertItem(opts: {
    sourceId: string;
    authorName: string;
    authorHandle: string;
    contextOnly: boolean;
  }): Promise<string> {
    seq++;
    const uri = `https://famichiki.jp/users/x/statuses/${seq}`;
    const ins = await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri,
         author_name, author_handle, author_uri,
         content_text, published_at, is_context_only
       ) VALUES ($1, 'activitypub', 'tier3', $2, $3, $4, $5, 'body', now(), $6)
       RETURNING id`,
      [
        opts.sourceId,
        uri,
        opts.authorName,
        opts.authorHandle,
        `https://famichiki.jp/users/${opts.authorHandle}`,
        opts.contextOnly,
      ],
    );
    const fi = await client.query(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, $2, 'body', now(), 'activitypub', $3, $4,
                 '[]'::jsonb, $5)
       RETURNING id`,
      [ins.rows[0].id, opts.authorName, uri, opts.sourceId, opts.contextOnly],
    );
    return fi.rows[0].id;
  }

  async function projectPost(feedItemId: string) {
    const { rows } = await client.query(NODE_SQL, [feedItemId]);
    expect(rows).toHaveLength(1);
    return feedItemToPost(rows[0]);
  }

  it("a hydrated thread node carries no source name; the source's own post keeps it", async () => {
    seq++;
    const { rows: src } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
       VALUES ('activitypub', $1, 'Kaito''s Feed', TRUE) RETURNING id`,
      [`https://ajin.la/users/kai-${seq}`],
    );
    const sourceId = src[0].id;

    const ownId = await insertItem({
      sourceId,
      authorName: "Kaito",
      authorHandle: "kai",
      contextOnly: false,
    });
    const parentId = await insertItem({
      sourceId,
      authorName: "David R Munson",
      authorHandle: "somewhereinjp",
      contextOnly: true,
    });

    const own = await projectPost(ownId);
    const parent = await projectPost(parentId);

    // Control: the row whose source_id is genuinely its own still names it.
    expect(own.origin.sourceName).toBe("Kaito's Feed");

    // The fix: the inherited source_id yields no provenance claim at all —
    // and specifically never the expanded author's name.
    expect(parent.origin.sourceName).toBeNull();
    expect(parent.author.displayName).toBe("David R Munson");
    expect(parent.author.handle).toBe("somewhereinjp");
  });
});
