import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  REKEYED_COLUMNS,
  NOT_REKEYED,
  rekeyArticleEvent,
} from "../src/lib/article-event-rekey.js";

// =============================================================================
// An edit carries the conversation with it — and the registry stays honest.
//
// MIRROR-AUDIT §2.8. A NIP-23 article is replaceable, so an edit signs a NEW
// event with a NEW id and the publish upsert writes it over the old one. Nothing
// moved what pointed AT it, so every comment, vote, tally, engagement row and
// report on the piece was orphaned on every edit — silently, and the article
// page, the thread projector and the deep links all key on the current id, so
// the conversation simply ceased to exist. Worse, the commenters' Replies log
// then shipped those comments with `rootLocked` ABSENT, which discloses a locked
// conversation as an open one.
//
// TWO CLAIMS, AND THE SECOND IS THE DURABLE ONE.
//
//  (1) The move works, and is scoped: rows on THIS piece move, rows on another
//      piece do not. DB-backed because it is an UPDATE's `WHERE` — a mocked
//      client would be told which rows it matched.
//
//  (2) EVERY column in the live schema that could hold an article's event id is
//      classified — moved, or deliberately not moved with a stated reason. The
//      four tables we know about were never the risk; the fifth one somebody
//      adds next year is, and it would orphan in exactly the same silence. So
//      the guard reads the SCHEMA rather than a list somebody remembered to
//      update, and fails on anything unclassified. Same shape as the
//      ledger-adjacency guard, and the same reason.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/article-event-rekey.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("article edit — the event re-key", () => {
  let client: pg.Client;
  let writerId: string;
  let otherArticleEvent: string;

  const stamp = Date.now().toString(36);
  const OLD_EVENT = `old${stamp}`.padEnd(64, "0");
  const NEW_EVENT = `new${stamp}`.padEnd(64, "0");

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [`rekey${stamp}`.padEnd(64, "0")],
    );
    writerId = rows[0].id;
    otherArticleEvent = `oth${stamp}`.padEnd(64, "0");

    // One comment and one vote on the piece being edited, and one of each on a
    // DIFFERENT piece — the control that says the UPDATE is scoped.
    await client.query(
      `INSERT INTO comments (author_id, nostr_event_id, target_event_id, target_kind, content)
       VALUES ($1, $2, $3, 30023, 'on the edited piece'),
              ($1, $4, $5, 30023, 'on another piece')`,
      [
        writerId,
        `c1${stamp}`.padEnd(64, "0"),
        OLD_EVENT,
        `c2${stamp}`.padEnd(64, "0"),
        otherArticleEvent,
      ],
    );
    await client.query(
      `INSERT INTO votes
         (voter_id, target_nostr_event_id, target_author_id, direction, sequence_number)
       VALUES ($1, $2, $1, 'up', 1), ($1, $3, $1, 'up', 1)`,
      [writerId, OLD_EVENT, otherArticleEvent],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM votes WHERE voter_id = $1`, [writerId]);
    await client.query(`DELETE FROM comments WHERE author_id = $1`, [writerId]);
    await client.query(`DELETE FROM accounts WHERE id = $1`, [writerId]);
    await client.end();
  });

  it("moves this piece's conversation and reactions, and only this piece's", async () => {
    const moved = await rekeyArticleEvent(client, OLD_EVENT, NEW_EVENT);

    expect(moved.comments).toBe(1);
    expect(moved.votes).toBe(1);

    const stillOld = await client.query(
      `SELECT 1 FROM comments WHERE target_event_id = $1
        UNION ALL
       SELECT 1 FROM votes WHERE target_nostr_event_id = $1`,
      [OLD_EVENT],
    );
    expect(stillOld.rows).toHaveLength(0);

    // The control: another piece's rows are untouched. An unscoped UPDATE would
    // capture every conversation on the site, which is the failure mode that
    // makes this worth a test rather than a reading.
    const other = await client.query(
      `SELECT 1 FROM comments WHERE target_event_id = $1
        UNION ALL
       SELECT 1 FROM votes WHERE target_nostr_event_id = $1`,
      [otherArticleEvent],
    );
    expect(other.rows).toHaveLength(2);
  });

  it("does nothing when the id has not changed, or when there was no prior id", async () => {
    // A first publish has no old id, and re-signing an unchanged event is not
    // an edit. Both must be no-ops — an empty `oldEventId` reaching the UPDATE
    // would match nothing today and everything the day a column goes NOT NULL
    // with an empty-string default.
    expect(await rekeyArticleEvent(client, "", NEW_EVENT)).toEqual({});
    expect(await rekeyArticleEvent(client, NEW_EVENT, NEW_EVENT)).toEqual({});
  });

  it("classifies every event-id column in the live schema", async () => {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name LIKE '%event_id%'
        ORDER BY table_name, column_name`,
    );

    // A path typo or a renamed schema would make this pass by finding nothing,
    // which is the same "it scanned no files" trap the href grep guards against.
    expect(rows.length).toBeGreaterThan(20);

    const moved = new Set(
      REKEYED_COLUMNS.map(([t, c]) => `${t}.${c}`),
    );
    const unclassified = rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((k) => !moved.has(k) && !(k in NOT_REKEYED));

    // The message is the point: whoever added the column has to decide whether
    // an edit moves it, and write down why — not discover in a year that a
    // conversation-shaped thing quietly stopped existing on every edit.
    expect(
      unclassified,
      `Unclassified event-id column(s): ${unclassified.join(", ")}. ` +
        `Add each to REKEYED_COLUMNS (an edit moves it) or NOT_REKEYED (with the reason) ` +
        `in gateway/src/lib/article-event-rekey.ts.`,
    ).toEqual([]);
  });

  it("names a real column in every registry entry", async () => {
    // The other direction: a registry that has drifted the other way — naming
    // a column that no longer exists — is a rule that silently covers nothing.
    const { rows } = await client.query<{ key: string }>(
      `SELECT table_name || '.' || column_name AS key
         FROM information_schema.columns
        WHERE table_schema = 'public'`,
    );
    const live = new Set(rows.map((r) => r.key));

    const stale = [
      ...REKEYED_COLUMNS.map(([t, c]) => `${t}.${c}`),
      ...Object.keys(NOT_REKEYED),
    ].filter((k) => !live.has(k));

    expect(stale, `Registry names column(s) that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
