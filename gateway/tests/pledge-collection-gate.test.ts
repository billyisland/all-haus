import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A pledge needs a card and has a ceiling (MIRROR-AUDIT §3 *Money*, S14).
//
// A pledge is a promise that becomes money at fulfilment: publishing the article
// inserts a read_event, unlocks the piece for the pledger and debits their tab
// by the full amount (drives.ts::fulfillDrive). POST /drives/:id/pledge had
// neither precondition — no card check, and `amountPence` bounded only by
// `min(1)` — so a card-less pledger funded a drive out of money settlement
// cannot collect (it SKIPS card-less accounts) while the writer earned, and a
// slipped decimal point put £5,000 on somebody's tab.
//
// WHAT IS ASSERTED, and why not the status code: every branch of this route can
// answer with a plausible-looking JSON body, and the question that matters is
// whether the PLEDGE ROW WAS WRITTEN. So each case reads the scripted client's
// statement log. The status codes are checked too, but they are not the pin.
// =============================================================================

vi.mock("stripe", () => ({ default: class {} }));

const PLEDGER = "00000000-0000-4000-8000-0000000000a1";
const DRIVE = "11111111-0000-4000-8000-000000000001";

/** Every statement the pledge transaction issued, in order. */
let txSql: Array<{ sql: string; params: unknown[] }> = [];
/** What `SELECT stripe_customer_id FROM accounts` answers. */
let cardOnFile: string | null = "cus_test";
/** READER-WRITER-SPLIT-ADR §5: is the drive's target (who the pledges pay) a reader? */
let targetIsReader = false;

function scriptedQuery(sql: string, params: unknown[] = []) {
  txSql.push({ sql, params });
  if (/SELECT stripe_customer_id FROM accounts/.test(sql)) {
    return Promise.resolve({ rows: [{ stripe_customer_id: cardOnFile }], rowCount: 1 });
  }
  // The drive read joins its target's account and carries the recipient
  // predicate (READER-WRITER-SPLIT-ADR §5), so a reader target is filtered out
  // the way Postgres would — and only if the SQL carries the predicate.
  if (/FROM pledge_drives d/.test(sql)) {
    if (targetIsReader && sql.includes("writer_admitted_at IS NOT NULL")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({
      rows: [{ id: DRIVE, status: "open", funding_target_pence: null, current_total_pence: 0 }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/key-custody-client.js", () => ({ signEvent: vi.fn(async () => ({ id: "evt-1" })) }));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: PLEDGER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: PLEDGER };
  },
}));

// The cap is a dial; the config map is scripted so the cases below test the
// route's use of it rather than the seeded number.
const configMock = { current: new Map<string, string>() };
vi.mock("../src/lib/platform-config.js", () => ({
  getPlatformConfig: async () => configMock.current,
}));

const { driveRoutes } = await import("../src/routes/drives.js");

async function buildApp() {
  const app = Fastify();
  await app.register(driveRoutes);
  await app.ready();
  return app;
}

const pledged = () => txSql.some((c) => /INSERT INTO pledges/.test(c.sql));

async function pledge(amountPence: number) {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: `/drives/${DRIVE}/pledge`,
    payload: { amountPence },
  });
  await app.close();
  return res;
}

beforeEach(() => {
  process.env.PLEDGES_ENABLED = "1";
  txSql = [];
  cardOnFile = "cus_test";
  targetIsReader = false;
  configMock.current = new Map([["pledge_max_pence", "10000"]]);
  vi.clearAllMocks();
});

describe("POST /drives/:id/pledge — collection gate", () => {
  it("records the pledge for a carded pledger within the cap (the control)", async () => {
    const res = await pledge(2500);
    expect(res.statusCode).toBe(201);
    expect(pledged()).toBe(true);
  });

  it("refuses a drive whose target is a READER and writes NO pledge row", async () => {
    // A reader is not sold (READER-WRITER-SPLIT-ADR §5); the pledges would pay them.
    targetIsReader = true;
    const res = await pledge(2500);
    expect(res.statusCode).toBe(404);
    expect(pledged()).toBe(false);
  });

  it("refuses a card-less pledger and writes NO pledge row", async () => {
    cardOnFile = null;
    const res = await pledge(2500);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: "card_required" });
    expect(pledged()).toBe(false);
  });

  it("reads the card INSIDE the transaction, before the drive is locked", async () => {
    // A read-then-write outside the transaction leaves a window in which a card
    // detached mid-request still pledges. The ordering is the pin: the card
    // query is the transaction's first statement.
    await pledge(2500);
    expect(txSql[0].sql).toMatch(/SELECT stripe_customer_id FROM accounts/);
    expect(txSql[0].params).toEqual([PLEDGER]);
  });

  it("refuses an over-cap pledge and never opens a transaction", async () => {
    const res = await pledge(10001);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "pledge_too_large" });
    expect(txSql).toHaveLength(0);
  });

  it("allows a pledge exactly AT the cap", async () => {
    const res = await pledge(10000);
    expect(res.statusCode).toBe(201);
    expect(pledged()).toBe(true);
  });

  it("honours the dial rather than a literal", async () => {
    // The operator's UPDATE has to be the thing that decides. Same amount, two
    // dial values, two outcomes — a route holding a hardcoded ceiling passes
    // the case above and fails this one.
    configMock.current = new Map([["pledge_max_pence", "2000"]]);
    const res = await pledge(2500);
    expect(res.statusCode).toBe(400);
    expect(pledged()).toBe(false);

    txSql = [];
    configMock.current = new Map([["pledge_max_pence", "500000"]]);
    const ok = await pledge(2500);
    expect(ok.statusCode).toBe(201);
    expect(pledged()).toBe(true);
  });
});
