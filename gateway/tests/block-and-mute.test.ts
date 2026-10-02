import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";

// =============================================================================
// BLOCK AND MUTE, MADE REAL (W2 — walkthrough A7, operator ruling 2026-09-24).
//
// The six routes existed and nothing could put anybody into them. With the
// controls on the profile bar and the DM header, the routes start carrying
// consequences, and this file pins each one against real rows:
//
//   · a BLOCK ends the standing relationships in its own transaction —
//     follows BOTH ways, and any subscription between the pair runs to period
//     end (auto_renew off, period end untouched, nothing charged);
//   · a REPLY is refused when a block runs EITHER way (it asked one);
//   · NOTIFICATIONS from a hidden actor leave the list AND both unread counts,
//     on the READ side, so an unmute brings them back;
//   · `GET /my/relations/:id` reports what the VIEWER did, never the block the
//     other party set (that would be the oracle `lib/blocks.ts` refuses);
//   · an unknown account answers 404 on both writes, not the FK's 500.
//
// DB-BACKED because every one of those is a question about which ROWS a
// statement touches or matches — a both-ways OR, a UNION over two directions,
// a NOT EXISTS inside a COUNT. A mock dispatching on the SQL text answers the
// same fixture to the one-directional spelling (blocks-symmetry.test.ts says
// why at length).
//
// MUTATION LOG (each applied, suite re-run, then reverted):
//   1. social.ts: drop the `OR (follower_id = $2 AND followee_id = $1)` arm
//      ⇒ "a block drops follows BOTH ways" fails (the blocked party's follow
//        of the blocker survives).                                  DETECTED
//   2. social.ts: cancel only the [blockerId, userId] direction
//      ⇒ "…and lets a subscription either way lapse" fails.         DETECTED
//   3. replies.ts: restore the one-directional
//      `blocker_id = $1 AND blocked_id = $2` check
//      ⇒ "a reply is refused when a block runs EITHER way" fails.    DETECTED
//   4. blocks.ts hiddenFromViewerSql: drop the block half (mutes only)
//      ⇒ "a block the ACTOR set hides their notifications" fails.    DETECTED
//   5. notifications.ts: drop `${VISIBLE}` from /unread-counts only
//      ⇒ both notification cases fail on the badge count — the list and
//        the badge had stopped agreeing.                            DETECTED
//   6. blocks.ts viewerRelation: transpose the blocks EXISTS
//      ⇒ "relations report the viewer's own block, never the other's" fails.
//                                                                    DETECTED
//   7. social.ts: drop the accountExists 404 on POST /my/blocks
//      ⇒ "an unknown account is a 404" fails with the FK's 500.     DETECTED
//   8. subscriptions/writer.ts: drop the blockExistsBetween refusal
//      ⇒ "a subscribe is refused when a block runs EITHER way" fails
//        (402 card_required where 403 was expected).                DETECTED
//
// Run locally (both vars — fixtures use their own client, the routes the
// shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL \
//   npx vitest run tests/block-and-mute.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.READER_HASH_KEY ??= "test-reader-hash-key";
process.env.INTERNAL_SECRET ??= "test-internal-secret";
// The kind-7003 cancellation is signed with the SERVICE key; any valid scalar.
process.env.PLATFORM_SERVICE_PRIVKEY ??= "1".repeat(64);

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let viewer: string | null = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
  // A null viewer is a stranger: no session at all, which is what the search
  // cases below need to prove the hide is the VIEWER's and not a public one.
  optionalAuth: (req: any, _reply: any, done: any) => {
    if (viewer) req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
}));

const { socialRoutes } = await import("../src/routes/social.js");
const { notificationRoutes } = await import("../src/routes/notifications.js");
const { replyRoutes } = await import("../src/routes/replies.js");
const { subscriptionWriterRoutes } = await import("../src/routes/subscriptions/writer.js");
const { searchRoutes } = await import("../src/routes/search.js");

describe.skipIf(!DB_URL)("block and mute, made real", () => {
  let client: pg.Client;
  let app: FastifyInstance;
  const accounts: string[] = [];

  async function account(name: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      // Admitted as writers, so a subscribe reaches the block check rather
      // than the reader refusal before it (READER-WRITER-SPLIT-ADR §5).
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, status, writer_admitted_at)
       VALUES ($1, 'fixture-enc', $2, 'active', now()) RETURNING id`,
      [`fixture-w2-${uniq()}`.padEnd(64, "0"), name],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }

  async function follow(a: string, b: string) {
    await client.query(
      `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2)`,
      [a, b],
    );
  }
  async function follows(a: string, b: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [a, b],
    );
    return (rowCount ?? 0) > 0;
  }
  async function subscribe(reader: string, writer: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (reader_id, writer_id, price_pence, period_anchor_day,
                                  current_period_end)
       VALUES ($1, $2, 500, 1, '2099-01-01T00:00:00Z') RETURNING id`,
      [reader, writer],
    );
    return rows[0].id;
  }
  async function sub(id: string) {
    const { rows } = await client.query<{
      status: string;
      auto_renew: boolean;
      current_period_end: Date;
    }>(
      `SELECT status, auto_renew, current_period_end FROM subscriptions WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function notify(recipient: string, actor: string | null, type: string) {
    await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type) VALUES ($1, $2, $3)`,
      [recipient, actor, type],
    );
  }
  function as(id: string | null) {
    viewer = id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(socialRoutes);
    await app.register(notificationRoutes);
    await app.register(replyRoutes);
    await app.register(subscriptionWriterRoutes);
    await app.register(searchRoutes);
    await app.ready();
  });

  afterAll(async () => {
    if (accounts.length) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM subscriptions WHERE reader_id = ANY($1::uuid[])`,
        [accounts],
      );
      await client.query(`DELETE FROM relay_outbox WHERE entity_id = ANY($1::uuid[])`, [
        rows.map((r) => r.id),
      ]);
      await client.query(`DELETE FROM subscriptions WHERE reader_id = ANY($1::uuid[])`, [
        accounts,
      ]);
      await client.query(`DELETE FROM feed_items WHERE author_id = ANY($1::uuid[])`, [
        accounts,
      ]);
      await client.query(`DELETE FROM comments WHERE author_id = ANY($1::uuid[])`, [
        accounts,
      ]);
      await client.query(`DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`, [
        accounts,
      ]);
      await client.query(`DELETE FROM notes WHERE author_id = ANY($1::uuid[])`, [
        accounts,
      ]);
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    }
    await app?.close();
    await client?.end();
  });

  // --- what a block ends -----------------------------------------------------

  it("a block drops follows BOTH ways, and nobody else's", async () => {
    const alice = await account("Alice");
    const bob = await account("Bob");
    const carol = await account("Carol");
    await follow(alice, bob);
    await follow(bob, alice);
    // The control: a follow that involves one of the pair and not the other.
    await follow(carol, bob);

    as(alice);
    const res = await app.inject({ method: "POST", url: `/my/blocks/${bob}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().followsDropped).toBe(2);

    expect(await follows(alice, bob)).toBe(false);
    expect(await follows(bob, alice)).toBe(false);
    expect(await follows(carol, bob)).toBe(true);
  });

  it("…and lets a subscription either way lapse at period end, charging nothing", async () => {
    const alice = await account("Alice");
    const bob = await account("Bob");
    const carol = await account("Carol");
    const aliceToBob = await subscribe(alice, bob);
    const bobToAlice = await subscribe(bob, alice);
    const carolToBob = await subscribe(carol, bob);

    as(bob);
    const res = await app.inject({ method: "POST", url: `/my/blocks/${alice}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscriptionsEnding).toHaveLength(2);

    for (const id of [aliceToBob, bobToAlice]) {
      const s = await sub(id);
      expect(s.status).toBe("cancelled");
      expect(s.auto_renew).toBe(false);
      // Access runs to the period end it already had — nothing is cut short.
      expect(s.current_period_end.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    }
    const control = await sub(carolToBob);
    expect(control.status).toBe("active");
    expect(control.auto_renew).toBe(true);

    // Nothing moved on the ledger for either party.
    const { rows } = await client.query(
      `SELECT 1 FROM ledger_entries WHERE account_id = ANY($1::uuid[])`,
      [[alice, bob]],
    );
    expect(rows).toHaveLength(0);
  });

  it("an unknown account is a 404 on both writes, and nothing is written", async () => {
    const alice = await account("Alice");
    const ghost = "00000000-0000-4000-8000-00000000dead";
    as(alice);
    for (const path of ["blocks", "mutes"]) {
      const res = await app.inject({ method: "POST", url: `/my/${path}/${ghost}` });
      expect(res.statusCode).toBe(404);
    }
    const { rows } = await client.query(
      `SELECT 1 FROM blocks WHERE blocker_id = $1 UNION ALL
       SELECT 1 FROM mutes WHERE muter_id = $1`,
      [alice],
    );
    expect(rows).toHaveLength(0);
  });

  // --- subscribing again after the lapse ---------------------------------------

  it("a subscribe is refused when a block runs EITHER way", async () => {
    // A block lets the subscription lapse at period end; without this the
    // reader could simply subscribe again the next day.
    const writer = await account("Writer");
    const blocker = await account("Blocker");
    const blocked = await account("Blocked");
    const carol = await account("Carol");
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      blocker,
      writer,
    ]);
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      writer,
      blocked,
    ]);

    const press = (who: string) => {
      as(who);
      return app.inject({ method: "POST", url: `/subscriptions/${writer}`, payload: {} });
    };

    for (const who of [blocker, blocked]) {
      const res = await press(who);
      expect(res.statusCode).toBe(403);
      // Neutral: the same sentence whichever way the block runs.
      expect(res.json()).toEqual({ error: "You cannot subscribe to this writer" });
    }
    // The control: no block either way reaches the NEXT gate (no card on file).
    const res = await press(carol);
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("card_required");
    const { rowCount } = await client.query(
      `SELECT 1 FROM subscriptions WHERE writer_id = $1`,
      [writer],
    );
    expect(rowCount).toBe(0);
  });

  // --- replies ---------------------------------------------------------------

  it("a reply is refused when a block runs EITHER way", async () => {
    const writer = await account("Writer");
    const blocker = await account("Blocker");
    const blocked = await account("Blocked");
    const carol = await account("Carol");
    const noteEvent = `${uniq()}`.padEnd(64, "a");
    await client.query(
      `INSERT INTO notes (author_id, nostr_event_id, content) VALUES ($1, $2, 'hello')`,
      [writer, noteEvent],
    );
    // The commenter blocked the writer (the direction that was never asked)…
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      blocker,
      writer,
    ]);
    // …and the writer blocked this one (the direction that always was).
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      writer,
      blocked,
    ]);

    const post = (who: string) => {
      as(who);
      return app.inject({
        method: "POST",
        url: "/replies",
        payload: {
          nostrEventId: `${uniq()}`.padEnd(64, "b"),
          targetEventId: noteEvent,
          targetKind: 1,
          content: "a reply",
        },
      });
    };

    expect((await post(blocker)).statusCode).toBe(403);
    expect((await post(blocked)).statusCode).toBe(403);
    // The control: somebody with no block either way gets past the guard.
    expect((await post(carol)).statusCode).not.toBe(403);
  });

  it("a reply to a COMMENT asks the comment's author too, either way (CA-B8)", async () => {
    // The content's author blocks nobody; the block is between the replier
    // and the person whose remark is being answered.
    const writer = await account("Writer");
    const commenter = await account("Commenter");
    const blocker = await account("Blocker");
    const blocked = await account("Blocked");
    const carol = await account("Carol");
    const noteEvent = `${uniq()}`.padEnd(64, "c");
    await client.query(
      `INSERT INTO notes (author_id, nostr_event_id, content) VALUES ($1, $2, 'hello')`,
      [writer, noteEvent],
    );
    const { rows: parent } = await client.query<{ id: string }>(
      `INSERT INTO comments (author_id, nostr_event_id, target_event_id, target_kind, content)
       VALUES ($1, $2, $3, 1, 'a remark') RETURNING id`,
      [commenter, `${uniq()}`.padEnd(64, "d"), noteEvent],
    );
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [blocker, commenter]);
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [commenter, blocked]);

    const post = (who: string) => {
      as(who);
      return app.inject({
        method: "POST",
        url: "/replies",
        payload: {
          nostrEventId: `${uniq()}`.padEnd(64, "e"),
          targetEventId: noteEvent,
          targetKind: 1,
          parentCommentId: parent[0].id,
          content: "answering the remark",
        },
      });
    };
    expect((await post(blocker)).statusCode).toBe(403);
    expect((await post(blocked)).statusCode).toBe(403);
    // The control: a third member with no block against the commenter, and
    // none against the writer, is not refused by this guard.
    expect((await post(carol)).statusCode).not.toBe(403);
  });

  // --- the feed arms (structural) ----------------------------------------------

  it("both feed arms hide through the one home, and neither spells the one-way form (CA-B9)", async () => {
    // Driving the composed feed needs the whole selection machinery; what the
    // fix changed is which PREDICATE the two arms carry, and the predicate's
    // own behaviour is the "hide set is the union" case below. A structural
    // pin, said so.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(path.resolve(__dirname, "../src/routes/feeds/items.ts"), "utf8");
    expect(src.match(/NOT \$\{hiddenFromViewerSql\("\$1", "fi\.author_id"\)\}/g)).toHaveLength(2);
    expect(src).not.toMatch(/blocker_id = \$1 AND blocked_id = fi\.author_id/);
    expect(src).not.toMatch(/muter_id = \$1 AND muted_id = fi\.author_id/);
  });

  // --- search --------------------------------------------------------------------

  it("search hides a blocked pair and a mute from the VIEWER, and nothing from a stranger (CA-B10)", async () => {
    const stem = `srch${uniq()}`;
    const me = await account("Searcher");
    const blockedMe = await account(`${stem} BlockedMe`);
    const iBlocked = await account(`${stem} IBlocked`);
    const iMuted = await account(`${stem} IMuted`);
    const plain = await account(`${stem} Plain`);
    for (const [who, i] of [[blockedMe, 1], [iBlocked, 2], [iMuted, 3], [plain, 4]] as const) {
      await client.query(
        `UPDATE accounts SET username = $2 WHERE id = $1`,
        [who, `${stem}u${i}`],
      );
      await client.query(
        `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [who, `${uniq()}`.padEnd(64, "f"), `${stem}-d${i}`, `${stem} title ${i}`, `${stem}-s${i}`],
      );
    }
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [blockedMe, me]);
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [me, iBlocked]);
    await client.query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2)`, [me, iMuted]);

    const search = async (type: "articles" | "writers") => {
      const res = await app.inject({ method: "GET", url: `/search?q=${stem}&type=${type}&limit=50` });
      expect(res.statusCode).toBe(200);
      const results = res.json().results as Array<{ id?: string; writer?: { username: string }; username?: string }>;
      return new Set(results.map((r) => (type === "writers" ? r.username! : r.writer!.username)));
    };

    as(me);
    const mineA = await search("articles");
    expect(mineA.has(`${stem}u4`)).toBe(true);
    expect(mineA.has(`${stem}u1`)).toBe(false);
    expect(mineA.has(`${stem}u2`)).toBe(false);
    expect(mineA.has(`${stem}u3`)).toBe(false);
    const mineW = await search("writers");
    expect(mineW).toEqual(new Set([`${stem}u4`]));

    // A stranger: search is public, and a block is a fact about a pair the
    // stranger is not part of.
    as(null);
    const theirsA = await search("articles");
    expect(theirsA).toEqual(new Set([`${stem}u1`, `${stem}u2`, `${stem}u3`, `${stem}u4`]));
    const theirsW = await search("writers");
    expect(theirsW).toEqual(new Set([`${stem}u1`, `${stem}u2`, `${stem}u3`, `${stem}u4`]));
    await client.query(`DELETE FROM mutes WHERE muter_id = $1`, [me]);
  });

  // --- notifications -----------------------------------------------------------

  it("a muted actor's notifications leave the list and the counts, and an unmute brings them back", async () => {
    const me = await account("Me");
    const loud = await account("Loud");
    const quiet = await account("Quiet");
    await notify(me, loud, "new_follower");
    await notify(me, quiet, "new_follower");
    await notify(me, null, "subscription_activity");

    as(me);
    const list = async () => {
      const body = (await app.inject({ url: "/notifications" })).json();
      const badge = (await app.inject({ url: "/unread-counts" })).json();
      return {
        actors: body.notifications.map((n: any) => n.actor?.id ?? null).sort(),
        unread: body.unreadCount,
        badge: badge.notificationCount,
      };
    };

    const before = await list();
    expect(before.unread).toBe(3);

    await app.inject({ method: "POST", url: `/my/mutes/${loud}` });
    const muted = await list();
    expect(muted.actors).toEqual([null, quiet].sort());
    expect(muted.unread).toBe(2);
    // The badge agrees with the list — one predicate for both.
    expect(muted.badge).toBe(2);

    await app.inject({ method: "DELETE", url: `/my/mutes/${loud}` });
    const back = await list();
    expect(back.unread).toBe(3);
    expect(back.badge).toBe(3);
  });

  it("a block the ACTOR set hides their notifications too", async () => {
    const me = await account("Me");
    const actor = await account("Actor");
    await notify(me, actor, "new_follower");
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      actor,
      me,
    ]);
    as(me);
    const body = (await app.inject({ url: "/notifications" })).json();
    expect(body.notifications).toHaveLength(0);
    expect(body.unreadCount).toBe(0);
    expect((await app.inject({ url: "/unread-counts" })).json().notificationCount).toBe(0);
  });

  // --- what the viewer is told -------------------------------------------------

  it("relations report the viewer's own block, never the other's", async () => {
    const me = await account("Me");
    const target = await account("Target");
    const blocksMe = await account("BlocksMe");
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [
      blocksMe,
      me,
    ]);
    as(me);
    await app.inject({ method: "POST", url: `/my/blocks/${target}` });
    await app.inject({ method: "POST", url: `/my/mutes/${target}` });

    expect((await app.inject({ url: `/my/relations/${target}` })).json()).toEqual({
      muted: true,
      blocked: true,
    });
    // They blocked ME: the control reads "Block", as it would for anybody.
    expect((await app.inject({ url: `/my/relations/${blocksMe}` })).json()).toEqual({
      muted: false,
      blocked: false,
    });
    // Yourself: no relationship to state.
    expect((await app.inject({ url: `/my/relations/${me}` })).statusCode).toBe(404);
  });

  it("the hide set is the union of both block directions and the viewer's mutes", async () => {
    const { loadHiddenAuthorIds } = await import("../src/lib/blocks.js");
    const me = await account("Me");
    const muted = await account("Muted");
    const blockedByMe = await account("BlockedByMe");
    const blocksMe = await account("BlocksMe");
    const mutesMe = await account("MutesMe"); // their mute is THEIR business
    const bystander = await account("Bystander");
    await client.query(`INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2), ($3, $1)`, [
      me,
      muted,
      mutesMe,
    ]);
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2), ($3, $1)`, [
      me,
      blockedByMe,
      blocksMe,
    ]);
    const hidden = await loadHiddenAuthorIds(me);
    expect([...hidden].sort()).toEqual([muted, blockedByMe, blocksMe].sort());
    expect(hidden.has(mutesMe)).toBe(false);
    expect(hidden.has(bystander)).toBe(false);
    expect((await loadHiddenAuthorIds(null)).size).toBe(0);
  });
});
