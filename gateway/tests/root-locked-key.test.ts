import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { LOCKED_ROOT_ARTICLES_SQL } from "../src/lib/root-locked.js";

// =============================================================================
// GROUP ON root_post_id; JOIN ON target_event_id
// (ARTICLE-HEADED-CONVERSATIONS-ADR item 8, D5. The DB half of item 16.)
//
// WHAT ONLY POSTGRES KNOWS. `GET /author/:authorId/replies` computes each
// comment's root as `feed_items_derive_post_id('nostr', c.target_event_id)` —
// derived from the article's EVENT ID — while the article's real
// `feed_items.post_id` is minted from its naddr COORD
// (`'30023:' || pubkey || ':' || d_tag`). Two different strings for the same
// piece. The first groups a page's comments by root perfectly well and matches
// NO ROW anywhere, so a resolution built on it returns nothing.
//
// AND IT FAILS IN THE REASSURING DIRECTION. An empty join means no root is
// found paywalled, so every comment ships `rootLocked` absent and the log
// discloses a locked conversation as an open one — no error, no log line,
// nothing on any screen. That is the only reason this file exists.
//
// A MOCK CANNOT TEST IT. Told the two keys are the same string, a mocked
// `pool.query` passes against the bug; only Postgres evaluates
// `feed_items_derive_post_id` and the `feed_items_post_identity` trigger that
// mints the real one. The statement under test is IMPORTED, not retyped — a
// test that rewrites the join has already made the same choice the code did.
//
// A NOTE-ROOTED COMMENT RESOLVES EXACTLY, and that asymmetry is the third test
// here. The mint's note branch hashes the event id, which is what the log
// computes, so the two agree by construction — only the article branch
// diverges. Dev's comments all target articles, which is why the defect first
// read as total; a sample that happens to be all of one kind is not evidence
// about the other.
//
// Fixtures live inside a transaction that is ALWAYS rolled back. Skipped
// without a DB URL. Run locally, from gateway/:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/root-locked-key.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("the root's join key", () => {
  let client: pg.Client;
  let writer: string;
  let pubkey: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    pubkey = `fixture-rootkey-${process.hrtime.bigint().toString(16)}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, 'fixture-enc') RETURNING id`,
      [pubkey],
    );
    writer = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** A paywalled article plus the feed_items row whose post_id the trigger mints. */
  async function paywalledArticle(): Promise<{
    articleId: string;
    eventId: string;
    postId: string;
  }> {
    const tag = process.hrtime.bigint().toString(16);
    const eventId = `fixture-event-${tag}`;
    const a = await client.query<{ id: string }>(
      `INSERT INTO articles
         (writer_id, nostr_event_id, nostr_d_tag, title, slug,
          access_mode, price_pence)
       VALUES ($1, $2, $3, 'A piece behind a wall', $3, 'paywalled', 150)
       RETURNING id`,
      [writer, eventId, `fixture-dtag-${tag}`],
    );
    const fi = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, article_id, author_id, nostr_event_id,
                               published_at, source_protocol)
       VALUES ('article', $1, $2, $3, now(), 'nostr')
       RETURNING post_id`,
      [a.rows[0].id, writer, eventId],
    );
    return { articleId: a.rows[0].id, eventId, postId: fi.rows[0].post_id };
  }

  it("an ARTICLE's derived-from-event-id key is NOT its post_id", async () => {
    const { eventId, postId } = await paywalledArticle();
    const { rows } = await client.query<{ derived: string }>(
      `SELECT feed_items_derive_post_id('nostr', $1) AS derived`,
      [eventId],
    );
    // The fact the whole item turns on. If these are ever equal, the grouping
    // key would join and this file has nothing left to say — but they are not,
    // because the article's post_id goes through the naddr coord.
    expect(rows[0].derived).not.toBe(postId);
    expect(postId).toBeTruthy();
  });

  it("the real statement finds the article on target_event_id, and finds nothing on the derived key", async () => {
    const { articleId, eventId } = await paywalledArticle();

    // The shipped statement, imported.
    const right = await client.query(LOCKED_ROOT_ARTICLES_SQL, [[eventId]]);
    expect(right.rows.map((r: { id: string }) => r.id)).toEqual([articleId]);

    // The mistake, spelled out: resolve through the grouping key instead and
    // the same statement returns nothing at all — which the caller reads as
    // "no root is paywalled" and stamps a locked conversation as open.
    const { rows } = await client.query<{ derived: string }>(
      `SELECT feed_items_derive_post_id('nostr', $1) AS derived`,
      [eventId],
    );
    const wrong = await client.query(LOCKED_ROOT_ARTICLES_SQL, [
      [rows[0].derived],
    ]);
    expect(wrong.rows).toHaveLength(0);
  });

  it("a NOTE root's derived key DOES resolve — the asymmetry, stated", async () => {
    const tag = process.hrtime.bigint().toString(16);
    const noteEventId = `fixture-note-${tag}`;
    const n = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, published_at)
       VALUES ($1, $2, 'A note somebody replied to.', now()) RETURNING id`,
      [writer, noteEventId],
    );
    const fi = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, note_id, author_id, nostr_event_id,
                               published_at, source_protocol)
       VALUES ('note', $1, $2, $3, now(), 'nostr')
       RETURNING post_id`,
      [n.rows[0].id, writer, noteEventId],
    );
    const { rows } = await client.query<{ derived: string }>(
      `SELECT feed_items_derive_post_id('nostr', $1) AS derived`,
      [noteEventId],
    );
    // Equal, by construction: the mint's note branch hashes the event id and so
    // does the log. Only the article branch diverges — which is why the log's
    // unresolvable `inReplyTo` is half the log and not all of it (ADR §7), and
    // why the roots read above must never become an INNER join onto the
    // comments query: a note has no paywall, so it must simply be absent from
    // the map rather than delete its comments from the page.
    expect(rows[0].derived).toBe(fi.rows[0].post_id);

    // And the shipped statement finds nothing for it, which is correct.
    const res = await client.query(LOCKED_ROOT_ARTICLES_SQL, [[noteEventId]]);
    expect(res.rows).toHaveLength(0);
  });
});
