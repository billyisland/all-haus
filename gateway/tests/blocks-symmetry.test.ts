import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// =============================================================================
// A block is a fact about a PAIR, and the predicate has to answer it both ways
//
// Two paths asked half the question and failed in opposite directions.
// `sendMessage` asked only "did a recipient block me?", so a BLOCKER could go
// on sending one-way messages to somebody who by construction could not reply.
// `POST /follows` asked nothing at all while inserting a `new_follower`
// notification, so a blocked account held a repeatable notification channel to
// the person who had blocked them.
//
// WHY DB-BACKED, and this is the whole reason the file exists. The defect and
// the fix differ ONLY in the shape of one WHERE clause — `blocker_id = $1 AND
// blocked_id = $2` versus that OR its transpose. A mocked `pool.query`
// dispatching on the query text ("does this SQL name `blocks`?") hands back the
// same fixture row whichever spelling it is given, so every assertion below
// would pass green against the one-directional statement it exists to catch.
// Only Postgres can tell the two apart. Same class as the notification-dedup
// and event-id-squat suites: the rule lives in SQL, so the test runs SQL.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/blocks-symmetry.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("blocks are symmetric", () => {
  let client: pg.Client;
  let blockExistsBetween: typeof import("../src/lib/blocks.js").blockExistsBetween;
  let blockExistsWithAny: typeof import("../src/lib/blocks.js").blockExistsWithAny;
  let listInbox: typeof import("../src/services/messages.js").listInbox;

  // alice blocks bob. carol blocks nobody and is blocked by nobody — the
  // control without which "refuses" is indistinguishable from "always refuses",
  // which is the failure mode a guard this blunt actually ships with.
  let alice: string, bob: string, carol: string;
  // Three 1:1 conversations, one per pair. Only alice–bob is block-paired.
  let convoAliceBob: string, convoAliceCarol: string, convoBobCarol: string;

  const stamp = Date.now().toString(36);

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    ({ blockExistsBetween, blockExistsWithAny } = await import(
      "../src/lib/blocks.js"
    ));
    ({ listInbox } = await import("../src/services/messages.js"));

    const acct = async (suffix: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
        [`blk${stamp}${suffix}`.padEnd(64, "0")],
      );
      return rows[0].id;
    };
    alice = await acct("a");
    bob = await acct("b");
    carol = await acct("c");

    await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`,
      [alice, bob],
    );

    const convo = async (a: string, b: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO conversations (created_by) VALUES ($1) RETURNING id`,
        [a],
      );
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
        [rows[0].id, a, b],
      );
      return rows[0].id;
    };
    convoAliceBob = await convo(alice, bob);
    convoAliceCarol = await convo(alice, carol);
    convoBobCarol = await convo(bob, carol);
  });

  afterAll(async () => {
    const ids = [alice, bob, carol];
    const convos = [convoAliceBob, convoAliceCarol, convoBobCarol];
    await client.query(
      `DELETE FROM conversation_members WHERE conversation_id = ANY($1::uuid[])`,
      [convos],
    );
    await client.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [convos]);
    await client.query(
      `DELETE FROM blocks WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])`,
      [ids],
    );
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [ids]);
    await client.end();
    const { pool } = await import("@platform-pub/shared/db/client.js");
    await pool.end();
  });

  // ---------------------------------------------------------------------------
  // The pair form — `POST /follows`
  // ---------------------------------------------------------------------------

  it("sees the block from the BLOCKED party's side", async () => {
    // The direction the old one-sided predicates did cover.
    expect(await blockExistsBetween(bob, alice)).toBe(true);
  });

  it("sees the block from the BLOCKER's side — the direction that was missing", async () => {
    // Transposed arguments, same pair. This is the assertion that fails against
    // `blocker_id = $1 AND blocked_id = $2`, and it is the whole finding: alice
    // blocked bob, and alice must not thereby acquire a one-way channel to him.
    expect(await blockExistsBetween(alice, bob)).toBe(true);
  });

  it("is false for a pair with no block, in either order", async () => {
    expect(await blockExistsBetween(alice, carol)).toBe(false);
    expect(await blockExistsBetween(carol, alice)).toBe(false);
  });

  it("is false for an account against itself", async () => {
    expect(await blockExistsBetween(alice, alice)).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The set form — conversations
  // ---------------------------------------------------------------------------

  it("finds a block anywhere in a member set, from either side", async () => {
    // bob's side: a recipient blocked him. Covered before the fix.
    expect(await blockExistsWithAny(bob, [carol, alice])).toBe(true);
    // alice's side: SHE blocked a recipient. Not covered before the fix — this
    // is the group-conversation form of the one-way messaging hole.
    expect(await blockExistsWithAny(alice, [carol, bob])).toBe(true);
  });

  it("is false when the set holds nobody the actor is paired with", async () => {
    expect(await blockExistsWithAny(alice, [carol])).toBe(false);
    expect(await blockExistsWithAny(carol, [bob])).toBe(false);
  });

  it("is false for an empty set without asking the database", async () => {
    // The early return is not just an optimisation: `= ANY('{}')` is never
    // true, so the SQL would answer correctly — but a guard that spends a round
    // trip to be told there is nobody to check is the loop-that-runs-once
    // shape, and `createConversation` reaches it whenever a member list has
    // been filtered down to the creator alone.
    expect(await blockExistsWithAny(alice, [])).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // The display twin — `listInbox` (S25 item 2)
  //
  // `sendMessage` refuses both ways; the inbox lists what the viewer can write
  // into, so it hides both ways too. Before S25 its NOT EXISTS was keyed on
  // `b.blocked_id = $1` alone — the one-directional statement this file's
  // header says a text-dispatching mock cannot tell from the fix.
  // ---------------------------------------------------------------------------

  it("hides the conversation from the BLOCKED party", async () => {
    const ids = (await listInbox(bob)).map((c) => c.id);
    expect(ids).not.toContain(convoAliceBob);
    expect(ids).toContain(convoBobCarol); // the unblocked control
  });

  it("hides it from the BLOCKER too — the direction that was missing", async () => {
    const ids = (await listInbox(alice)).map((c) => c.id);
    expect(ids).not.toContain(convoAliceBob);
    expect(ids).toContain(convoAliceCarol);
  });

  it("lists everything for a member paired with no block", async () => {
    const ids = (await listInbox(carol)).map((c) => c.id);
    expect(ids).toContain(convoAliceCarol);
    expect(ids).toContain(convoBobCarol);
  });
});
