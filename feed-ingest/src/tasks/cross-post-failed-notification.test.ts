import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { CROSS_POST_FAILED_NOTIFICATION_SQL } from "./outbound-cross-post.js";

// =============================================================================
// A failed cross-post is told to the member (CROSS-NETWORK-ROUNDTRIP-ADR A7).
//
// Runs the worker's OWN exported statement against a live Postgres, because
// what it decides is only Postgres's to evaluate: the join from an
// outbound_posts row to its note by event id, the speech-only action filter,
// and — the part a mock cannot see at all — that `idx_notifications_dedup`
// collapses every failed target of ONE note into one unread row, which it can
// only do because the actor is BOUND (actor_id NULL never conflicts).
//
// Fixtures live in a transaction that is always rolled back. Skipped unless a
// DB URL is supplied — CI supplies one and fails on a skip.
//
// Mutations it was proved against (each turns a case red):
//   · actor_id → NULL in the SELECT        → "one note, two failed networks"
//   · drop the action_type filter           → "a failed like tells nobody"
//   · JOIN notes on n.id = op.id            → "tells the member, bound to the note"
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("cross_post_failed notification", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let accountId: string;
  let noteId: string;
  const eventId = "c".repeat(63) + "1";

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    accountId = (
      await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES (encode(gen_random_bytes(32), 'hex')) RETURNING id`,
      )
    ).rows[0].id;
    noteId = (
      await client.query<{ id: string }>(
        `INSERT INTO notes (author_id, nostr_event_id, content) VALUES ($1, $2, 'hello') RETURNING id`,
        [accountId, eventId],
      )
    ).rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function failedRow(protocol: string, actionType: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO outbound_posts (account_id, protocol, nostr_event_id, action_type, status)
       VALUES ($1, $2, $3, $4, 'failed') RETURNING id`,
      [accountId, protocol, eventId, actionType],
    );
    return rows[0].id;
  }

  async function notifications() {
    const { rows } = await client.query<{
      recipient_id: string;
      actor_id: string | null;
      type: string;
      note_id: string | null;
    }>(
      `SELECT recipient_id, actor_id, type, note_id FROM notifications WHERE recipient_id = $1`,
      [accountId],
    );
    return rows;
  }

  it("tells the member, bound to the note", async () => {
    const op = await failedRow("atproto", "reply");
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [op]);
    expect(await notifications()).toEqual([
      { recipient_id: accountId, actor_id: accountId, type: "cross_post_failed", note_id: noteId },
    ]);
  });

  it("one note, two failed networks → one unread notification", async () => {
    const a = await failedRow("atproto", "original");
    const b = await failedRow("nostr_external", "quote");
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [a]);
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [b]);
    expect(await notifications()).toHaveLength(1);
  });

  it("a failed like tells nobody (not speech, no note to open)", async () => {
    const op = await failedRow("atproto", "like");
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [op]);
    expect(await notifications()).toHaveLength(0);
  });

  it("a later failure after the member READ the first is told again", async () => {
    const a = await failedRow("atproto", "reply");
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [a]);
    await client.query(`UPDATE notifications SET read = true WHERE recipient_id = $1`, [accountId]);
    const b = await failedRow("activitypub", "quote");
    await client.query(CROSS_POST_FAILED_NOTIFICATION_SQL, [b]);
    expect(await notifications()).toHaveLength(2);
  });
});
