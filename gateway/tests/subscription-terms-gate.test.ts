import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The Reader Terms refusal on the two SUBSCRIBE routes — and where it sits.
//
// Until 2026-09-18 the only reader-side asker of `readerTermsOutstanding` was
// `performGatePass`, so a card-holder who had never been shown the Reader
// Terms could put the largest single thing a reader can add to a tab — a
// subscription — onto it with no acceptance recorded (CONSOLIDATED-TODO §0z
// item 5). Any pre-text `segregation-sequence-*` dev account did exactly that.
//
// WHAT IS ASSERTED IS WHETHER THE CHARGE WAS POSTED and whether a row was
// written, never the status alone: a refusal placed after `logSubscriptionCharge`
// answers the same 403 with the money already on the tab. The redemption
// increment is watched for the same reason — a 403 that spent the offer's one
// redemption would leave a gift the recipient can never accept.
//
// PLACEMENT is the second half. The gate sits AFTER the already-subscribed
// refusal (no sale happens there, so no text is asked for) and inside the
// non-comp arm (a comp is not a sale). The 409 case and the comp case are what
// say so; move the check up beside the card gates and the first goes red.
//
// The terms read is `SELECT … FROM accounts WHERE id = $1`, one of several
// same-table reads on this route that differ only in projection — so it is
// told apart by its column list AND answered from params[0], never from the
// text alone.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const READER = "00000000-0000-4000-8000-0000000000b2";
const PUBLICATION = "00000000-0000-4000-8000-0000000000d4";
const COMP_CODE = "comp-code-1";

let calls: Array<{ sql: string; params: unknown[] }> = [];
let chargeCalls: Array<unknown[]> = [];
let readerHasCard = true;
let readerTermsVersion: string | null = null;
let existingSubStatus: string | null = null;
/** Writer 9.3: has paid access to this writer's work been withdrawn? */
let writerWithdrawn = false;
/** READER-WRITER-SPLIT-ADR §5: is the subscribe target a reader? */
let targetIsReader = false;

const ran = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });

  // The writer lookup: `FROM accounts WHERE id = $1 AND status = 'active'`
  // with the price columns. Answered only for the writer's id.
  // The recipient predicate is in the WHERE, so a reader target is filtered
  // out the way Postgres would filter it — and only if the SQL carries it.
  if (sql.includes("FROM accounts") && sql.includes("subscription_price_pence")) {
    const filtered = targetIsReader && sql.includes("writer_admitted_at IS NOT NULL");
    return params[0] === WRITER && !filtered
      ? Promise.resolve({
          rows: [
            {
              id: WRITER,
              subscription_price_pence: 500,
              annual_discount_pct: 15,
              display_name: "W",
              username: "writer",
              nostr_pubkey: "f".repeat(64),
              paid_access_withdrawn_at: writerWithdrawn ? new Date() : null,
            },
          ],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  // The terms read (`terms-gate.ts`): has_card + reader_terms_version, from
  // the id it is handed. A fixture returned whatever the id would pin the
  // fixture, not the query.
  if (sql.includes("reader_terms_version") && sql.includes("has_card")) {
    return params[0] === READER
      ? Promise.resolve({
          rows: [{ has_card: readerHasCard, reader_terms_version: readerTermsVersion }],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  // The card gate's read.
  if (sql.includes("stripe_customer_id") && sql.includes("card_action_required_at")) {
    return params[0] === READER
      ? Promise.resolve({
          rows: [
            {
              stripe_customer_id: readerHasCard ? "cus_1" : null,
              card_action_required_at: null,
            },
          ],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM subscription_offers") && sql.includes("code = $1")) {
    return params[0] === COMP_CODE
      ? Promise.resolve({
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
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM publications")) {
    return params[0] === PUBLICATION
      ? Promise.resolve({
          rows: [
            {
              subscription_price_pence: 800,
              annual_discount_pct: 10,
              name: "P",
              nostr_pubkey: "e".repeat(64),
            },
          ],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }
  // The existing-row read on both routes (the writer route's is locked and
  // computes `paid_up`, CA-A3; a row with `existingSubStatus` here is never
  // paid up — the restore arm is DB-backed in resubscribe-race.test.ts).
  if (sql.includes("SELECT id, status") && sql.includes("FROM subscriptions")) {
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
  // The guarded writes answer one row, as on an uncontended row.
  if (sql.includes("redemption_count = redemption_count + 1")) {
    return Promise.resolve({ rows: [{ id: "offer-comp" }], rowCount: 1 });
  }
  if (sql.includes("UPDATE subscriptions") && sql.includes("RETURNING id")) {
    return Promise.resolve({ rows: [{ id: "sub-old" }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
  loadConfig: async () => ({ platformFeeBps: 1000 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string; pubkey: string } }) => {
    req.session = { sub: READER, pubkey: "a".repeat(64) };
  },
  optionalAuth: async () => {},
}));

// The publications system is suspended by flag; this file is about the terms
// gate, so the flag is held open.
vi.mock("../src/middleware/publication-auth.js", () => ({
  requirePublicationsEnabled: () => async () => {},
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

const { subscriptionWriterRoutes } = await import("../src/routes/subscriptions/writer.js");
const { subscriptionPublicationRoutes } = await import(
  "../src/routes/subscriptions/publication.js"
);
const { READER_TERMS_VERSION } = await import("@platform-pub/shared/lib/terms-versions.js");
const { READER_TERMS_REQUIRED } = await import("../src/lib/terms-gate.js");

async function build() {
  const app = Fastify();
  await app.register(subscriptionWriterRoutes);
  await app.register(subscriptionPublicationRoutes);
  return app;
}

const subscribeToWriter = (app: Awaited<ReturnType<typeof build>>, payload: object = {}) =>
  app.inject({ method: "POST", url: `/subscriptions/${WRITER}`, payload });
const subscribeToPublication = (app: Awaited<ReturnType<typeof build>>) =>
  app.inject({ method: "POST", url: `/subscriptions/publication/${PUBLICATION}`, payload: {} });

/** Nothing was sold: no charge, no row, no redemption spent. */
function expectNothingSold() {
  expect(chargeCalls).toHaveLength(0);
  expect(ran("INSERT INTO subscriptions")).toBe(false);
  expect(ran("UPDATE subscriptions")).toBe(false);
  expect(ran("redemption_count = redemption_count + 1")).toBe(false);
}

beforeEach(() => {
  calls = [];
  chargeCalls = [];
  readerHasCard = true;
  readerTermsVersion = null;
  existingSubStatus = null;
  writerWithdrawn = false;
  targetIsReader = false;
});

// READER-WRITER-SPLIT-ADR §5: a reader is not sold. A fact about the OBJECT,
// so — unlike a withdrawal, which spares a comp — it refuses the whole route,
// before the block check, the offer, the terms and the card (money.md).
describe("POST /subscriptions/:writerId — a READER is not sold", () => {
  it("answers 404 like any unsellable target, sells nothing, asks nothing", async () => {
    targetIsReader = true;
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("Writer not found");
    expectNothingSold();
    expect(ran("FROM blocks")).toBe(false);
    expect(ran("reader_terms_version")).toBe(false);
  });

  it("a comp to a reader is refused too — there is nothing of theirs on sale", async () => {
    targetIsReader = true;
    const res = await subscribeToWriter(await build(), { offerCode: COMP_CODE });
    expect(res.statusCode).toBe(404);
    expectNothingSold();
  });
});

describe("POST /subscriptions/:writerId — a withdrawn writer is not for sale (Writer 9.3, §0z item 10)", () => {
  it("refuses with the gate pass's code, sells nothing, and asks for no text", async () => {
    writerWithdrawn = true;
    readerTermsVersion = null; // pre-text too: the errand is refused before the text is asked for
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_for_sale");
    expectNothingSold();
    expect(ran("reader_terms_version")).toBe(false);
  });

  it("a comp is not paid access, so it still goes through", async () => {
    writerWithdrawn = true;
    const res = await subscribeToWriter(await build(), { offerCode: COMP_CODE });
    expect(res.statusCode).toBe(201);
    expect(chargeCalls).toHaveLength(0);
  });
});

describe("POST /subscriptions/:writerId — the pre-text cohort", () => {
  it("refuses a card-holder who has accepted nothing, and sells nothing", async () => {
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(READER_TERMS_REQUIRED);
    expectNothingSold();
    // Asked from the reader's own id, on the transaction's connection.
    const termsRead = calls.find((c) => c.sql.includes("reader_terms_version"));
    expect(termsRead?.params[0]).toBe(READER);
  });

  it("refuses an acceptance of an older MAJOR", async () => {
    readerTermsVersion = "0.9";
    const res = await subscribeToWriter(await build(), { period: "annual" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(READER_TERMS_REQUIRED);
    expectNothingSold();
  });

  it("control: a current acceptance goes through and the charge is posted", async () => {
    readerTermsVersion = READER_TERMS_VERSION;
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(201);
    expect(chargeCalls).toHaveLength(1);
    expect(ran("INSERT INTO subscriptions")).toBe(true);
  });

  it("a same-major text bump does not re-prompt — the comparison is major-only", async () => {
    const major = READER_TERMS_VERSION.split(".")[0];
    readerTermsVersion = `${major}.9999`;
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(201);
    expect(chargeCalls).toHaveLength(1);
  });

  it("a card-less reader meets the card gate, never a terms wall", async () => {
    readerHasCard = false;
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("card_required");
    expectNothingSold();
  });

  it("PLACEMENT: an already-subscribed reader is told so, not sent to accept a text", async () => {
    existingSubStatus = "active";
    const res = await subscribeToWriter(await build(), { period: "monthly" });
    expect(res.statusCode).toBe(409);
    expect(ran("reader_terms_version")).toBe(false);
    expectNothingSold();
  });

  it("PLACEMENT: a comp is not a sale, so a pre-text recipient is not asked", async () => {
    const res = await subscribeToWriter(await build(), { offerCode: COMP_CODE });
    expect(res.statusCode).toBe(201);
    expect(res.json().isComp).toBe(true);
    expect(ran("reader_terms_version")).toBe(false);
    // A comp posts nothing, before and after.
    expect(chargeCalls).toHaveLength(0);
    expect(ran("INSERT INTO subscriptions")).toBe(true);
  });
});

describe("POST /subscriptions/publication/:id — the same gate, the same place", () => {
  it("refuses the pre-text cohort and sells nothing", async () => {
    const res = await subscribeToPublication(await build());
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(READER_TERMS_REQUIRED);
    expectNothingSold();
  });

  it("control: a current acceptance goes through and the charge is posted", async () => {
    readerTermsVersion = READER_TERMS_VERSION;
    const res = await subscribeToPublication(await build());
    expect(res.statusCode).toBe(201);
    expect(chargeCalls).toHaveLength(1);
  });

  it("PLACEMENT: already subscribed answers 409 before the text is asked for", async () => {
    existingSubStatus = "active";
    const res = await subscribeToPublication(await build());
    expect(res.statusCode).toBe(409);
    expect(ran("reader_terms_version")).toBe(false);
    expectNothingSold();
  });
});
