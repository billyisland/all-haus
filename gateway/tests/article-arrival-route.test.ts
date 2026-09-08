import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /articles/:dTag/arrival — THE BOUND ON THE ONE MONEY PATH WITH NO GESTURE
// BEHIND IT (PAYWALL-ARRIVAL-ADR §11.4, D4; CLAUDE.md "No money moves without a
// gesture, and a page load is not one").
//
// WHY IT EXISTS. Every other charging path in the product hangs off a press. The
// arrival is the single exception, and what makes it safe is not the client that
// calls it — a client cannot be a bound — but four server-side conditions in the
// route, of which the third and fourth are the money ones: NO CARD, and an
// allowance that still covers the piece. A card holder consumes no allowance by
// design ("a card does not revoke the gift"), so the SAME call on the SAME piece
// would be a full-price charge fired by a page load. That branch is unreachable
// today only because no signup can carry a card; it is written for the day one
// can, and until this file existed nothing anywhere held it.
//
// The gift's arithmetic is pinned (`arrival-gift-resolve.test.ts`,
// `arrival-gift-integration.test.ts`) and so is the statement
// (`arrival-statement-parity-integration.test.ts`). THE ROUTE WAS NOT: replacing
// the whole guard with `if (false)` left the full gateway suite green, because
// nothing but the route index imported `articleArrivalRoutes`.
//
// SO THE ASSERTION IS "WAS THE GATE PASS CALLED", never the status code. Every
// branch here answers 200 with plausible JSON — "still gated" is an ordinary
// outcome, not an error — so a status assertion passes against a route that
// charges everybody. `gatePassCalls` is the whole subject.
//
// Mutation-proved, three ways. `if (false)` in place of the whole guard reddens
// FOUR cases, each of which then fires a gate pass it must not (the two
// not-an-arrival cases return before the guard and are unmoved, which is itself
// the right reading). Dropping only the `has_card` term reddens ONE — the card
// holder. Dropping only the allowance term reddens TWO — the repriced piece and
// the allowance spent elsewhere, which are the same condition from either side.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const ARRIVAL_ARTICLE = "00000000-0000-4000-8000-0000000000c3";
const OTHER_ARTICLE = "00000000-0000-4000-8000-0000000000d4";
const EVENT = "a".repeat(64);
const DIAL = 500;

/** One account row, shaped exactly as the route's single SELECT returns it. */
interface Acct {
  arrival_article_id: string | null;
  arrival_gift_pence: number;
  free_allowance_granted_pence: number;
  free_allowance_remaining_pence: number;
  has_card: boolean;
}

/** The ordinary arrival: stamped on this piece, gift p, no card, allowance intact. */
function ordinary(price: number): Acct {
  return {
    arrival_article_id: ARRIVAL_ARTICLE,
    arrival_gift_pence: price,
    free_allowance_granted_pence: DIAL + price,
    free_allowance_remaining_pence: DIAL + price,
    has_card: false,
  };
}

let acct: Acct;
let articlePrice: number | null;
let gatePassCalls: unknown[] = [];
let gatePassResult: { kind: string; body?: unknown } = {
  kind: "success",
  body: { wrappedKey: "k" },
};

// The mock answers FROM THE SQL IT IS HANDED (house rule). There is only one
// statement on this path, and it is a LEFT JOIN: the article half is null when
// the d-tag matches nothing, which is a different row from "no account".
function scriptedQuery(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM accounts acc")) {
    const dTag = params[1];
    const matched = dTag === "the-piece";
    return Promise.resolve({
      rows: [
        {
          ...acct,
          article_id: matched ? ARRIVAL_ARTICLE : null,
          nostr_event_id: matched ? EVENT : null,
          price_pence: matched ? articlePrice : null,
        },
      ],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: {
    session?: { sub: string; pubkey: string };
  }) => {
    req.session = { sub: READER, pubkey: "b".repeat(64) };
  },
}));

// The gate pass itself is proven elsewhere (it is the ordinary charging path).
// What is under test here is WHETHER IT IS REACHED.
vi.mock("../src/services/article-access/index.js", () => ({
  performGatePass: async (...args: unknown[]) => {
    gatePassCalls.push(args);
    return { ...gatePassResult };
  },
}));

const { articleArrivalRoutes } = await import(
  "../src/routes/articles/arrival.js"
);

async function build() {
  const app = Fastify();
  await app.register(articleArrivalRoutes);
  return app;
}

function land(app: Awaited<ReturnType<typeof build>>, dTag = "the-piece") {
  return app.inject({ method: "POST", url: `/articles/${dTag}/arrival` });
}

beforeEach(() => {
  gatePassCalls = [];
  articlePrice = 300;
  acct = ordinary(300);
  gatePassResult = { kind: "success", body: { wrappedKey: "k" } };
});

describe("POST /articles/:dTag/arrival — the no-gesture bound", () => {
  it("unlocks the arrival piece exactly once, and hands back the gate pass", async () => {
    const app = await build();
    const res = await land(app);
    expect(res.statusCode).toBe(200);
    expect(gatePassCalls).toHaveLength(1);
    expect(res.json()).toMatchObject({
      arrival: true,
      unlocked: true,
      welcomeGiftPence: DIAL,
      arrivalGiftPence: 300,
      pricePence: 300,
      gatePass: { wrappedKey: "k" },
    });
    await app.close();
  });

  it("A CARD HOLDER IS NOT CHARGED BY A PAGE LOAD", async () => {
    // The one that becomes reachable the day signup can capture a card. Their
    // `allowanceConsumedPence` is 0 — the gift is not revoked by a card — so the
    // same call on the same piece is a FULL-PRICE charge with no gesture behind
    // it. Everything else about the account is an ordinary arrival.
    acct = { ...ordinary(300), has_card: true };
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(0);
    expect(res.json()).toMatchObject({ arrival: true, unlocked: false });
    await app.close();
  });

  it("a gift of 0 fires no gate pass", async () => {
    // Above the cap or undeliverable at signup: `resolveArrivalGift` is the one
    // place either is decided and it stamped 0. The piece stays gated and the
    // reader meets the ordinary button, which is what the modal tells them.
    acct = { ...ordinary(300), arrival_gift_pence: 0, free_allowance_granted_pence: DIAL };
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(0);
    expect(res.json()).toMatchObject({ arrival: true, unlocked: false });
    await app.close();
  });

  it("a piece REPRICED past the remaining allowance fires no gate pass", async () => {
    // Conditions 1-3 are stamped at signup; whether the read costs nothing is a
    // fact about now. The author raised the price between the signup and the
    // landing — a real window on both the magic-link and Google carriers — so
    // the allowance no longer covers it and the read would be partly chargeable.
    // Until the route checked this itself the bound was payment-service's F3
    // floor, whose default happens to refuse: a NEGATIVE FREE_ALLOWANCE_FLOOR_
    // PENCE (a documented use of that dial) lets the read straight through.
    articlePrice = 5000;
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(0);
    expect(res.json()).toMatchObject({ arrival: true, unlocked: false });
    await app.close();
  });

  it("an allowance SPENT ELSEWHERE below the price fires no gate pass", async () => {
    // The same fourth condition from the other side, and the reason it cannot be
    // a stamped fact: the reader browsed another paywalled piece before landing.
    acct = { ...ordinary(300), free_allowance_remaining_pence: 100 };
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(0);
    await app.close();
  });

  it("spending the allowance down to EXACTLY the price still unlocks", async () => {
    // `>=`, not `>`. Consuming the last penny on the piece the penny was given
    // for is the intended path, not an edge case — the ordinary arrival is
    // `remaining == dial + p` against a price of `p`.
    acct = { ...ordinary(300), free_allowance_remaining_pence: 300 };
    const app = await build();
    await land(app);
    expect(gatePassCalls).toHaveLength(1);
    await app.close();
  });

  it("SOMEBODY ELSE'S landing on the same piece is not an arrival at all", async () => {
    // Condition 1. Stamped at account creation, so it is false for every account
    // that arrived any other way — including the logged-out member who signs in
    // at the same gate when the beta opens, whom "first authenticated landing"
    // would have caught precisely.
    acct = { ...ordinary(300), arrival_article_id: null, arrival_gift_pence: 0 };
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(0);
    expect(res.json()).toEqual({ arrival: false });
    await app.close();
  });

  it("the arrival reader landing on a DIFFERENT piece is not an arrival", async () => {
    // The two ids have to be COMPARED. Joining on the stamp instead of on the
    // d-tag would make every landing look like the arrival landing.
    acct = { ...ordinary(300), arrival_article_id: OTHER_ARTICLE };
    const app = await build();
    const res = await land(app, "some-other-piece");
    expect(gatePassCalls).toHaveLength(0);
    expect(res.json()).toEqual({ arrival: false });
    await app.close();
  });

  it("a refused gate pass is reported as still gated, not as an error", async () => {
    // Every refusal is a working page with the ordinary button on it.
    gatePassResult = { kind: "article_misconfigured" };
    const app = await build();
    const res = await land(app);
    expect(gatePassCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ arrival: true, unlocked: false });
    expect(res.json().gatePass).toBeUndefined();
    await app.close();
  });
});
