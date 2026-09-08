import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { nostrTargetPostId } from "../src/lib/post-mapper.js";

// =============================================================================
// READ THE post_id; DERIVE ONLY AS A FALLBACK
// (READING-LOG-AND-LIBRARY-ADR D7, applied to `nostrTargetPostId`.
//  ARTICLE-HEADED-CONVERSATIONS-ADR §7's residual, closed 2026-09-05.)
//
// THE QUESTION, asked in three places and now answered in one: given a native
// EVENT id that something points at, what post_id does it name? A note's
// post_id is derived from its event id, so falling through is right. An
// ARTICLE's is minted from its naddr coord, so falling through mints a
// plausible 64-hex string that matches no row.
//
// TWO DEFECTS, ONE EXPRESSION.
//
// 1. `GET /author/:authorId/replies` derived its `root_post_id` straight from
//    `c.target_event_id`, so every ARTICLE-rooted comment in a member's Replies
//    log carried an `inReplyTo` pointing at nothing. Nothing rendered wrong —
//    a collapsed card does not walk it and expansion refetches from the
//    projector, which uses the real id — which is exactly why it survived.
//
// 2. `nostrTargetPostId` itself RE-DERIVED the coord ('30023:' || pubkey || ':'
//    || dtag) rather than reading the stored post_id. That is the thing
//    `article_post_id`'s own comment forbids in as many words, and it is wrong
//    in precisely the case the mint's fallback exists for: an article whose
//    writer/d-tag the identity trigger could not see is minted
//    `('nostr_article', <article id>)`, and no amount of coord-rebuilding will
//    produce that string.
//
// WHY THE FIXTURE IS STRANGE, and it is the whole point of this file. On every
// ordinary row the old expression and the new one AGREE — 65 of 65 article
// rows in the dev DB — so a test over normal data passes against both and
// proves nothing. Test 3 therefore builds the row the fallback exists for, by
// inserting `feed_items` with an EXPLICIT post_id (the trigger mints only when
// post_id IS NULL, so a supplied value is preserved). There the two answers
// differ, and the test asserts BOTH: what the shipped expression returns, and
// what the old one would have. The mutation lives inside the test and cannot
// rot away from it.
//
// The expression under test is IMPORTED, not retyped.
//
// Fixtures live inside a transaction that is ALWAYS rolled back. Skipped
// without a DB URL. Run locally, from gateway/:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/root-post-id-resolution.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The shipped expression, over a single bound event id.
const RESOLVE_SQL = `SELECT ${nostrTargetPostId("$1")} AS post_id`;
// What it used to be: rebuild the coord and hash it, falling through to the
// raw event id. Kept verbatim so test 3 can show the two disagreeing.
const OLD_SQL = `SELECT feed_items_derive_post_id('nostr', COALESCE(
    (SELECT '30023:' || ac2.nostr_pubkey || ':' || art2.nostr_d_tag
       FROM articles art2 JOIN accounts ac2 ON ac2.id = art2.writer_id
      WHERE art2.nostr_event_id = $1
        AND ac2.nostr_pubkey IS NOT NULL AND art2.nostr_d_tag IS NOT NULL),
    $1)) AS post_id`;

describe.skipIf(!DB_URL)("resolving a native event id to its post_id", () => {
  let client: pg.Client;
  let writer: string;

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
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, 'fixture-enc') RETURNING id`,
      [`fixture-rootpid-${process.hrtime.bigint().toString(16)}`],
    );
    writer = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function article(explicitPostId?: string) {
    const tag = process.hrtime.bigint().toString(16);
    const eventId = `fixture-event-${tag}`;
    const a = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug)
       VALUES ($1, $2, $3, 'A piece', $3) RETURNING id`,
      [writer, eventId, `fixture-dtag-${tag}`],
    );
    const fi = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, article_id, author_id, nostr_event_id,
                               published_at, source_protocol, post_id)
       VALUES ('article', $1, $2, $3, now(), 'nostr', $4)
       RETURNING post_id`,
      [a.rows[0].id, writer, eventId, explicitPostId ?? null],
    );
    return { articleId: a.rows[0].id, eventId, postId: fi.rows[0].post_id };
  }

  const resolve = async (eventId: string) =>
    (await client.query<{ post_id: string }>(RESOLVE_SQL, [eventId])).rows[0].post_id;
  const resolveOld = async (eventId: string) =>
    (await client.query<{ post_id: string }>(OLD_SQL, [eventId])).rows[0].post_id;
  const deriveFromEventId = async (eventId: string) =>
    (
      await client.query<{ d: string }>(
        `SELECT feed_items_derive_post_id('nostr', $1) AS d`,
        [eventId],
      )
    ).rows[0].d;

  it("an ARTICLE event id resolves to the article's real post_id, not to a hash of itself", async () => {
    const { eventId, postId } = await article();
    // The residual, closed: this is what a Replies-log comment's inReplyTo now
    // carries, and it names a row that exists.
    expect(await resolve(eventId)).toBe(postId);
    // And what it used to carry, which named nothing.
    expect(await deriveFromEventId(eventId)).not.toBe(postId);
  });

  it("a NOTE event id still falls through to the derivation, which is correct there", async () => {
    const tag = process.hrtime.bigint().toString(16);
    const noteEventId = `fixture-note-${tag}`;
    const n = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, published_at)
       VALUES ($1, $2, 'A note.', now()) RETURNING id`,
      [writer, noteEventId],
    );
    const fi = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, note_id, author_id, nostr_event_id,
                               published_at, source_protocol)
       VALUES ('note', $1, $2, $3, now(), 'nostr') RETURNING post_id`,
      [n.rows[0].id, writer, noteEventId],
    );
    // No `articles` row for it, so the COALESCE falls through — and the
    // fall-through is the right answer, because the mint's note branch hashes
    // the event id too. Both halves asserted: it equals the real row, and it
    // equals the derivation.
    expect(await resolve(noteEventId)).toBe(fi.rows[0].post_id);
    expect(await resolve(noteEventId)).toBe(await deriveFromEventId(noteEventId));
  });

  it("READS the stored post_id where re-deriving the coord would invent one", async () => {
    // The row the mint's fallback exists for: an article whose post_id is NOT
    // the naddr hash. The trigger mints only into a NULL, so supplying one
    // reproduces a `('nostr_article', <id>)` row exactly.
    const stored = "d".repeat(64);
    const { eventId, postId } = await article(stored);
    expect(postId).toBe(stored); // the trigger preserved it

    // Shipped: reads it.
    expect(await resolve(eventId)).toBe(stored);
    // Old: rebuilds the coord and hashes it, inventing an id for a row that is
    // sitting right there with a different one. THIS is the assertion the two
    // expressions disagree on, and the only one they do.
    const old = await resolveOld(eventId);
    expect(old).not.toBe(stored);
    expect(old).toHaveLength(64); // plausible, which is why it was invisible
  });

  it("an event id belonging to nothing at all derives, rather than erroring", async () => {
    const orphan = `fixture-orphan-${process.hrtime.bigint().toString(16)}`;
    expect(await resolve(orphan)).toBe(await deriveFromEventId(orphan));
  });
});
