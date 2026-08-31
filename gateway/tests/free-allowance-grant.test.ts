import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// §0o.9a — the free allowance is a dial, and what a reader was gifted is theirs.
//
// The filed finding was that LedgerPanel hardcoded the gauge's denominator at
// 500 while the allowance is the `free_allowance_pence` dial. Verifying it
// turned up the larger fact: the dial governed NOTHING. Both account INSERTs
// hardcoded 500, the column carried DEFAULT 500, and `config.freeAllowancePence`
// had no reader in the codebase at all — so an operator retuning it changed
// neither what a reader received nor what any surface showed. That is the exact
// failure the tuning-dials rule exists to prevent, for the second time on these
// same dials.
//
// Migration 169 splits the two facts that were being conflated:
//   · `free_allowance_granted_pence` — what this reader was gifted. Stamped
//     from the dial at signup, then never restated. A retune must not tell a
//     reader gifted £5 that they were gifted £7.50, on the gauge or on their
//     statement's "Starting credit" line: the gift is a historical fact about
//     them, and the free-allowance invariant is that it is never revisited.
//   · `free_allowance_remaining_pence` — what is left of it (the pre-existing
//     column, decremented by accrual).
//
// So the two halves pinned here are: the GRANT reads the dial, and the DISPLAY
// reads the grant. A fix that did only the first would leave the gauge quietly
// restating history; a fix that did only the second would show a number the
// operator cannot move.
//
// THE MOCK ANSWERS FROM THE SQL IT IS HANDED — the accounts branch asserts the
// SELECT actually names the granted column before answering it, and the grant
// cases read the dial back out of the INSERT's own parameters. A route that
// sent `remaining` as the total, or an INSERT that went back to a literal,
// fails here rather than passing against an agreeable fixture.
// (Mutation-checked: each mutant named in the cases below turns this file red.)
// =============================================================================

const READER = "00000000-0000-4000-8000-00000000bbbb";

/** The `free_allowance_pence` dial, as loadConfig would report it. */
let dialPence = 500;
/** This reader's own columns. */
let grantedPence = 500;
let remainingPence = 0;
/** Every statement the route or the provisioner issued, with its params. */
let issued: Array<{ sql: string; params: unknown[] }> = [];

function query(sql: string, params: unknown[] = []) {
  issued.push({ sql, params });

  // FIRST, because these two are the most specific statements the route issues
  // and every generic branch below would shadow them: both wrap the whole
  // statement CTE, so they match `FROM tab_settlements` (and more) long before
  // reaching a branch that could answer their actual shape. Answered
  // structurally — an empty statement: no rows, zero totals. Shape only;
  // neither figure is what this file asserts on.
  //
  // Left to the catch-all's `rows: []` the route threw on `rows[0]` and
  // returned 500 before ever issuing the summary query — which is why the
  // summary's own copy of the starting-credit row went uninspected, and why
  // the case below could not have caught the literal that shipped in it.
  if (/COUNT\(\*\) AS total/.test(sql)) {
    return Promise.resolve({ rows: [{ total: "0" }], rowCount: 1 });
  }
  if (/AS credits_total/.test(sql)) {
    return Promise.resolve({
      rows: [{ credits_total: "0", debits_total: "0" }],
      rowCount: 1,
    });
  }

  if (sql.includes("FROM accounts a") && sql.includes("balance_pence")) {
    // Answer only the columns this SELECT actually names.
    expect(sql).toContain("free_allowance_granted_pence");
    expect(sql).toContain("free_allowance_remaining_pence");
    return Promise.resolve({
      rows: [
        {
          free_allowance_granted_pence: grantedPence,
          free_allowance_remaining_pence: remainingPence,
          card_action_required_at: null,
          balance_pence: 0,
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM read_events r")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  // The statement route's own account lookup — it 404s on rowCount 0, and the
  // statement SQL this file is here to inspect is issued after it.
  if (sql.includes("FROM accounts WHERE id")) {
    return Promise.resolve({
      rows: [
        {
          created_at: new Date("2026-01-01T00:00:00Z"),
          free_allowance_remaining_pence: remainingPence,
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM tab_settlements")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM platform_config")) {
    return Promise.resolve({ rows: [{ value: "800" }], rowCount: 1 });
  }
  if (sql.includes("INSERT INTO accounts")) {
    return Promise.resolve({
      rows: [{ id: READER, nostr_pubkey: "pk", username: "u" }],
      rowCount: 1,
    });
  }
  if (sql.includes("INSERT INTO reading_tabs")) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("FROM accounts WHERE username")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: (cb: (c: { query: typeof query }) => Promise<unknown>) =>
    cb({ query }),
  loadConfig: async () => ({ freeAllowancePence: dialPence }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: async () => ({
    pubkeyHex: "deadbeef",
    privkeyEncrypted: "enc",
  }),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

const { myAccountRoutes } = await import("../src/routes/my-account.js");
const { provisionAccount } = await import("../src/lib/account-provision.js");

async function getTab() {
  const app = Fastify();
  await app.register(myAccountRoutes);
  const res = await app.inject({ method: "GET", url: "/my/tab" });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The account INSERT's params, so a case can read the grant it was given. */
function accountInsert() {
  const row = issued.find((q) => q.sql.includes("INSERT INTO accounts"));
  if (!row) throw new Error("no account INSERT was issued");
  return row;
}

beforeEach(() => {
  dialPence = 500;
  grantedPence = 500;
  remainingPence = 0;
  issued = [];
});

describe("the grant reads the dial", () => {
  it("provisioning stamps the dial, not a literal 500", async () => {
    // Mutant: `VALUES (…, 'active', 500, 500)` — fails here.
    dialPence = 750;
    await provisionAccount("a@example.com", "A");
    expect(accountInsert().params).toContain(750);
  });

  it("granted and remaining both start at the dial", async () => {
    // A new reader has spent nothing, so the gift and what is left agree — and
    // they must agree at the DIAL, not at two independently-written numbers.
    dialPence = 1200;
    await provisionAccount("b@example.com", "B");
    const { sql, params } = accountInsert();
    expect(sql).toContain("free_allowance_granted_pence");
    expect(sql).toContain("free_allowance_remaining_pence");
    // One placeholder feeding both columns is what makes them unable to drift.
    expect(sql).toMatch(/\$6,\s*\$6/);
    expect(params).toContain(1200);
  });
});

describe("the display reads the grant", () => {
  it("sends this reader's granted total, not a hardcoded £5", async () => {
    // Mutant: `freeAllowanceTotalPence: 500` — fails here.
    grantedPence = 750;
    const body = await getTab();
    expect(body.freeAllowanceTotalPence).toBe(750);
  });

  it("the total is what was granted, never what remains", async () => {
    // Mutant: sending `free_allowance_remaining_pence` as the total — fails here.
    grantedPence = 750;
    remainingPence = 125;
    const body = await getTab();
    expect(body.freeAllowanceTotalPence).toBe(750);
    expect(body.freeAllowanceRemainingPence).toBe(125);
  });

  it("a retuned dial does not restate an existing reader's gift", async () => {
    // The whole reason the grant is stored. This reader was gifted 500; the
    // operator has since moved the dial to 1200. They were still gifted 500.
    // Mutant: sending the live `loadConfig().freeAllowancePence` — fails here.
    grantedPence = 500;
    dialPence = 1200;
    const body = await getTab();
    expect(body.freeAllowanceTotalPence).toBe(500);
  });
});

describe("the account statement's starting credit", () => {
  it("credits the granted column, not a literal", async () => {
    // Mutant: `500 AS amount_pence` — fails here.
    const app = Fastify();
    await app.register(myAccountRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/my/account-statement",
    });
    const stmt = issued.find((q) => q.sql.includes("'free_allowance' AS category"));
    expect(stmt).toBeDefined();
    expect(stmt!.sql).toContain(
      "a.free_allowance_granted_pence AS amount_pence",
    );
    expect([200, 404, 500]).toContain(res.statusCode);

    // EVERY statement the route issues, not just the one carrying the category
    // marker. This route builds the starting-credit row TWICE — once in the
    // entry list, once in the summary totals — and scoping the ban to the first
    // is how a literal survived in the second (found 2026-08-05: the entry list
    // read the column while the summary still read `500`, so the two halves of
    // one statement disagreed for any account whose grant was not 500 — i.e.
    // for every account created after the first retune, which is the whole
    // point of the dial). A copy is the failure mode here, so the assertion is
    // over the whole set.
    for (const q of issued) {
      expect(q.sql).not.toMatch(/\b500 AS amount_pence/);
    }
  });

  it("the summary totals credit the same column as the entry list", async () => {
    // Mutant: `500 AS amount_pence` in summarySQL — fails here (and NOT in the
    // test above, which is exactly what let it ship).
    const app = Fastify();
    await app.register(myAccountRoutes);
    await app.inject({ method: "GET", url: "/my/account-statement" });

    // The summary is the query that aggregates the CTE rather than selecting
    // the presentation columns — no `AS category`, but it does total the rows.
    const summary = issued.find(
      (q) =>
        q.sql.includes("WITH statement AS") &&
        !q.sql.includes("'free_allowance' AS category"),
    );
    expect(summary).toBeDefined();
    expect(summary!.sql).toContain(
      "a.free_allowance_granted_pence AS amount_pence",
    );
  });
});
