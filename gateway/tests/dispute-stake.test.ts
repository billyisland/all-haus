import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// Dispute-stake debit / refund round-trip (PAYMENTS ADR §1.3(1) — the worst
// test gap in the repo: real £5 tab debits with zero coverage).
//
// A third-party dispute holds a refundable £5 stake: POST /disputes debits the
// disputant's reading tab by +500 and posts the mirror `dispute_stake` ledger
// entry (−500); DELETE /disputes/:id (withdraw) credits it back by −500 with a
// `dispute_stake_refund` entry (+500). The cited author stakes NOTHING.
//
// The whole point is PARITY and CONSERVATION, so this drives the ROUTES through
// the REAL applyLedgerDelta (§1.8) against a stateful scripted client that tracks
// balance and every ledger entry — proving `−SUM(ledger) == balance` holds across
// the full stake → withdraw round-trip, and that the money-relevant guards (cited-
// author no-stake, duplicate no-op, idempotent withdraw) never move money twice.
// =============================================================================

vi.mock("stripe", () => ({ default: class {} }));

// Stateful ledger/tab state, reset per test. applyLedgerDelta (the REAL one)
// upserts reading_tabs and inserts ledger_entries against this scripted client.
const state = { balance: 0, ledger: [] as Array<{ amount: number; trigger: string }> };

// pool.query responses (the pre-txn SELECTs), configurable per test.
let creditRow: Record<string, unknown> | null = null;
let existingDispute: Record<string, unknown> | null = null;

const DISPUTANT = "00000000-0000-4000-8000-0000000000d1";
const DISPUTANT_PUBKEY = "a".repeat(64);
const OTHER_ACCOUNT = "00000000-0000-4000-8000-0000000000c2";

// Per-txn scripted client. Both dispute INSERT and the tab/ledger writes ride it.
let insDisputeRowCount = 1;
let withdrawReturns: Array<Record<string, unknown>> = [];

function scriptedQuery(sql: string, params: unknown[] = []) {
  if (/INSERT INTO dispute_edges/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: insDisputeRowCount });
  }
  if (/INSERT INTO reading_tabs/.test(sql)) {
    // params = [reader_id, deltaPence]; upsert adds the delta (no clamp).
    state.balance += Number(params[1]);
    return Promise.resolve({ rows: [{ id: "tab-1", balance_pence: state.balance }], rowCount: 1 });
  }
  if (/INSERT INTO ledger_entries/.test(sql)) {
    // params = [account, cp, amount, currency, trigger, refTable, refId]
    state.ledger.push({ amount: Number(params[2]), trigger: String(params[4]) });
    return Promise.resolve({ rows: [{ id: `led-${state.ledger.length}` }], rowCount: 1 });
  }
  if (/UPDATE dispute_edges\s+SET withdrawn_at/.test(sql)) {
    return Promise.resolve({ rows: withdrawReturns, rowCount: withdrawReturns.length });
  }
  return Promise.resolve({ rows: [], rowCount: 1 });
}

const mockPoolQuery = vi.fn((sql: string) => {
  if (/SELECT nostr_pubkey FROM accounts/.test(sql))
    return Promise.resolve({ rows: [{ nostr_pubkey: DISPUTANT_PUBKEY }], rowCount: 1 });
  if (/FROM credit_edges WHERE id/.test(sql))
    return Promise.resolve({ rows: creditRow ? [creditRow] : [], rowCount: creditRow ? 1 : 0 });
  if (/FROM dispute_edges/.test(sql))
    return Promise.resolve({ rows: existingDispute ? [existingDispute] : [], rowCount: existingDispute ? 1 : 0 });
  return Promise.resolve({ rows: [], rowCount: 1 });
});

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...(a as [string])) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

const enqueueRelayPublish = vi.fn(async () => undefined);
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: (...a: unknown[]) => enqueueRelayPublish(...a),
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: vi.fn(async () => ({ id: "evt-1" })),
}));

vi.mock("../src/lib/resolver.js", () => ({ resolve: vi.fn() }));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: DISPUTANT };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: DISPUTANT };
  },
}));

import { upstreamEdgeRoutes } from "../src/routes/upstream-edges.js";

const CREDIT_EDGE = "11111111-0000-4000-8000-000000000001";

async function buildApp() {
  const app = Fastify();
  await app.register(upstreamEdgeRoutes);
  await app.ready();
  return app;
}

// A third-party credit (disputant is NOT the credited party, no matching external
// identity) — the case that holds a stake.
const THIRD_PARTY_CREDIT = {
  resolved_account_id: OTHER_ACCOUNT,
  target_protocol: null,
  target_external_id: null,
};

/** −SUM(ledger) must equal the tab balance at every point (Phase-3 invariant). */
function parityHolds() {
  const sum = state.ledger.reduce((s, e) => s + e.amount, 0);
  return -sum === state.balance;
}

beforeEach(() => {
  // The Phase-1 apparatus is dark by default (UPSTREAM_EDGES_ENABLED, suspended
  // 2026-08-25 by operator directive); these tests exercise the lit routes.
  process.env.UPSTREAM_EDGES_ENABLED = "1";
  state.balance = 0;
  state.ledger = [];
  creditRow = THIRD_PARTY_CREDIT;
  existingDispute = null;
  insDisputeRowCount = 1;
  withdrawReturns = [];
  vi.clearAllMocks();
});

describe("upstream edges — dark by default", () => {
  it("404s every route while UPSTREAM_EDGES_ENABLED is unset, moving no money", async () => {
    delete process.env.UPSTREAM_EDGES_ENABLED;
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { targetType: "credit", targetId: CREDIT_EDGE },
    });
    expect(res.statusCode).toBe(404);
    expect(state.ledger).toHaveLength(0);
    expect(state.balance).toBe(0);
    const get = await app.inject({ method: "GET", url: `/articles/${CREDIT_EDGE}/credits` });
    expect(get.statusCode).toBe(404);
    await app.close();
  });
});

describe("dispute stake — debit on file", () => {
  it("debits £5 and posts the mirror dispute_stake entry (parity holds)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { creditEdgeId: CREDIT_EDGE, counterCharacterisation: "Not me." },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ staked: true });
    expect(state.balance).toBe(500); // £5 debt held
    expect(state.ledger).toEqual([{ amount: -500, trigger: "dispute_stake" }]);
    expect(parityHolds()).toBe(true);
    await app.close();
  });

  it("holds NO stake when the disputant is the cited author", async () => {
    creditRow = { resolved_account_id: DISPUTANT, target_protocol: null, target_external_id: null };
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { creditEdgeId: CREDIT_EDGE, counterCharacterisation: "That's me, and I disclaim it." },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ staked: false });
    expect(state.balance).toBe(0); // the cited author stakes nothing
    expect(state.ledger).toHaveLength(0);
    await app.close();
  });

  it("does not double-charge a duplicate dispute (ON CONFLICT no-op)", async () => {
    insDisputeRowCount = 0; // a live dispute already exists on this edge
    existingDispute = { id: "dup-1", is_by_cited_author: false };
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { creditEdgeId: CREDIT_EDGE, counterCharacterisation: "Again." },
    });

    expect(res.statusCode).toBe(409);
    expect(state.balance).toBe(0); // no second stake
    expect(state.ledger).toHaveLength(0);
    await app.close();
  });
});

describe("dispute stake — withdraw round-trip", () => {
  it("refunds the stake and conserves to zero across debit → withdraw", async () => {
    const app = await buildApp();

    // File the dispute (debit +500).
    const created = await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { creditEdgeId: CREDIT_EDGE, counterCharacterisation: "Not me." },
    });
    const disputeId = created.json().id as string;
    expect(state.balance).toBe(500);

    // Withdraw it — a stake was held (stake_ledger_entry_id non-null), so refund.
    withdrawReturns = [{ stake_ledger_entry_id: "led-1", nostr_event_id: null }];
    const del = await app.inject({ method: "DELETE", url: `/disputes/${disputeId}` });

    expect(del.statusCode).toBe(200);
    expect(state.balance).toBe(0); // debt fully unwound
    expect(state.ledger).toEqual([
      { amount: -500, trigger: "dispute_stake" },
      { amount: 500, trigger: "dispute_stake_refund" },
    ]);
    expect(parityHolds()).toBe(true); // −SUM(0) == balance(0)
    await app.close();
  });

  it("is idempotent: a second withdraw refunds nothing", async () => {
    const app = await buildApp();
    await app.inject({
      method: "POST",
      url: "/disputes",
      payload: { creditEdgeId: CREDIT_EDGE, counterCharacterisation: "Not me." },
    });

    withdrawReturns = [{ stake_ledger_entry_id: "led-1", nostr_event_id: null }];
    const first = await app.inject({ method: "DELETE", url: "/disputes/22222222-0000-4000-8000-000000000002" });
    expect(first.statusCode).toBe(200);
    expect(state.balance).toBe(0);

    // Second withdraw: the guarded UPDATE claims zero rows → no refund fires.
    withdrawReturns = [];
    const ledgerLenBefore = state.ledger.length;
    const second = await app.inject({ method: "DELETE", url: "/disputes/22222222-0000-4000-8000-000000000002" });

    expect(second.statusCode).toBe(404);
    expect(state.balance).toBe(0); // still zero — no double refund
    expect(state.ledger).toHaveLength(ledgerLenBefore);
    await app.close();
  });
});
