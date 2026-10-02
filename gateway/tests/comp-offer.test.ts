import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A COMP IS AN OFFER (MIRROR-AUDIT §2.12, S8; migration 193).
//
// WHAT WAS WRONG. `POST /subscriptions/:readerId/comp` INSERTed an `active`
// subscription row for any account, from any account, with no consent step of
// any kind — notify_on_publish TRUE (so publish-emails mailed the victim on
// every publish) and hidden FALSE (so the writer appeared on the victim's
// public profile). The only check on the reader was `status = 'active'`, which
// says the ACCOUNT is live and nothing at all about whether its owner agreed.
//
// THE OFFER HALF IS RETIRED (CA-I5, 2026-09-30): the writer's comp routes had
// no caller and were deleted, and with them this file's case (1) below. The
// redemption half stays, because a comp offer is still redeemed through the
// ordinary subscribe route. Revive the routes and restore case (1) with them.
//
// WHAT IS UNDER TEST. Two halves, and each has one assertion that survives a
// plausible wrong fix:
//
//   (1) The offer half asserts NO `INSERT INTO subscriptions` ran. A route that
//       minted the offer AND kept writing the row would answer 201 with an
//       offer id and plausible JSON — a status-code assertion passes against
//       exactly the defect this closes. Same shape as the export step-up test
//       asserting whether the key was fetched.
//
//   (2) The redemption half asserts WHETHER THE CHARGE WAS POSTED and whether
//       the card gate was reached. The comp carve-out on the collection gate is
//       the one new hole in a money path here, so the paired NON-comp offer
//       case is the control: it must still 402 without a card. A suite whose
//       only fixture is a comp goes green against a route that dropped the card
//       gate entirely.
//
// Mutation-proved: put the subscriptions INSERT back in the comp route and (1)
// goes red; drop the `if (!isComp)` from the card gate and the control goes
// red; drop it from `logSubscriptionCharge` and the comp case does.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const READER = "00000000-0000-4000-8000-0000000000b2";
const STRANGER = "00000000-0000-4000-8000-0000000000c3";

const COMP_CODE = "comp-code-1";
const DISCOUNT_CODE = "half-price-1";

let calls: Array<{ sql: string; params: unknown[] }> = [];
let chargeCalls: Array<unknown[]> = [];
let blocks: Array<[string, string]> = [];
let readerHasCard = false;
/** A terminal decline has flagged the reader's card (settlement backs off). */
let readerCardFlagged = false;
let activeSub: string | null = null;
let existingSubStatus: string | null = null;
let session = WRITER;
/** Set by a case that wants the outstanding-offer unique index to fire. */
let insertOfferConflicts = false;

function ran(fragment: string): boolean {
  return calls.some((c) => c.sql.includes(fragment));
}
function callFor(fragment: string) {
  return calls.find((c) => c.sql.includes(fragment));
}

// The mock answers FROM THE SQL IT IS HANDED and hands out copies of its rows.
function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });

  // The comp route's reader lookup and the subscribe route's writer lookup are
  // both `FROM accounts WHERE id = $1 AND status = 'active'`, differing only in
  // their projection — the shape the house rule names, so they are told apart by
  // the column list AND answered from params[0], never from the text alone.
  if (
    sql.includes("FROM accounts") &&
    sql.includes("status = 'active'") &&
    sql.includes("subscription_price_pence")
  ) {
    return params[0] === WRITER
      ? Promise.resolve({
          rows: [
            {
              id: WRITER,
              subscription_price_pence: 500,
              annual_discount_pct: 15,
              display_name: "W",
              username: "writer",
              nostr_pubkey: "f".repeat(64),
              // §0z item 10's withdrawal stamp. EXPLICITLY NULL, never absent:
              // the route asks `!== null`, so a row that simply lacks the
              // column reads as WITHDRAWN and every non-comp control here 403s
              // `not_for_sale` — which is what happened the day the stamp
              // landed. An absent column and a null one are the same `undefined`
              // in a mock and opposite facts to the route.
              paid_access_withdrawn_at: null,
            },
          ],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM accounts WHERE id = $1 AND status = 'active'")) {
    return params[0] === READER
      ? Promise.resolve({
          rows: [{ id: READER, username: "reader" }],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("FROM blocks")) {
    // The route passes [writerId, readerId] and asks in both directions, so the
    // fixture is checked both ways here too — otherwise the test would pin only
    // the arm it happened to write.
    const [a, b] = params as [string, string];
    const hit = blocks.some(
      ([blocker, blocked]) =>
        (blocker === a && blocked === b) || (blocker === b && blocked === a),
    );
    return Promise.resolve({ rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 });
  }

  if (sql.includes("FROM subscriptions") && sql.includes("status = 'active'")) {
    return activeSub
      ? Promise.resolve({ rows: [{}], rowCount: 1 })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("INSERT INTO subscription_offers")) {
    if (insertOfferConflicts) {
      return Promise.reject(Object.assign(new Error("duplicate"), { code: "23505" }));
    }
    return Promise.resolve({
      rows: [{ id: "offer-1", code: "minted-code" }],
      rowCount: 1,
    });
  }
  if (
    sql.includes("SELECT id, code FROM subscription_offers") &&
    sql.includes("is_comp")
  ) {
    return Promise.resolve({
      rows: [{ id: "offer-existing", code: "existing-code" }],
      rowCount: 1,
    });
  }

  // --- the subscribe side -----------------------------------------------------
  // The Reader Terms read (`terms-gate.ts`) also names stripe_customer_id, so
  // it is told apart by its projection and answered as CURRENT: this file is
  // about the comp carve-out, and its non-comp control must reach the charge
  // for the right reason rather than through an undefined `has_card`. The
  // refusal itself is `subscription-terms-gate.test.ts`.
  if (sql.includes("reader_terms_version") && sql.includes("has_card")) {
    return Promise.resolve({
      rows: [{ has_card: readerHasCard, reader_terms_version: READER_TERMS_VERSION }],
      rowCount: 1,
    });
  }
  if (sql.includes("stripe_customer_id")) {
    return Promise.resolve({
      rows: [
        {
          stripe_customer_id: readerHasCard ? "cus_1" : null,
          // Reader Terms 6.1 — the collection gate asks two questions of the
          // same row now: is there a card, and does it work.
          card_action_required_at: readerCardFlagged ? new Date() : null,
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM subscription_offers") && sql.includes("code = $1")) {
    if (params[0] === COMP_CODE) {
      return Promise.resolve({
        rows: [
          {
            id: "offer-comp",
            mode: "grant",
            discount_pct: 100,
            duration_months: null,
            max_redemptions: 1,
            redemption_count: 0,
            expires_at: null,
            recipient_id: READER,
            is_comp: true,
          },
        ],
        rowCount: 1,
      });
    }
    if (params[0] === DISCOUNT_CODE) {
      return Promise.resolve({
        rows: [
          {
            id: "offer-discount",
            mode: "grant",
            discount_pct: 100,
            duration_months: 3,
            max_redemptions: 1,
            redemption_count: 0,
            expires_at: null,
            recipient_id: READER,
            is_comp: false,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (
    sql.includes("SELECT id, status FROM subscriptions") ||
    (sql.includes("FROM subscriptions") && sql.includes("reader_id = $1"))
  ) {
    // The locked read (CA-A3): `paid_up` is computed in SQL, so the fixture
    // answers it the way Postgres would for a row this far past its period —
    // an `expired` row is never paid up. The restore arm is DB-backed
    // (resubscribe-race.test.ts); this file exercises the charging arms.
    return existingSubStatus
      ? Promise.resolve({
          rows: [{
            id: "sub-old",
            status: existingSubStatus,
            paid_up: false,
            price_pence: 500,
            subscription_period: "monthly",
            current_period_start: new Date("2026-01-01T00:00:00Z"),
            current_period_end: new Date("2026-02-01T00:00:00Z"),
            is_comp: false,
          }],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO subscriptions")) {
    return Promise.resolve({ rows: [{ id: "sub-new" }], rowCount: 1 });
  }
  // The guarded writes: the redemption increment carries the offer's cap in
  // its WHERE and the reactivation carries `status <> 'active'`; both answer
  // one row here, as they do on an uncontended row.
  if (sql.includes("redemption_count = redemption_count + 1")) {
    return Promise.resolve({ rows: [{ id: "offer-comp" }], rowCount: 1 });
  }
  if (sql.includes("UPDATE subscriptions") && sql.includes("RETURNING id")) {
    return Promise.resolve({ rows: [{ id: "sub-old" }], rowCount: 1 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
  loadConfig: async () => ({ platformFeeBps: 1000 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: {
    session?: { sub: string; pubkey: string };
  }) => {
    req.session = { sub: session, pubkey: "a".repeat(64) };
  },
  optionalAuth: async () => {},
}));

vi.mock("../src/lib/nostr-publisher.js", () => ({
  signSubscriptionEvent: () => ({ id: "e".repeat(64), kind: 30000 }),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: async () => {},
}));

vi.mock("@platform-pub/shared/lib/subscription-emails.js", () => ({
  sendSubscriptionCancelledEmail: async () => {},
  sendNewSubscriberEmail: async () => {},
  sendSubscriptionWelcomeEmail: async () => {},
}));

vi.mock("../src/routes/subscriptions/shared.js", () => ({
  logSubscriptionCharge: async (...args: unknown[]) => {
    chargeCalls.push(args);
  },
}));

const { READER_TERMS_VERSION } = await import(
  "@platform-pub/shared/lib/terms-versions.js"
);
const { subscriptionWriterRoutes } = await import(
  "../src/routes/subscriptions/writer.js"
);

async function buildSubscribe() {
  const app = Fastify();
  await app.register(subscriptionWriterRoutes);
  return app;
}

beforeEach(() => {
  calls = [];
  chargeCalls = [];
  blocks = [];
  readerHasCard = false;
  readerCardFlagged = false;
  activeSub = null;
  existingSubStatus = null;
  session = WRITER;
  insertOfferConflicts = false;
});

describe("POST /subscriptions/:writerId — redeeming a comp offer", () => {
  it("creates a free, non-renewing comp subscription and posts NO charge", async () => {
    session = READER;
    readerHasCard = false; // the point: a comp needs no card
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: { offerCode: COMP_CODE },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ pricePence: 0, isComp: true });

    // No money moved, and none was modelled: zero is not a movement.
    expect(chargeCalls).toHaveLength(0);
    // The card gate was not merely satisfied — it was not reached.
    expect(ran("stripe_customer_id")).toBe(false);

    const insert = callFor("INSERT INTO subscriptions")!;
    // price 0 · auto_renew FALSE · is_comp TRUE — the last two are what make
    // the carve-out above safe, since the expiry worker's phase 2 closes a
    // non-renewing row rather than charging it.
    expect(insert.params).toContain(0);
    expect(insert.params).toContain(false); // auto_renew
    expect(insert.params).toContain(true); // is_comp
    expect(insert.params).toContain("annual");

    await app.close();
  });

  it("STILL 402s a card-less reader on a non-comp offer, even at 100% off", async () => {
    // The control. `discount_pct` is 100 here too, so the only thing separating
    // this from the case above is `is_comp` — which is the whole claim.
    session = READER;
    readerHasCard = false;
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: { offerCode: DISCOUNT_CODE },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: "card_required" });
    expect(ran("INSERT INTO subscriptions")).toBe(false);
    await app.close();
  });

  it("402s a reader whose card has terminally declined, even with a card on file", async () => {
    // Reader Terms 6.1. A subscription is the largest single thing a reader can
    // add to a tab we have already been told we cannot collect from, and having
    // a card on file is not the same fact as having one that works — which is
    // all the gate asked until now.
    session = READER;
    readerHasCard = true;
    readerCardFlagged = true;
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: "card_action_required" });
    expect(ran("INSERT INTO subscriptions")).toBe(false);
    expect(chargeCalls).toHaveLength(0);
    await app.close();
  });

  it("subscribes normally once the flag is clear — the control", async () => {
    session = READER;
    readerHasCard = true;
    readerCardFlagged = false;
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(ran("INSERT INTO subscriptions")).toBe(true);
    await app.close();
  });

  it("a COMP is untouched by the flag — there is no debt for a card to collect", async () => {
    // The carve-out holds at its new edge too: the gate is never reached, so
    // neither question is asked. A gift must stay usable by exactly the readers
    // it is for, including one whose card has died.
    session = READER;
    readerHasCard = false;
    readerCardFlagged = true;
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: { offerCode: COMP_CODE },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ pricePence: 0, isComp: true });
    expect(ran("stripe_customer_id")).toBe(false);
    expect(chargeCalls).toHaveLength(0);
    await app.close();
  });

  it("does not burn the offer's single redemption on an already-subscribed 409", async () => {
    session = READER;
    existingSubStatus = "active";
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: { offerCode: COMP_CODE },
    });
    expect(res.statusCode).toBe(409);
    expect(ran("redemption_count = redemption_count + 1")).toBe(false);
    await app.close();
  });

  it("reactivating onto a comp offer clears auto_renew and posts no charge", async () => {
    session = READER;
    existingSubStatus = "expired";
    const app = await buildSubscribe();
    const res = await app.inject({
      method: "POST",
      url: `/subscriptions/${WRITER}`,
      payload: { offerCode: COMP_CODE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pricePence: 0, isComp: true });
    expect(chargeCalls).toHaveLength(0);
    const update = callFor("UPDATE subscriptions\n             SET status = 'active'")!;
    expect(update.params).toContain(false); // auto_renew
    expect(update.params).toContain(true); // is_comp
    await app.close();
  });
});
