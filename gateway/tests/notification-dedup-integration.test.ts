import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";

// =============================================================================
// idx_notifications_dedup — what it collapses, and what it must not.
//
// Three migrations are pinned here. 172 widened the index with offer_id; 173
// made it PARTIAL (`WHERE read = false`), which is migration 019's intent
// finally reaching a database — 019 was seeded as applied by schema.sql and so
// never ran anywhere, leaving "repeat events silently fail to notify" live for
// three years; 174 added drive_id and the two missing ON CONFLICT clauses. All
// three live in one file because they are one index, and because the
// interesting risk is the same each time: that fixing it quietly stops it
// deduping at all.
//
// Every `INSERT INTO notifications` in the codebase is a bare
// `ON CONFLICT DO NOTHING` — 22 sites, none naming an inference target — so
// which notifications collapse into one is decided ENTIRELY by that unique
// index. Before 172 it keyed on (recipient, actor, type, article, note,
// comment) with the NULL references COALESCEd to a sentinel, and a grant
// notification sets none of those three: so a writer's SECOND gift to the same
// reader was silently dropped, and `DO NOTHING` did not even reopen the first
// (already-read) row. The one person the offer exists for was never told.
//
// Only Postgres can evaluate this — the index is a unique constraint over
// COALESCE expressions, and a mocked pool.query would be pinning the mock's
// idea of collision rather than the database's. The route-level test
// (subscription-offers-grant.test.ts) pins that offer_id is BOUND; this pins
// what binding it BUYS.
//
// Fixtures live inside a transaction that is ALWAYS rolled back, so the target
// DB is never mutated. Skipped without a DB URL — CI supplies one (it boots Postgres and FAILS on a skip). Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/notification-dedup-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("idx_notifications_dedup", () => {
  let client: pg.Client;
  let writer: string;
  let reader: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    writer = await account("notif-dedup-writer");
    reader = await account("notif-dedup-reader");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function account(slug: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2) RETURNING id`,
      [`fixture-${slug}-${process.hrtime.bigint().toString(16)}`, "fixture-enc"],
    );
    return rows[0].id;
  }

  async function offer(label: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscription_offers
         (writer_id, label, mode, discount_pct, recipient_id, code)
       VALUES ($1, $2, 'grant', 100, $3, $4) RETURNING id`,
      [writer, label, reader, `fixture-${process.hrtime.bigint().toString(16)}`],
    );
    return rows[0].id;
  }

  /** The route's own statement: bare ON CONFLICT DO NOTHING, as every site is. */
  async function notify(offerId: string | null): Promise<number> {
    const res = await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, offer_id)
       VALUES ($1, $2, 'subscription_offer', $3)
       ON CONFLICT DO NOTHING`,
      [reader, writer, offerId],
    );
    return res.rowCount ?? 0;
  }

  it("two gifts from one writer to one reader are two notifications", async () => {
    // Mutant: drop COALESCE(offer_id, …) from idx_notifications_dedup — the
    // second insert returns rowCount 0 and this fails, which is exactly the
    // shipped behaviour before 172.
    expect(await notify(await offer("first gift"))).toBe(1);
    expect(await notify(await offer("second, better gift"))).toBe(1);

    const { rows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications
        WHERE recipient_id = $1 AND type = 'subscription_offer'`,
      [reader],
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(2);
  });

  it("the SAME offer notified twice still collapses to one", async () => {
    // The dedup index is doing real work, not merely disabled by the new
    // column: a redelivery of the same offer must not mint a second row.
    const only = await offer("one gift, delivered twice");
    expect(await notify(only)).toBe(1);
    expect(await notify(only)).toBe(0);
  });

  it("still dedups notification types that carry no offer at all", async () => {
    // The sentinel COALESCE keeps every pre-existing type's behaviour: two
    // offer_id-less rows of the same (recipient, actor, type) remain one.
    // Widening the index must not quietly stop deduping everything else.
    expect(await notify(null)).toBe(1);
    expect(await notify(null)).toBe(0);
  });

  // ===========================================================================
  // Migration 173 — the partial clause.
  //
  // Eight notification types dedup on (recipient, actor, type) alone, carrying
  // no reference column at all: new_follower, new_subscriber, comp_subscription,
  // pub_invite_received, pub_member_joined/left, pub_new_subscriber. Without the
  // partial clause each is ONE NOTIFICATION EVER — a reader who subscribes,
  // cancels and resubscribes is announced to the writer once, for all time.
  // new_follower stands for the set; the index cannot tell them apart.
  // ===========================================================================
  describe("the partial clause (migration 173)", () => {
    /** An actor-only notification, exactly as follows.ts raises it. */
    async function follow(): Promise<number> {
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'new_follower')
         ON CONFLICT DO NOTHING`,
        [writer, reader],
      );
      return res.rowCount ?? 0;
    }

    async function markAllRead(): Promise<void> {
      await client.query(
        `UPDATE notifications SET read = true WHERE recipient_id = $1 AND read = false`,
        [writer],
      );
    }

    it("a repeat event notifies again once the first is read", async () => {
      // Mutant: drop `WHERE read = false` from the index — the second insert
      // returns rowCount 0 and this fails, which is the behaviour that shipped
      // from migration 014 until 173.
      expect(await follow()).toBe(1);
      await markAllRead();
      expect(await follow()).toBe(1);

      const { rows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM notifications
          WHERE recipient_id = $1 AND type = 'new_follower'`,
        [writer],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(2);
    });

    it("but a repeat while the first is still UNREAD collapses", async () => {
      // The ceiling the partial clause buys is "at most one UNREAD per tuple",
      // not "dedup off". A test that only asserted the case above would pass
      // just as well against a dropped index.
      expect(await follow()).toBe(1);
      expect(await follow()).toBe(0);
      expect(await follow()).toBe(0);
    });

    it("reading only the recipient's own rows frees only their slot", async () => {
      // `read` is per row, so the clause must not be readable as a global
      // switch: another recipient's unread notification from the same actor is
      // untouched by this one being read.
      const other = await account("notif-dedup-other");
      await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'new_follower') ON CONFLICT DO NOTHING`,
        [other, reader],
      );
      expect(await follow()).toBe(1);
      await markAllRead(); // marks `writer`'s rows only

      expect(await follow()).toBe(1); // freed
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'new_follower') ON CONFLICT DO NOTHING`,
        [other, reader],
      );
      expect(res.rowCount).toBe(0); // still unread, still held
    });

    it("an actor-less notification never collapses, in either read state", async () => {
      // 173 deliberately did NOT restore migration 019's other change,
      // COALESCE(actor_id, sentinel). `pledge_fulfilled` is the one actor-less
      // type; under that COALESCE a reader would be told ONCE EVER that any
      // drive they backed was fulfilled, across every drive. Bare actor_id
      // leaves NULLs distinct in a unique index, which is what keeps it working.
      //
      // Mutant: wrap actor_id in COALESCE(actor_id, '0000…'::uuid) — the second
      // insert returns 0 and this fails.
      const drive = async () =>
        (
          await client.query(
            `INSERT INTO notifications (recipient_id, type)
             VALUES ($1, 'pledge_fulfilled') ON CONFLICT DO NOTHING`,
            [reader],
          )
        ).rowCount ?? 0;

      expect(await drive()).toBe(1);
      expect(await drive()).toBe(1);
    });
  });

  // ===========================================================================
  // Migration 174 — drive_id, and the two inserts that had no ON CONFLICT.
  //
  // `drive_funded` and `commission_request` were the only two INSERT INTO
  // notifications in the codebase with no conflict clause at all, so a dedup
  // collision raised 23505 instead of doing nothing — and `drive_funded`'s runs
  // inside the pledge transaction, so it aborted the pledge. Fixing the clause
  // alone would only have traded a crash for a silent drop, because the index
  // carried no drive reference: to it, two DIFFERENT drives between the same
  // two people were the same notification. Both halves are pinned here.
  // ===========================================================================
  describe("drive notifications (migration 174)", () => {
    async function drive(title: string): Promise<string> {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pledge_drives (creator_id, origin, target_writer_id, title)
         VALUES ($1, 'commission', $2, $3) RETURNING id`,
        [reader, writer, title],
      );
      return rows[0].id;
    }

    /** The pledge route's own statement, verbatim. */
    async function funded(driveId: string): Promise<number> {
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, drive_id)
         VALUES ($1, $2, 'drive_funded', $3)
         ON CONFLICT DO NOTHING`,
        [writer, reader, driveId],
      );
      return res.rowCount ?? 0;
    }

    it("two drives between the same two people are two notifications", async () => {
      // Mutant: drop COALESCE(drive_id, …) from idx_notifications_dedup — the
      // second insert returns 0, which is the silent drop that adding ON
      // CONFLICT without the column would have shipped.
      expect(await funded(await drive("first drive"))).toBe(1);
      expect(await funded(await drive("second drive"))).toBe(1);

      const { rows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM notifications
          WHERE recipient_id = $1 AND type = 'drive_funded'`,
        [writer],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(2);
    });

    it("a repeat on the SAME drive does not poison the pledge transaction", async () => {
      // THE defect, and the reason this file is DB-backed. Without the clause
      // the second insert raises 23505; inside `withTransaction` that aborts
      // the pledge, so the money never moves and the pledger sees a 500 — from
      // a notification. Postgres puts an aborted transaction into 25P02 for
      // every later statement, so a statement that still works after the repeat
      // IS the proof the transaction survived.
      const only = await drive("one drive, funded twice");
      expect(await funded(only)).toBe(1);
      expect(await funded(only)).toBe(0); // no-op, not a throw

      const after = await client.query(
        `UPDATE pledge_drives SET current_total_pence = 500 WHERE id = $1`,
        [only],
      );
      expect(after.rowCount).toBe(1); // 25P02 here would mean the pledge died
    });

    it("commission_request binds its drive too", async () => {
      // Same shape, the other insert. Two commission requests from the same
      // person are two requests; the route must be able to say which.
      const send = async (driveId: string) =>
        (
          await client.query(
            `INSERT INTO notifications (recipient_id, actor_id, type, drive_id)
             VALUES ($1, $2, 'commission_request', $3)
             ON CONFLICT DO NOTHING`,
            [writer, reader, driveId],
          )
        ).rowCount ?? 0;

      expect(await send(await drive("commission one"))).toBe(1);
      expect(await send(await drive("commission two"))).toBe(1);
    });

    it("a deleted drive nulls its notification rather than removing it", async () => {
      // ON DELETE SET NULL, deliberately NOT the offer's CASCADE: "a pledge
      // drive you backed was published" still reads sensibly without the drive,
      // and the destination is a list either way.
      const doomed = await drive("about to be deleted");
      await funded(doomed);
      await client.query(`DELETE FROM pledge_drives WHERE id = $1`, [doomed]);

      const { rows } = await client.query<{ cnt: string; drive_id: string | null }>(
        `SELECT COUNT(*) AS cnt, MIN(drive_id::text) AS drive_id
           FROM notifications WHERE recipient_id = $1 AND type = 'drive_funded'`,
        [writer],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(1);
      expect(rows[0].drive_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Migration 198 — publication_id, and the pub_* family that bound nothing.
  //
  // Six types bound only (recipient, actor), so the dedup index could not tell
  // two PUBLICATIONS apart. The one that hurts most is `pub_invite_received`:
  // an invitation is a thing you accept, and a second publication inviting the
  // same person from the same inviter was silently dropped.
  // ---------------------------------------------------------------------------
  describe("publication_id (migration 198)", () => {
    async function publication(slug: string): Promise<string> {
      const uniq = process.hrtime.bigint().toString(16);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
         VALUES ($1, $2, $3, 'fixture-enc') RETURNING id`,
        [`fixture-${slug}-${uniq}`, slug, `fixture-pub-${uniq}`],
      );
      return rows[0].id;
    }

    /** The route's own statement shape: bare ON CONFLICT DO NOTHING. */
    async function invite(publicationId: string | null): Promise<number> {
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, publication_id)
         VALUES ($1, $2, 'pub_invite_received', $3)
         ON CONFLICT DO NOTHING`,
        [reader, writer, publicationId],
      );
      return res.rowCount ?? 0;
    }

    it("two publications inviting one person are two notifications", async () => {
      // Mutant: drop COALESCE(publication_id, …) from the index — the second
      // insert returns 0 and this fails, which is the shipped behaviour before
      // 198 and the reason the second invitation was never seen.
      expect(await invite(await publication("first-paper"))).toBe(1);
      expect(await invite(await publication("second-paper"))).toBe(1);

      const { rows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM notifications
          WHERE recipient_id = $1 AND type = 'pub_invite_received'`,
        [reader],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(2);
    });

    it("the SAME publication inviting twice still collapses to one", async () => {
      // The index is doing real work rather than being disabled by the new
      // column — the failure mode that "fixing" a dedup index usually has.
      const only = await publication("one-paper");
      expect(await invite(only)).toBe(1);
      expect(await invite(only)).toBe(0);
    });

    it("still dedups a pub_* row that carries no publication at all", async () => {
      // The sentinel COALESCE keeps the pre-198 behaviour for any row written
      // by an older process mid-deploy: two publication-less rows of one
      // (recipient, actor, type) remain one.
      expect(await invite(null)).toBe(1);
      expect(await invite(null)).toBe(0);
    });

    it("a hard-deleted publication leaves its notification standing", async () => {
      // ON DELETE SET NULL, matching drive_id and NOT the offer/article
      // columns: "you were invited to a publication that has since gone" still
      // reads sensibly, and a notification list that silently loses rows is
      // worse than one holding a dangling reference.
      const doomed = await publication("about-to-go");
      await invite(doomed);
      await client.query(`DELETE FROM publications WHERE id = $1`, [doomed]);

      const { rows } = await client.query<{ cnt: string; publication_id: string | null }>(
        `SELECT COUNT(*) AS cnt, MIN(publication_id::text) AS publication_id
           FROM notifications WHERE recipient_id = $1 AND type = 'pub_invite_received'`,
        [reader],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(1);
      expect(rows[0].publication_id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Migration 198's other half — `new_mention` binds the COMMENT it is in.
  //
  // The column was already in the index; only the insert was missing it. Bound
  // to the article alone, two mentions of the same person by the same author in
  // two different comments on ONE article were a single notification.
  // ---------------------------------------------------------------------------
  describe("new_mention binds its comment", () => {
    async function article(slug: string): Promise<string> {
      const uniq = process.hrtime.bigint().toString(16);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, content_free)
         VALUES ($1, $2, $3, $4, $3, '') RETURNING id`,
        [writer, `fixture-ev-${uniq}`, `fixture-${slug}-${uniq}`, slug],
      );
      return rows[0].id;
    }

    async function comment(): Promise<string> {
      const uniq = process.hrtime.bigint().toString(16);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO comments (author_id, target_event_id, target_kind, content, nostr_event_id, published_at)
         VALUES ($1, $2, 30023, 'hello @someone', $3, now()) RETURNING id`,
        [writer, `fixture-target-${uniq}`, `fixture-cev-${uniq}`],
      );
      return rows[0].id;
    }

    async function mention(articleId: string, commentId: string | null): Promise<number> {
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id, comment_id)
         VALUES ($1, $2, 'new_mention', $3, NULL, $4)
         ON CONFLICT DO NOTHING`,
        [reader, writer, articleId, commentId],
      );
      return res.rowCount ?? 0;
    }

    it("two mentions in two comments on ONE article are two notifications", async () => {
      const piece = await article("one-piece");
      expect(await mention(piece, await comment())).toBe(1);
      expect(await mention(piece, await comment())).toBe(1);
    });

    it("the same comment notified twice still collapses to one", async () => {
      const piece = await article("another-piece");
      const only = await comment();
      expect(await mention(piece, only)).toBe(1);
      expect(await mention(piece, only)).toBe(0);
    });
  });

  // ===========================================================================
  // Migration 230 — the two people one nested reply is about.
  //
  // `POST /replies` now writes TWO rows for a reply to a comment: one to the
  // parent comment's author ("replied to your comment") and one to the root's
  // author ("replied to <the piece>"). They share actor, type, article and
  // `comment_id` — on both, `comment_id` is the NEW reply — so what keeps them
  // apart is `recipient_id`, which the index has always carried. That is the
  // claim the route is built on and only Postgres can settle it.
  //
  // `parent_comment_id` is deliberately NOT in the index, and the second test
  // is why that is safe rather than merely untested.
  // ===========================================================================
  describe("a nested reply's two recipients (migration 230)", () => {
    let third: string;
    beforeEach(async () => {
      third = await account("notif-dedup-third");
    });

    async function replyComment(): Promise<string> {
      const uniq = process.hrtime.bigint().toString(16);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO comments (author_id, target_event_id, target_kind, content, nostr_event_id, published_at)
         VALUES ($1, $2, 30023, 'a remark', $3, now()) RETURNING id`,
        [third, `fixture-root-${uniq}`, `fixture-rev-${uniq}`],
      );
      return rows[0].id;
    }

    /** The route's own statement, both rows. */
    async function replyNotify(
      recipient: string,
      newReply: string,
      parent: string | null,
    ): Promise<number> {
      const res = await client.query(
        `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id, comment_id, parent_comment_id)
         VALUES ($1, $2, 'new_reply', NULL, NULL, $3, $4)
         ON CONFLICT DO NOTHING`,
        [recipient, third, newReply, parent],
      );
      return res.rowCount ?? 0;
    }

    it("both people are told, and neither row eats the other", async () => {
      const newReply = await replyComment();
      // Mutant: make the route send one row instead of two, or drop
      // recipient_id from the index, and this is what fails.
      expect(await replyNotify(writer, newReply, null)).toBe(1);
      expect(await replyNotify(reader, newReply, newReply)).toBe(1);

      const { rows } = await client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM notifications
          WHERE comment_id = $1 AND type = 'new_reply'`,
        [newReply],
      );
      expect(parseInt(rows[0].cnt, 10)).toBe(2);
    });

    it("the SAME row redelivered still collapses, parent bound or not", async () => {
      // Leaving parent_comment_id out of the index is only safe if the rest of
      // the tuple still identifies a notification. It does: comment_id is the
      // new reply, one per reply per recipient. A test that only checked the
      // two rows coexist would pass against an index that had stopped deduping.
      const newReply = await replyComment();
      expect(await replyNotify(reader, newReply, newReply)).toBe(1);
      expect(await replyNotify(reader, newReply, newReply)).toBe(0);
      expect(await replyNotify(writer, newReply, null)).toBe(1);
      expect(await replyNotify(writer, newReply, null)).toBe(0);
    });

    it("deleting the PARENT keeps the notification and nulls the pointer", async () => {
      // ON DELETE SET NULL, unlike comment_id's CASCADE beside it: the parent
      // going away does not take the reply, so the row survives and degrades
      // to the root's sentence rather than vanishing from the log.
      const parent = await replyComment();
      const newReply = await replyComment();
      await replyNotify(reader, newReply, parent);
      await client.query(`DELETE FROM comments WHERE id = $1`, [parent]);

      const { rows } = await client.query<{ parent_comment_id: string | null }>(
        `SELECT parent_comment_id FROM notifications WHERE comment_id = $1`,
        [newReply],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].parent_comment_id).toBeNull();
    });
  });

  it("a hard-deleted offer takes its notification with it", async () => {
    // ON DELETE CASCADE, matching the other reference columns: offers are
    // normally revoked (soft), so this only fires on a genuine delete, where a
    // notification pointing at a row that is gone is worse than none.
    const doomed = await offer("about to be deleted");
    await notify(doomed);
    await client.query(`DELETE FROM subscription_offers WHERE id = $1`, [doomed]);

    const { rows } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE offer_id = $1`,
      [doomed],
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(0);
  });
});
