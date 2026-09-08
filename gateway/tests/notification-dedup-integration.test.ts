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
