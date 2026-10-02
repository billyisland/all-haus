import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// Resubscribing, against Postgres: a paid-up cancellation is RESTORED and not
// re-sold, a concurrent press is refused rather than charged twice, an offer's
// cap holds under concurrency, and nothing is announced before COMMIT
// (CA-A2, CA-A3, CA-B7 — 2026-09-29).
//
// WHY DB-BACKED. Three of the four claims are about what Postgres does with
// a lock: `SELECT … FOR UPDATE` re-reading the row AS COMMITTED after the
// transaction it waited on, a guarded `UPDATE … WHERE redemption_count <
// max_redemptions` re-evaluated on the locked row, and a `paid_up` predicate
// computed against the database's own `now()`. A text-keyed mock answers
// whatever the fixture holds and cannot tell a lock from a comment. The fourth
// (after-commit side effects) is asserted by reading the row from a SEPARATE
// connection at the moment the email is sent: before the fix it saw the old
// status, because the send fired inside the callback.
//
// THE INTERLEAVING IS FORCED, not hoped for: a fixture connection holds the
// row lock in an open transaction, both requests are fired and are observed
// (via pg_locks) to be WAITING on it, and only then is it released — so both
// have passed every unlocked read and are queued on the write. That is the
// double-click the button allows (it disables only after the first press's
// state update lands).
//
// THE CHARGE IS A RECORDER, DELIBERATELY. `ledger_entries` is append-only at
// the database (a DELETE raises), so a charge that COMMITS here could never be
// cleaned up; `logSubscriptionCharge` is therefore replaced with a function
// that counts its calls, and "charged once" is asserted on that count. The
// function itself is proved in subscription-charge-ledger.test.ts; the arm
// that decides whether to call it is what this file is about.
//
// MUTATION LOG (each applied to src/, the suite re-run, reverted):
//   A. drop `FOR UPDATE` from the existing-row read AND `status <> 'active'`
//      from the reactivation UPDATE ⇒ "pressed together on an expired row"
//      fails: two 200s, two charges.                                  DETECTED
//   B. drop the cap predicate from the redemption increment ⇒ "the last
//      redemption pressed by two readers" fails: two 201s, count 2.   DETECTED
//   C. force `paidUp` false (the restore arm unreachable) ⇒ "inside the
//      paid-up period" fails: a charge, the period re-anchored.       DETECTED
//   D. move the notification + emails back inside the callback ⇒ "fires
//      only after COMMIT" fails: the separate connection saw `expired`
//      when the email went; "enqueue failure" fails: an email went.  DETECTED
//
// Skipped without a DB URL — CI supplies one and FAILS on a skip. Locally, BOTH
// vars (the fixtures use their own client; the route uses the shared pool,
// which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/resubscribe-race.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

// The session is the `x-reader` header: two readers can press at once.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { headers: Record<string, unknown>; session?: unknown }) => {
    const sub = String(req.headers["x-reader"] ?? "");
    req.session = { sub, pubkey: "a".repeat(64) };
  },
  optionalAuth: async () => {},
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const signCalls: Array<{ periodStart: Date; periodEnd: Date; pricePence: number; status: string }> = [];
vi.mock("../src/lib/nostr-publisher.js", () => ({
  signSubscriptionEvent: (p: {
    periodStart: Date;
    periodEnd: Date;
    pricePence: number;
    status: string;
  }) => {
    signCalls.push({ periodStart: p.periodStart, periodEnd: p.periodEnd, pricePence: p.pricePence, status: p.status });
    return { id: randHex(), kind: 7003 };
  },
}));

let enqueueThrows = false;
const enqueueClients: unknown[] = [];
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: async (client: unknown) => {
    enqueueClients.push(client);
    if (enqueueThrows) throw new Error("relay_outbox unavailable");
    return { id: randHex() };
  },
}));

// Each email records the subscription's status AS SEEN FROM A SEPARATE
// CONNECTION at the moment of the call — committed, or not yet.
let observe: (() => Promise<string | null>) | null = null;
const newSubscriberSeen: Array<string | null> = [];
const welcomeSeen: Array<string | null> = [];
vi.mock("@platform-pub/shared/lib/subscription-emails.js", () => ({
  sendSubscriptionCancelledEmail: async () => {},
  sendNewSubscriberEmail: async () => {
    newSubscriberSeen.push(observe ? await observe() : null);
  },
  sendSubscriptionWelcomeEmail: async () => {
    welcomeSeen.push(observe ? await observe() : null);
  },
}));

const chargeCalls: Array<unknown[]> = [];
vi.mock("../src/routes/subscriptions/shared.js", () => ({
  logSubscriptionCharge: async (...args: unknown[]) => {
    chargeCalls.push(args);
  },
}));

const { subscriptionWriterRoutes } = await import("../src/routes/subscriptions/writer.js");
const { pool } = await import("@platform-pub/shared/db/client.js");
const { READER_TERMS_VERSION } = await import("@platform-pub/shared/lib/terms-versions.js");

describe.skipIf(!DB_URL)("POST /subscriptions/:writerId — resubscribing, against Postgres", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const stamp = Date.now().toString(36);
  let writer = "";
  let reader = "";
  let reader2 = "";
  const accounts: string[] = [];

  async function build() {
    const a = Fastify();
    await a.register(subscriptionWriterRoutes);
    return a;
  }

  const mkAccount = async (name: string, over: Record<string, unknown> = {}) => {
    const cols = {
      username: `rs-${name}-${stamp}`,
      nostr_pubkey: `${name}${stamp}`.padEnd(64, "0").slice(0, 64),
      nostr_privkey_enc: "x",
      subscription_price_pence: 500,
      // Every account here may be sold to (READER-WRITER-SPLIT-ADR §5).
      writer_admitted_at: new Date(),
      ...over,
    };
    const keys = Object.keys(cols);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (${keys.join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      keys.map((k) => (cols as Record<string, unknown>)[k]),
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  };

  /** A subscription row in the given state; dates relative to now. */
  const seedSub = async (
    readerId: string,
    over: Partial<{
      status: string;
      autoRenew: boolean;
      isComp: boolean;
      pricePence: number;
      startDays: number;
      endDays: number;
      cancelled: boolean;
    }> = {},
  ) => {
    const o = {
      status: "cancelled",
      autoRenew: false,
      isComp: false,
      pricePence: 500,
      startDays: -5,
      endDays: 25,
      cancelled: true,
      ...over,
    };
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscriptions
         (reader_id, writer_id, price_pence, status, auto_renew, is_comp,
          current_period_start, current_period_end, subscription_period,
          period_anchor_day, cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               now() + ($7 || ' days')::interval, now() + ($8 || ' days')::interval,
               'monthly', 7, CASE WHEN $9 THEN now() ELSE NULL END)
       RETURNING id`,
      [readerId, writer, o.pricePence, o.status, o.autoRenew, o.isComp,
       String(o.startDays), String(o.endDays), o.cancelled],
    );
    return rows[0].id;
  };

  const subRow = (id: string) =>
    client
      .query<{
        status: string;
        auto_renew: boolean;
        cancelled_at: Date | null;
        price_pence: number;
        current_period_start: Date;
        current_period_end: Date;
        nostr_event_id: string | null;
      }>(
        `SELECT status, auto_renew, cancelled_at, price_pence,
                current_period_start, current_period_end, nostr_event_id
         FROM subscriptions WHERE id = $1`,
        [id],
      )
      .then((r) => r.rows[0]);

  const eventsFor = (id: string) =>
    client
      .query(`SELECT 1 FROM subscription_events WHERE subscription_id = $1`, [id])
      .then((r) => r.rowCount ?? 0);

  const notificationsFor = (recipient: string) =>
    client
      .query(
        `SELECT 1 FROM notifications WHERE recipient_id = $1 AND type = 'new_subscriber'`,
        [recipient],
      )
      .then((r) => r.rowCount ?? 0);

  // Both requests must be WAITING on the fixture's lock before it is released.
  const waitForBlocked = async (n: number) => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'tuple'
         UNION ALL
         SELECT count(*) FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'`,
      );
      const blocked = rows.reduce((s, r) => s + Number(r.n), 0);
      if (blocked >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${n} sessions blocked on the fixture lock`);
  };

  const post = (
    readerId: string,
    payload: object = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/subscriptions/${writer}`,
      headers: { "x-reader": readerId },
      payload,
    });

  // The fire-and-forget notification lands a beat after the response. A fixed
  // beat is right where the assertion is that NOTHING arrives (a late arrival
  // can only make that pass). Where something MUST arrive, `until` polls for
  // it under a bound instead: each email reads the row from a second
  // connection, and under a loaded full run 60ms was sometimes not enough —
  // a red that taught people to re-run rather than read.
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const until = async (done: () => Promise<boolean>, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!(await done()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    writer = await mkAccount("writer");
    const readerCols = (name: string) => ({
      stripe_customer_id: `cus_rs_${name}_${stamp}`,
      reader_terms_version: READER_TERMS_VERSION,
      reader_terms_accepted_at: new Date(),
    });
    reader = await mkAccount("reader", readerCols("reader"));
    reader2 = await mkAccount("reader2", readerCols("reader2"));
    observe = async () => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM subscriptions WHERE reader_id = $1 AND writer_id = $2`,
        [reader, writer],
      );
      return rows[0]?.status ?? null;
    };
  });

  afterAll(async () => {
    await client.query(`DELETE FROM subscriptions WHERE writer_id = $1`, [writer]);
    await client.query(`DELETE FROM subscription_offers WHERE writer_id = $1`, [writer]);
    for (const id of accounts) {
      await client.query(`DELETE FROM accounts WHERE id = $1`, [id]);
    }
    await client.end();
    await pool.end();
  });

  beforeEach(async () => {
    app = await build();
    signCalls.length = 0;
    enqueueClients.length = 0;
    chargeCalls.length = 0;
    newSubscriberSeen.length = 0;
    welcomeSeen.length = 0;
    enqueueThrows = false;
  });

  afterEach(async () => {
    await app.close();
    await client.query(`DELETE FROM notifications WHERE recipient_id = $1`, [writer]);
    await client.query(`DELETE FROM subscriptions WHERE writer_id = $1`, [writer]);
    await client.query(`DELETE FROM subscription_offers WHERE writer_id = $1`, [writer]);
  });

  // ---------------------------------------------------------------------------
  // CA-A2 — the restore arm
  // ---------------------------------------------------------------------------

  it("inside the paid-up period: restored, nothing charged, the period untouched", async () => {
    const id = await seedSub(reader);
    const before = await subRow(id);

    const res = await post(reader, { period: "monthly" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subscriptionId: id,
      status: "active",
      restored: true,
      pricePence: 500,
      isComp: false,
      period: "monthly",
      currentPeriodEnd: before.current_period_end.toISOString(),
    });

    const after = await subRow(id);
    expect(after.status).toBe("active");
    expect(after.auto_renew).toBe(true);
    expect(after.cancelled_at).toBeNull();
    expect(after.price_pence).toBe(500);
    expect(after.current_period_start.getTime()).toBe(before.current_period_start.getTime());
    expect(after.current_period_end.getTime()).toBe(before.current_period_end.getTime());

    expect(chargeCalls).toHaveLength(0);
    expect(await eventsFor(id)).toBe(0);

    // The attestation is re-signed with the EXISTING dates and price.
    expect(signCalls).toHaveLength(1);
    expect(signCalls[0].status).toBe("active");
    expect(signCalls[0].pricePence).toBe(500);
    expect(signCalls[0].periodStart.getTime()).toBe(before.current_period_start.getTime());
    expect(signCalls[0].periodEnd.getTime()).toBe(before.current_period_end.getTime());
    expect(after.nostr_event_id).not.toBe(before.nostr_event_id);
    // …and enqueued on the transaction's client, never the pool.
    expect(enqueueClients).toHaveLength(1);
    expect(enqueueClients[0]).not.toBe(pool);

    // The writer never lost this subscriber: nothing announced.
    await settle();
    expect(newSubscriberSeen).toHaveLength(0);
    expect(welcomeSeen).toHaveLength(0);
    expect(await notificationsFor(writer)).toBe(0);
  });

  it("a restored comp stays non-renewing", async () => {
    const id = await seedSub(reader, { isComp: true, pricePence: 0 });
    const res = await post(reader);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restored: true, isComp: true, pricePence: 0 });
    const after = await subRow(id);
    expect(after.status).toBe("active");
    expect(after.auto_renew).toBe(false);
    expect(chargeCalls).toHaveLength(0);
  });

  it("an offer code against a paid-up row is refused and nothing is spent", async () => {
    const id = await seedSub(reader);
    const { rows: [offer] } = await client.query<{ id: string }>(
      `INSERT INTO subscription_offers (writer_id, label, mode, discount_pct, code, max_redemptions)
       VALUES ($1, 'half', 'code', 50, $2, 1) RETURNING id`,
      [writer, `half-${stamp}`],
    );

    const res = await post(reader, { offerCode: `half-${stamp}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "subscription_paid_up" });

    const { rows } = await client.query<{ redemption_count: number }>(
      `SELECT redemption_count FROM subscription_offers WHERE id = $1`,
      [offer.id],
    );
    expect(rows[0].redemption_count).toBe(0);
    const after = await subRow(id);
    expect(after.status).toBe("cancelled");
    expect(chargeCalls).toHaveLength(0);
    expect(signCalls).toHaveLength(0);
  });

  it("CONTROL — cancelled but past its period end: re-activated and charged, re-anchored on today", async () => {
    const id = await seedSub(reader, { startDays: -40, endDays: -10 });
    const before = await subRow(id);

    const res = await post(reader, { period: "monthly" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subscriptionId: id, restored: false, pricePence: 500 });

    const after = await subRow(id);
    expect(after.status).toBe("active");
    expect(after.current_period_start.getTime()).toBeGreaterThan(before.current_period_end.getTime());
    expect(after.current_period_end.getTime()).toBeGreaterThan(Date.now());
    expect(chargeCalls).toHaveLength(1);
    expect(chargeCalls[0][1]).toBe(id);
    expect(chargeCalls[0][4]).toBe(500);
  });

  // ---------------------------------------------------------------------------
  // CA-A3 — the two concurrency orderings, FORCED
  // ---------------------------------------------------------------------------

  it("pressed together on an expired row: one is charged, the other is told it is already subscribed", async () => {
    const id = await seedSub(reader, { status: "expired", startDays: -60, endDays: -30, cancelled: false });

    await client.query("BEGIN");
    await client.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [id]);
    const first = post(reader, { period: "monthly" });
    const second = post(reader, { period: "monthly" });
    await waitForBlocked(2);
    await client.query("COMMIT");

    const [a, b] = await Promise.all([first, second]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    expect(chargeCalls).toHaveLength(1);
    expect(signCalls).toHaveLength(1);
    const after = await subRow(id);
    expect(after.status).toBe("active");
  });

  it("pressed together inside the paid-up period: one restores, the other is refused, nothing charged", async () => {
    const id = await seedSub(reader);

    await client.query("BEGIN");
    await client.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [id]);
    const first = post(reader);
    const second = post(reader);
    await waitForBlocked(2);
    await client.query("COMMIT");

    const [a, b] = await Promise.all([first, second]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(chargeCalls).toHaveLength(0);
    expect(signCalls).toHaveLength(1);
  });

  it("the last redemption pressed by two readers: one subscription, the cap holds", async () => {
    const code = `last-${stamp}`;
    const { rows: [offer] } = await client.query<{ id: string }>(
      `INSERT INTO subscription_offers (writer_id, label, mode, discount_pct, code, max_redemptions)
       VALUES ($1, 'last one', 'code', 50, $2, 1) RETURNING id`,
      [writer, code],
    );

    await client.query("BEGIN");
    await client.query(`SELECT id FROM subscription_offers WHERE id = $1 FOR UPDATE`, [offer.id]);
    const first = post(reader, { offerCode: code });
    const second = post(reader2, { offerCode: code });
    await waitForBlocked(2);
    await client.query("COMMIT");

    const [a, b] = await Promise.all([first, second]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 410]);

    const { rows } = await client.query<{ redemption_count: number }>(
      `SELECT redemption_count FROM subscription_offers WHERE id = $1`,
      [offer.id],
    );
    expect(rows[0].redemption_count).toBe(1);
    const subs = await client.query(`SELECT reader_id FROM subscriptions WHERE writer_id = $1`, [writer]);
    expect(subs.rowCount).toBe(1);
    expect(chargeCalls).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // CA-B7 — nothing is announced before COMMIT
  // ---------------------------------------------------------------------------

  it("the writer's notice and both emails fire only after the row is committed", async () => {
    const id = await seedSub(reader, { status: "expired", startDays: -60, endDays: -30, cancelled: false });

    const res = await post(reader);
    expect(res.statusCode).toBe(200);
    await until(
      async () =>
        newSubscriberSeen.length > 0 &&
        welcomeSeen.length > 0 &&
        (await notificationsFor(writer)) > 0,
    );

    // Each email read the row from a SEPARATE connection when it was sent:
    // `active` means the transaction had committed by then.
    expect(newSubscriberSeen).toEqual(["active"]);
    expect(welcomeSeen).toEqual(["active"]);
    expect(await notificationsFor(writer)).toBe(1);
    expect((await subRow(id)).status).toBe("active");
  });

  it("an enqueue failure after the charge: 500, the row untouched, no notice, no email", async () => {
    const id = await seedSub(reader, { status: "expired", startDays: -60, endDays: -30, cancelled: false });
    enqueueThrows = true;

    const res = await post(reader);
    expect(res.statusCode).toBe(500);
    await settle();

    const after = await subRow(id);
    expect(after.status).toBe("expired");
    expect(after.cancelled_at).toBeNull();
    expect(newSubscriberSeen).toHaveLength(0);
    expect(welcomeSeen).toHaveLength(0);
    expect(await notificationsFor(writer)).toBe(0);
  });
});
