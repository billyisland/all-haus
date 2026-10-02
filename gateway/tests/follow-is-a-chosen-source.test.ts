import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// A FOLLOW IS A CHOSEN SOURCE — and a seeded one is not.
//
// Since the reach retirement (migration 177, §9.16) a `follows` row on its own
// puts nothing in front of anybody, so following is feed-derived on both sides
// of the native/external seam. The client half of that shipped first and was
// not enough: typing a member's name into the vessel bar or the FeedComposer
// writes an `account` source through this same route and wrote no graph row,
// so the button and the composer meant different things. The write therefore
// lives HERE, in the same transaction as the source.
//
// THE DISTINCTION THIS FILE EXISTS FOR IS `ownerChose`. "A source in a feed is
// a follow" is true of a source the member CHOSE and false of one they were
// HANDED. Prod's default-seed formula carries seven accounts, so a blanket
// rule would have every signup publish seven follows nobody made — kind-3
// republished and follower counts moved on seven real profiles, by the signup
// path. The external half has done exactly this harmlessly for months
// precisely BECAUSE it has no published graph; attach kind-3 to membership and
// inherited membership starts making public claims. So the ROUTE passes
// `ownerChose` and redeem / the seed / follow-import pass nothing.
//
// DB-BACKED, AND IT HAS TO BE. What is under test is which ROWS a write
// touches across two tables and one transaction — a mocked pool would answer
// out of the same assumption the code was written from. The last-feed teardown
// in particular is a COUNT over every feed the owner has; only real rows can
// say whether it counted them.
//
// MUTATION LOG (each applied, suite re-run, then reverted):
//   1. sources.ts: `opts.ownerChose === true` → `true` (the blanket rule)
//      ⇒ "a SEEDED account source makes no follow" fails.            DETECTED
//   2. sources.ts: drop the self-source refusal
//      ⇒ "you are not a source of your own feed" fails.              DETECTED
//   3. sources.ts: drop the `blockExistsBetween` call
//      ⇒ "a block refuses in BOTH directions" fails — it resolves where it
//        must reject. Both directions live in that one case on purpose:
//        separate `it`s would let one direction pass while the other went
//        unwritten, which is how a both-ways check becomes a one-way one.
//                                                                    DETECTED
//   4. sources.ts removeSource: drop the remaining-feeds early return, so the
//      last-feed teardown runs on every removal
//      ⇒ "a source leaving ONE of two feeds keeps the follow" fails
//        ('dropped', expected 'kept').                               DETECTED
//   5. sources.ts: drop the `rows[0].status === "active"` term
//      ⇒ "an inactive target gets a source but no follow" fails.     DETECTED
//   6. crud.ts: source_type IN (...) → 'external_source' only
//      ⇒ "deleting the last feed holding somebody unfollows" fails.  DETECTED
//   7. sources.ts removeSource: decide `kept` from the feed_sources COUNT
//      again, rather than from a `follows` lookup (§0ab item 6)
//      ⇒ "a HANDED source leaving one of two feeds answers `none`" fails
//        ('kept', expected 'none') — which is `following: true` on the wire.
//                                                                    DETECTED
//   8. sources.ts removeSource: answer `none` unconditionally on the surviving
//      arm ⇒ "a CHOSEN source in two feeds still answers `kept`" fails.
//                                                                    DETECTED
//
// Run locally (both vars — fixtures use their own client, the routes use the
// shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL \
//   npx vitest run tests/follow-is-a-chosen-source.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let ownerId = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: ownerId };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: ownerId };
    done();
  },
}));

const { addSource, removeSource } = await import(
  "../src/routes/feeds/sources.js"
);
const { registerFeedCrudRoutes } = await import("../src/routes/feeds/crud.js");

describe.skipIf(!DB_URL)("a follow is a chosen source", () => {
  let client: pg.Client;
  const accounts: string[] = [];
  let writerId = "unset";
  let feedA = "unset";
  let feedB = "unset";

  async function account(name: string, status = "active"): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, status)
       VALUES ($1, 'fixture-enc', $2, $3) RETURNING id`,
      [`fixture-chosen-${uniq()}`, name, status],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }

  async function feed(name: string, owner = ownerId): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, $2, 1)
       RETURNING id`,
      [owner, name],
    );
    return rows[0].id;
  }

  /** The graph row itself. The route's response says what it MEANT to do; only
   *  the table says what it did. */
  async function follows(followee: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [ownerId, followee],
    );
    return (rowCount ?? 0) > 0;
  }

  async function sourceCount(followee: string): Promise<number> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM feed_sources fs
         JOIN feeds f ON f.id = fs.feed_id
        WHERE f.owner_id = $1 AND fs.account_id = $2`,
      [ownerId, followee],
    );
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    ownerId = await account("Fixture owner");
    writerId = await account("Fixture writer");
    feedA = await feed("A");
    feedB = await feed("B");
  });

  afterAll(async () => {
    if (accounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        accounts,
      ]);
    await client.end();
  });

  // --- the distinction ------------------------------------------------------

  it("a CHOSEN account source writes the follow, in the same breath", async () => {
    const res = await addSource(
      feedA,
      ownerId,
      { sourceType: "account", accountId: writerId },
      { ownerChose: true },
    );
    expect(res.following).toBe(true);
    expect(await follows(writerId)).toBe(true);
  });

  it("a SEEDED account source makes no follow", async () => {
    // The whole reason `ownerChose` exists. Redeem, the default seed and
    // follow-import all reach addSource by this door.
    const handed = await account("Handed to me");
    const res = await addSource(feedB, ownerId, {
      sourceType: "account",
      accountId: handed,
    });
    // `false` rather than absent: the route answers the question for every
    // account source, and the honest answer here is "no". The claim that
    // matters is the ROW.
    expect(res.following).toBe(false);
    expect(await sourceCount(handed)).toBe(1);
    expect(await follows(handed)).toBe(false);
  });

  it("a second chosen feed does not duplicate the follow", async () => {
    await addSource(
      feedB,
      ownerId,
      { sourceType: "account", accountId: writerId },
      { ownerChose: true },
    );
    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM follows
        WHERE follower_id = $1 AND followee_id = $2`,
      [ownerId, writerId],
    );
    expect(Number(rows[0].n)).toBe(1);
    expect(await sourceCount(writerId)).toBe(2);
  });

  // --- the teardown ---------------------------------------------------------

  it("a source leaving ONE of two feeds keeps the follow", async () => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedA, writerId],
    );
    const res = await removeSource(feedA, ownerId, rows[0].id);
    expect(res.follow).toBe("kept");
    expect(await follows(writerId)).toBe(true);
  });

  it("the LAST feed letting go drops the follow", async () => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedB, writerId],
    );
    const res = await removeSource(feedB, ownerId, rows[0].id);
    expect(res.follow).toBe("dropped");
    expect(await follows(writerId)).toBe(false);
  });

  // --- the answer is about the FOLLOW, not about the source (§0ab item 6) ---

  it("a HANDED source leaving one of two feeds answers `none`, never `kept`", async () => {
    // THE CASE THE WHOLE `ownerChose` RULE PRODUCES, AND THE ONE NOTHING
    // COVERED. `kept` was decided by counting `feed_sources`, and the route
    // sends it to the client as `following: true` — but a handed source has no
    // graph row by this file's own first rule, so a seeded or redeemed writer
    // sitting in two feeds, removed from one, told every client the member was
    // following somebody they had never followed. It painted FOLLOWING on the
    // hover card, the profile bar and the picker until a reload.
    //
    // Two feeds and two removals, because one of each is what tells the fixed
    // code from a version that simply answers `none` for everything.
    const handed = await account("Handed, in two feeds");
    await addSource(feedA, ownerId, { sourceType: "account", accountId: handed });
    await addSource(feedB, ownerId, { sourceType: "account", accountId: handed });
    expect(await follows(handed)).toBe(false);

    const { rows: inA } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedA, handed],
    );
    const first = await removeSource(feedA, ownerId, inA[0].id);
    // A source survives, so nothing was torn down — and there was never a
    // follow to keep. `none`, so the client is told `following: false`.
    expect(first.follow).toBe("none");
    expect(await sourceCount(handed)).toBe(1);

    const { rows: inB } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedB, handed],
    );
    const last = await removeSource(feedB, ownerId, inB[0].id);
    // The LAST feed letting go, and still nothing was dropped: calling this
    // `dropped` would republish the kind-3 list over a row never in it.
    expect(last.follow).toBe("none");
    expect(await follows(handed)).toBe(false);
  });

  it("a CHOSEN source in two feeds still answers `kept` on the first removal", async () => {
    // The control for the case above. A `kept` arm that always answered `none`
    // — or one that asked `follows` and got the sense backwards — would pass
    // the handed case perfectly while telling every real follower they had
    // unfollowed somebody.
    const chosen = await account("Chosen, in two feeds");
    const opts = { ownerChose: true };
    await addSource(feedA, ownerId, { sourceType: "account", accountId: chosen }, opts);
    await addSource(feedB, ownerId, { sourceType: "account", accountId: chosen }, opts);

    const { rows: inA } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedA, chosen],
    );
    const first = await removeSource(feedA, ownerId, inA[0].id);
    expect(first.follow).toBe("kept");
    expect(await follows(chosen)).toBe(true);

    const { rows: inB } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedB, chosen],
    );
    const last = await removeSource(feedB, ownerId, inB[0].id);
    expect(last.follow).toBe("dropped");
    expect(await follows(chosen)).toBe(false);
  });

  it("removing a source that is not an account answers `null`, not a guess", async () => {
    // A boolean here would have the route reporting a follow state for a
    // removed RSS feed, and the client repainting a label off it.
    const { rows: ext } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ('rss', $1) RETURNING id`,
      [`https://example.test/${uniq()}.xml`],
    );
    const added = await addSource(
      feedA,
      ownerId,
      { sourceType: "external_source", externalSourceId: ext[0].id },
      { ownerChose: true },
    );
    const res = await removeSource(feedA, ownerId, added.source.id);
    expect(res.follow).toBeNull();
    await client.query(`DELETE FROM external_sources WHERE id = $1`, [
      ext[0].id,
    ]);
  });

  // --- the refusals ---------------------------------------------------------

  it("you are not a source of your own feed", async () => {
    // Inert while a source and a follow meant different things; a
    // contradiction the moment they are the same thing, since POST /follows
    // has always refused a self-follow. Prod carried two such rows.
    await expect(
      addSource(
        feedA,
        ownerId,
        { sourceType: "account", accountId: ownerId },
        { ownerChose: true },
      ),
    ).rejects.toMatchObject({ code: "SELF_SOURCE" });
    expect(await sourceCount(ownerId)).toBe(0);
  });

  it("a block refuses in BOTH directions, and writes nothing either way", async () => {
    // A follow is a message — it inserts a `new_follower` notification — so
    // this path takes the same both-ways check `POST /follows` does. The
    // assertion that matters is that no ROW survived the refusal.
    const them = await account("Blocked pair");

    await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`,
      [them, ownerId],
    );
    await expect(
      addSource(
        feedA,
        ownerId,
        { sourceType: "account", accountId: them },
        { ownerChose: true },
      ),
    ).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
    expect(await sourceCount(them)).toBe(0);
    expect(await follows(them)).toBe(false);

    // …and the other way round, which is a different row and a different case.
    await client.query(`DELETE FROM blocks WHERE blocker_id = $1`, [them]);
    await client.query(
      `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`,
      [ownerId, them],
    );
    await expect(
      addSource(
        feedA,
        ownerId,
        { sourceType: "account", accountId: them },
        { ownerChose: true },
      ),
    ).rejects.toMatchObject({ code: "TARGET_BLOCKED" });
    expect(await sourceCount(them)).toBe(0);
    await client.query(`DELETE FROM blocks WHERE blocker_id = $1`, [ownerId]);
  });

  it("deleting the last feed holding somebody unfollows them", async () => {
    // H6's own reasoning, one column over. A bare `DELETE FROM feeds`
    // cascades `feed_sources` away without passing through the teardown, so
    // the follow would survive its last source: the writer in no feed, the
    // profile still reading "Following", and the only way back the legacy
    // escape hatch. Driven through the ROUTE, because the guard is the route's
    // sweep and not anything `removeSource` can do by itself.
    const app = Fastify({ logger: false });
    registerFeedCrudRoutes(app);
    await app.ready();
    try {
      const doomed = await feed("Doomed");
      const them = await account("In the doomed feed");
      await addSource(
        doomed,
        ownerId,
        { sourceType: "account", accountId: them },
        { ownerChose: true },
      );
      expect(await follows(them)).toBe(true);

      const res = await app.inject({ method: "DELETE", url: `/feeds/${doomed}` });
      expect(res.statusCode).toBe(204);
      expect(await sourceCount(them)).toBe(0);
      expect(await follows(them)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("an inactive target gets a source but no follow", async () => {
    // `POST /follows` only ever followed an active account. The source is
    // still allowed — a deactivated writer's existing rows are the member's
    // own intent and come back when they do — but the graph row is not
    // written for somebody who is not there.
    const dormant = await account("Dormant", "deactivated");
    const res = await addSource(
      feedA,
      ownerId,
      { sourceType: "account", accountId: dormant },
      { ownerChose: true },
    );
    expect(res.following).toBe(false);
    expect(await sourceCount(dormant)).toBe(1);
    expect(await follows(dormant)).toBe(false);
  });
});
