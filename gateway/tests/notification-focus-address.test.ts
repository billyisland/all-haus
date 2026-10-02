import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

// =============================================================================
// A NOTIFICATION'S FOCUS IS THE ADDRESS THE CARD ALREADY HAS.
//
// `GET /notifications` now sends, for a row that is about something the actor
// WROTE, the `post_id` of that note or comment — so the profile pane it opens
// can open ON the conversation rather than at the person's front door. The
// whole feature turns on that id being the SAME id the profile's own log uses
// for the same post; a plausible-looking 64-hex string that names no card is
// the failure this file exists for, and it is silent: the pane opens, the
// thread fetch returns nothing, and the profile simply looks empty at the top.
//
// TWO CLAIMS, TESTED TWO WAYS, because they fail differently.
//
//   1. For a NOTE, the derivation agrees with the stored `feed_items.post_id`
//      — the id `feedItemToPost` puts on the card. DB-backed, because only
//      Postgres can evaluate `feed_items_derive_post_id`. (It also agrees on
//      all 88 notes in the dev database, checked before the column was added;
//      this builds the row rather than trusting that.)
//
//   2. For a COMMENT, there is no stored row to compare against — kind-1111
//      comments are not `feed_items` — so the id is only right if it is the
//      same EXPRESSION the two surfaces that project comments already use
//      (`GET /author/:id/replies` and the thread projector). That is a text
//      pin over the three sources, the same shape as `href-guard.test.ts`:
//      three copies of one expression is the thing to watch, and the test is
//      what notices when one of them moves.
//
// Fixtures live in a transaction that is ALWAYS rolled back. Skipped without a
// DB URL — and CI attaches one and fails on skips. Run locally, from gateway/:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/notification-focus-address.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** The expression the notifications route derives a focus address with. */
const DERIVE = "feed_items_derive_post_id('nostr', $1)";

describe.skipIf(!DB_URL)("a note's focus address is its card's post_id", () => {
  let client: pg.Client;
  let author: string;

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
      [`fixture-focus-${process.hrtime.bigint().toString(16)}`],
    );
    author = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("agrees with the post_id the feed_items trigger minted", async () => {
    const eventId = `fixture-note-${process.hrtime.bigint().toString(16)}`;
    const { rows: note } = await client.query<{ id: string }>(
      `INSERT INTO notes (author_id, nostr_event_id, content, published_at)
       VALUES ($1, $2, 'a note', now()) RETURNING id`,
      [author, eventId],
    );
    // `exactly_one_source` — a feed_item names an article, a note or an
    // external item, and exactly one of the three.
    const { rows: fi } = await client.query<{ post_id: string }>(
      `INSERT INTO feed_items (item_type, note_id, author_id, nostr_event_id,
                               published_at, source_protocol)
       VALUES ('note', $1, $2, $3, now(), 'nostr')
       RETURNING post_id`,
      [note[0].id, author, eventId],
    );
    const { rows: derived } = await client.query<{ post_id: string }>(
      `SELECT ${DERIVE} AS post_id`,
      [eventId],
    );

    expect(derived[0].post_id).toBe(fi[0].post_id);
    // Not a tautology dressed as an assertion: a null on either side would
    // satisfy an equality test and prove nothing.
    expect(fi[0].post_id).toBeTruthy();
  });
});

describe("one expression, three sources", () => {
  // A STRUCTURAL PIN, not a behavioural one, and it says so: no test here can
  // evaluate the SQL, so what is asserted is that the three surfaces spell the
  // comment address the same way. It is written against `c.nostr_event_id`
  // ALONE for a reason — a first version accepted `(?:c|no)\.` and passed
  // happily against a mutation that derived the comment arm from the
  // notification's own id, because the NOTE arm still matched the pattern
  // somewhere else in the file. A pin that can be satisfied by a line other
  // than the one under test is not a pin.
  const SOURCES = [
    "src/routes/notifications.ts",
    "src/routes/author.ts",
    "src/routes/post-thread.ts",
  ];
  const COMMENT_EXPR = /feed_items_derive_post_id\('nostr',\s*c\.nostr_event_id\)/;

  it.each(SOURCES)("%s derives a comment's post_id the one way", (rel) => {
    const source = readFileSync(path.resolve(__dirname, "..", rel), "utf8");
    expect(source).toMatch(COMMENT_EXPR);
  });

  it("and the notification's note arm reads the NOTE's event id", () => {
    const source = readFileSync(
      path.resolve(__dirname, "..", "src/routes/notifications.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /feed_items_derive_post_id\('nostr',\s*no\.nostr_event_id\)/,
    );
  });
});
