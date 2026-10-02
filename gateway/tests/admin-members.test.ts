import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The member roster, and the inverse of suspension.
//
// GET /admin/dashboard/members — the Users tab had aggregates and no roster,
// which meant `POST /admin/suspend/:accountId` took a UUID that no surface in
// the dashboard had ever rendered. Its contract:
//   · behind requireAdmin — it is every member's email address;
//   · the search is a LITERAL substring, so `%` finds a `%` and not everybody;
//   · deleted rows are out unless asked for, and `deactivated` is never hidden
//     (that is a member's own choice, not a state we imposed);
//   · the per-status counts are computed against the SEARCH alone, so switching
//     filters does not rewrite the numbers on the filters;
//   · a capped response says so, because a silent LIMIT reads as "that's
//     everyone" precisely when it isn't.
//
// POST /admin/reinstate/:accountId — suspension had no inverse, so a mis-click
// locked a member out until somebody wrote SQL on the box. Its contract is
// mostly what it REFUSES: an active account (nothing to lift), a deactivated
// one (the member's own decision, theirs to reverse), a deleted one (nothing
// behind the row). Each refusal reports the state it found rather than a bare
// "no", because the operator pressed a button expecting a change.
//
// THE MOCK ANSWERS FROM THE SQL IT IS HANDED. It keeps a real in-memory
// `accounts` table and implements ILIKE-with-ESCAPE over the pattern the route
// actually sent, reads the status filter and the deleted-exclusion out of the
// query text, and honours the ORDER BY and LIMIT. So a route that stopped
// escaping the pattern, or dropped a clause, fails here rather than passing
// against a fixture. (Mutation-checked — see the comments at each branch.)
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

type Status = "active" | "suspended" | "moderated" | "deactivated" | "deleted";

interface Account {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  status: Status;
  created_at: Date;
  onboarded_at: Date | null;
  stripe_customer_id: string | null;
  stripe_connect_id: string | null;
  stripe_connect_kyc_complete: boolean;
}

let accounts: Account[] = [];
let articleCounts: Record<string, number> = {};
/**
 * The `payouts_halted_accounts` rows, by account id. A real (tiny) table rather
 * than a fixture field, because the roster reads them over a LEFT JOIN and the
 * branch below only answers them if the route's SQL actually writes that join —
 * drop it and every member reads as unfrozen, which is the direction that
 * offers a Freeze button on somebody already frozen and hides the fact from the
 * one screen an operator searches from.
 */
let halts: Record<string, { mismatch_class: string; created_at: Date }> = {};
let adminAllowed = true;
let failNext = false;
const invalidateAuthCache = vi.fn();
const withTransactionSpy = vi.fn();

/**
 * SQL `ILIKE … ESCAPE '\'` against one value, implemented from the pattern the
 * route sent rather than from what the test wished it had sent.
 *
 * This is the whole point of the suite's dispatch discipline here: the route's
 * job is to turn an operator's typed string into a pattern where `%` and `_`
 * are literal. If it stops escaping, the pattern arriving here contains a live
 * wildcard, this function matches everybody, and the escaping test fails.
 * A mock that did a plain `.includes()` on the raw search term would pass
 * either way and pin nothing.
 */
function ilike(value: string | null, pattern: string): boolean {
  if (value === null) return false;
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      // Escaped: the NEXT character is a literal, whatever it is.
      const next = pattern[++i];
      if (next !== undefined) rx += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (c === "%") rx += "[\\s\\S]*";
    else if (c === "_") rx += "[\\s\\S]";
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`, "i").test(value);
}

/**
 * Every statement the routes actually sent, in order.
 *
 * The path-id guard's contract is about what did NOT happen: a refusal that
 * reached Postgres has already spent a connection and, on the suspend path,
 * a round-trip to key-custody per removable row. A status code alone cannot
 * tell the guard from the cast raising behind the error funnel.
 */
let seen: string[] = [];

function query(sql: string, params: unknown[] = []) {
  seen.push(sql);
  if (failNext) return Promise.reject(new Error("db down"));

  // --- the roster's counts ---------------------------------------------------
  if (sql.includes("FILTER (WHERE status = 'active')") && !sql.includes("accounts a")) {
    const pattern = params[0] as string | null;
    let matching = accounts.filter(
      (a) =>
        pattern === null ||
        ilike(a.email, pattern) ||
        ilike(a.username, pattern) ||
        ilike(a.display_name, pattern),
    );
    // "The counts are computed against the SEARCH alone" is a claim about the
    // ROUTE, so it is read out of the route's SQL. Reading `params[0]` and
    // stopping would pin this mock instead: a counts query that grew
    // `AND status = $2` would keep answering unfiltered here and the test
    // below would go on passing while the numbers on the filter buttons
    // started rewriting themselves every time the operator switched tab.
    const statusParam = /status = \$\d+::account_status/.exec(sql);
    if (statusParam) {
      const idx = Number(statusParam[0].match(/\$(\d+)/)![1]) - 1;
      const wanted = params[idx] as Status | null;
      if (wanted !== null) matching = matching.filter((a) => a.status === wanted);
    }
    const count = (s: Status) =>
      String(matching.filter((a) => a.status === s).length);
    return Promise.resolve({
      rows: [
        {
          active: count("active"),
          suspended: count("suspended"),
          moderated: count("moderated"),
          deactivated: count("deactivated"),
          deleted: count("deleted"),
        },
      ],
      rowCount: 1,
    });
  }

  // --- the roster's rows -----------------------------------------------------
  if (/FROM accounts a/.test(sql) && /articles/.test(sql)) {
    const [status, pattern, limit] = params as [
      Status | null,
      string | null,
      number,
    ];
    let rows = accounts.slice();
    // Both guards are read out of the SQL, never assumed. Drop the
    // `a.status <> 'deleted'` clause from the route and the default listing
    // starts returning deleted rows, which the test below then catches.
    if (/a\.status <> 'deleted'/.test(sql) && status === null) {
      rows = rows.filter((a) => a.status !== "deleted");
    }
    if (/a\.status = \$1::account_status/.test(sql) && status !== null) {
      rows = rows.filter((a) => a.status === status);
    }
    if (pattern !== null && /ILIKE \$2::text ESCAPE/.test(sql)) {
      rows = rows.filter(
        (a) =>
          ilike(a.email, pattern) ||
          ilike(a.username, pattern) ||
          ilike(a.display_name, pattern),
      );
    }
    // Honour the ORDER BY the route wrote; a mock that always sorted newest
    // first would let a route flipped to ASC pass the ordering assertion.
    const desc = /ORDER BY a\.created_at DESC/i.test(sql);
    rows.sort((x, y) =>
      desc
        ? y.created_at.getTime() - x.created_at.getTime()
        : x.created_at.getTime() - y.created_at.getTime(),
    );
    rows = rows.slice(0, limit);
    return Promise.resolve({
      // COPIES, never the live rows — shared identity lets one request observe
      // another's writes, a snapshot no database would give it.
      rows: rows.map((a) => ({
        ...a,
        has_card: a.stripe_customer_id !== null,
        connect_started: a.stripe_connect_id !== null,
        articles_published: String(articleCounts[a.id] ?? 0),
        // Answered from the JOIN the route wrote, never from the fixture alone.
        ...(/LEFT JOIN payouts_halted_accounts h ON h\.account_id = a\.id/.test(sql)
          ? {
              halt_class: halts[a.id]?.mismatch_class ?? null,
              halt_since: halts[a.id]?.created_at ?? null,
            }
          : { halt_class: null, halt_since: null }),
      })),
      rowCount: rows.length,
    });
  }

  // --- reinstate -------------------------------------------------------------
  if (/UPDATE accounts SET status = 'active'/.test(sql)) {
    const a = accounts.find((x) => x.id === params[0]);
    if (!a) return Promise.resolve({ rows: [], rowCount: 0 });
    // The guard rides the UPDATE, and it is read out of the SQL. Drop
    // `status IN ('suspended','moderated')` from the route and a deactivated
    // account gets silently re-activated — which is what the refusal tests
    // below then catch.
    if (
      /status IN \('suspended', 'moderated'\)/.test(sql) &&
      a.status !== "suspended" &&
      a.status !== "moderated"
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    a.status = "active";
    return Promise.resolve({ rows: [{ id: a.id }], rowCount: 1 });
  }
  // The standing-decision pre-read and the guarded direct suspension (§0z
  // item 14) — the allowed-from list is read out of the params, so a route
  // that dropped the predicate suspends a terminated or deleted account here
  // exactly as it would in Postgres.
  if (/SELECT status::text AS status, suspended_until FROM accounts WHERE id/.test(sql)) {
    const a = accounts.find((x) => x.id === params[0]);
    return Promise.resolve({
      rows: a ? [{ status: a.status, suspended_until: null }] : [],
      rowCount: a ? 1 : 0,
    });
  }
  if (/UPDATE accounts SET status = 'suspended'/.test(sql)) {
    const a = accounts.find((x) => x.id === params[0]);
    if (!a) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/status = ANY\(\$2::account_status\[\]\)/.test(sql)) {
      const allowed = params[1] as string[];
      if (!allowed.includes(a.status)) return Promise.resolve({ rows: [], rowCount: 0 });
    }
    a.status = "suspended";
    return Promise.resolve({ rows: [{ id: a.id }], rowCount: 1 });
  }
  // The record a direct suspension opens (D7 §8) — answered so the success
  // path can run to its end here.
  if (/INSERT INTO moderation_reports/.test(sql)) {
    return Promise.resolve({ rows: [{ id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 });
  }
  if (/SELECT status::text AS status FROM accounts WHERE id/.test(sql)) {
    const a = accounts.find((x) => x.id === params[0]);
    return Promise.resolve({
      rows: a ? [{ status: a.status }] : [],
      rowCount: a ? 1 : 0,
    });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: (...args: unknown[]) => withTransactionSpy(...args),
  loadConfig: vi.fn(async () => ({})),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// L5.5b — the member is TOLD what was done to them and why. Mocked here so the
// assertions are about what the route asked for, not about an email provider.
const sendModerationNoticeEmail = vi.fn(async () => ({ sent: 1, skipped: 0 }));
// The appeal link the suspension notice carries (item 14's control drives
// the success path, which mints one).
vi.mock("@platform-pub/shared/auth/magic-links.js", () => ({
  requestStepUpToken: vi.fn(async () => ({ token: "tok" })),
  claimStepUpToken: vi.fn(async () => null),
}));

vi.mock("@platform-pub/shared/lib/member-notices.js", () => ({
  sendModerationNoticeEmail: (...a: unknown[]) =>
    sendModerationNoticeEmail(...(a as [])),
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, reply: any, done: any) => {
    if (!adminAllowed) return reply.status(403).send({ error: "forbidden" });
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: "admin-id" };
    done();
  },
  optionalAuth: (_req: any, _reply: any, done: any) => done(),
  invalidateAuthCache: (id: string) => invalidateAuthCache(id),
}));

const { adminDashboardRoutes } = await import(
  "../src/routes/admin-dashboard.js"
);
const { moderationRoutes } = await import("../src/routes/moderation.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  await app.register(moderationRoutes);
  return app;
}

// The roster does not care what shape an id is, but `POST /admin/reinstate/:id`
// does — it refuses a non-uuid before the UPDATE (the path-id rule: a malformed
// id and an absent one are the same 404). Readable ids would exercise the guard
// instead of the route, so the fixtures carry real uuids under names.
const ID = {
  writer: "11111111-1111-4111-8111-111111111111",
  reader: "22222222-2222-4222-8222-222222222222",
  susp: "33333333-3333-4333-8333-333333333333",
  closed: "44444444-4444-4444-8444-444444444444",
  deleted: "55555555-5555-4555-8555-555555555555",
  slash: "66666666-6666-4666-8666-666666666666",
} as const;

const T = (iso: string) => new Date(iso);

const acct = (over: Partial<Account> & Pick<Account, "id">): Account => ({
  username: null,
  display_name: null,
  email: null,
  status: "active",
  created_at: T("2026-01-01T00:00:00Z"),
  onboarded_at: T("2026-01-01T00:00:00Z"),
  stripe_customer_id: null,
  stripe_connect_id: null,
  stripe_connect_kyc_complete: false,
  ...over,
});

beforeEach(() => {
  adminAllowed = true;
  failNext = false;
  seen = [];
  invalidateAuthCache.mockClear();
  withTransactionSpy.mockClear();
  sendModerationNoticeEmail.mockClear();
  articleCounts = {};
  halts = {};
  accounts = [
    acct({
      id: ID.writer,
      username: "juno",
      display_name: "Juno Reyes",
      email: "juno@example.com",
      created_at: T("2026-03-01T10:00:00Z"),
      stripe_connect_id: "acct_1",
      stripe_connect_kyc_complete: true,
    }),
    acct({
      id: ID.reader,
      username: "milo",
      display_name: "Milo",
      email: "milo@example.com",
      created_at: T("2026-04-01T10:00:00Z"),
      stripe_customer_id: "cus_1",
    }),
    acct({
      id: ID.susp,
      username: "spam_bot",
      display_name: null,
      email: "spam@throwaway.test",
      status: "suspended",
      created_at: T("2026-05-01T10:00:00Z"),
      onboarded_at: null,
    }),
    acct({
      id: ID.closed,
      username: "gone",
      email: "gone@example.com",
      status: "deactivated",
      created_at: T("2026-02-01T10:00:00Z"),
    }),
    acct({
      // A BACKSLASH IN REAL DATA. `likePattern` escapes `\\` as well as `%`
      // and `_`, and nothing reached that arm: on real Postgres an unescaped
      // `\\` makes the NEXT character literal, so a search for `\\` turns the
      // pattern's own trailing `%` into a literal one and the operator is
      // handed "rows containing a percent sign" instead.
      id: ID.slash,
      username: "winpath",
      display_name: "C:\\photos\\",
      email: "win@winpath.test",
      created_at: T("2026-06-01T10:00:00Z"),
    }),
    acct({
      id: ID.deleted,
      username: "erased",
      email: "erased@example.com",
      status: "deleted",
      created_at: T("2026-01-15T10:00:00Z"),
    }),
  ];
  articleCounts = { [ID.writer]: 7 };
});

describe("GET /admin/dashboard/members", () => {
  // ---------------------------------------------------------------------------
  // The payout freeze the roster has to render (L8.6 residual, D9 §4.1).
  //
  // A frozen member looks ORDINARY on every other surface — that is what
  // "silent to the member" buys — so if the roster does not carry the fact,
  // the one screen an operator searches from shows a payable writer who is not
  // being paid and nothing anywhere saying why. It also gates the Freeze
  // button: a control offered on somebody already frozen can only be a no-op.
  // ---------------------------------------------------------------------------
  it("carries the freeze, with its class, for the members who have one", async () => {
    halts[ID.writer] = {
      mismatch_class: "sanctions_review",
      created_at: T("2026-09-10T09:00:00Z"),
    };
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/admin/dashboard/members" });

    const body = res.json();
    const frozen = body.members.find((m: any) => m.id === ID.writer);
    expect(frozen.payoutsHalted).toEqual({
      mismatchClass: "sanctions_review",
      since: "2026-09-10T09:00:00.000Z",
    });
    // NULL, never absent and never `false`: the field is what the button gates
    // on, and `undefined` would read as "not frozen" for every member on a
    // route that had stopped asking.
    expect(body.members.find((m: any) => m.id === ID.reader).payoutsHalted).toBeNull();
    await app.close();
  });

  it("asks for the freeze over a join, so a member frozen by the reconciler shows too", async () => {
    // The table is shared with the reconciler, and the class is how an operator
    // tells the two apart. The roster must not filter to its own.
    halts[ID.reader] = {
      mismatch_class: "ledger_orphans",
      created_at: T("2026-09-11T09:00:00Z"),
    };
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/admin/dashboard/members" });

    const m = res.json().members.find((x: any) => x.id === ID.reader);
    expect(m.payoutsHalted.mismatchClass).toBe("ledger_orphans");
    await app.close();
  });

  it("requires admin", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("lists everyone who still exists, newest first, and hides deleted rows", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members.map((m: any) => m.id)).toEqual([
      ID.slash,
      ID.susp,
      ID.reader,
      ID.writer,
      ID.closed,
    ]);
    // A member's own deactivation is not a state we imposed and is never
    // hidden; a deleted row has nothing behind it and is.
    expect(body.members.map((m: any) => m.id)).toContain(ID.closed);
    expect(body.members.map((m: any) => m.id)).not.toContain(ID.deleted);
    // `matched` excludes deleted too, so the number under the list agrees with
    // the list. Derived from the counts, never queried separately.
    expect(body.matched).toBe(5);
    await app.close();
  });

  it("reports the signals a roster is read for, per row", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    const byId = Object.fromEntries(
      res.json().members.map((m: any) => [m.id, m]),
    );

    expect(byId[ID.writer]).toMatchObject({
      username: "juno",
      displayName: "Juno Reyes",
      email: "juno@example.com",
      status: "active",
      articlesPublished: 7,
      connectStarted: true,
      connectKycComplete: true,
      hasCard: false,
    });
    expect(byId[ID.reader]).toMatchObject({
      hasCard: true,
      articlesPublished: 0,
      connectStarted: false,
    });
    // Never onboarded is its own fact, and NULL says so rather than a date.
    expect(byId[ID.susp].onboardedAt).toBeNull();
    expect(byId[ID.writer].onboardedAt).not.toBeNull();
    await app.close();
  });

  it("counts every status including deleted, and the counts follow the search", async () => {
    const app = await build();

    const all = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    expect(all.json().byStatus).toEqual({
      active: 3,
      suspended: 1,
      moderated: 0,
      deactivated: 1,
      deleted: 1,
    });

    const searched = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=example.com",
    });
    // Narrowed by the search: throwaway.test is out.
    expect(searched.json().byStatus).toEqual({
      active: 2,
      suspended: 0,
      moderated: 0,
      deactivated: 1,
      deleted: 1,
    });
    await app.close();
  });

  it("does not move the counts when the status filter moves", async () => {
    const app = await build();
    const unfiltered = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    const filtered = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?status=suspended",
    });

    // Same numbers on the buttons you are switching between — the counts are
    // computed against the search alone. Only the LIST narrows.
    expect(filtered.json().byStatus).toEqual(unfiltered.json().byStatus);
    expect(filtered.json().members.map((m: any) => m.id)).toEqual([ID.susp]);
    expect(filtered.json().matched).toBe(1);
    await app.close();
  });

  it("is the only filter that widens: status=deleted shows the deleted rows", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?status=deleted",
    });
    expect(res.json().members.map((m: any) => m.id)).toEqual([ID.deleted]);
    expect(res.json().matched).toBe(1);
    await app.close();
  });

  it("searches the address, the handle and the display name", async () => {
    const app = await build();

    const byEmail = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=throwaway",
    });
    expect(byEmail.json().members.map((m: any) => m.id)).toEqual([ID.susp]);

    const byHandle = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=milo",
    });
    expect(byHandle.json().members.map((m: any) => m.id)).toEqual([ID.reader]);

    const byName = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=Reyes",
    });
    expect(byName.json().members.map((m: any) => m.id)).toEqual([ID.writer]);
    await app.close();
  });

  it("searches for a LITERAL wildcard, not for everybody", async () => {
    const app = await build();

    // `%` is an ILIKE wildcard. Unescaped, this pattern matches every row —
    // the operator would type one character and be told their search found the
    // entire membership. Escaped, it finds the nobody it should.
    //
    // This is the mutation test for the route's `likePattern`: delete the
    // `.replace(/[\\%_]/g, …)` and this returns four rows instead of none.
    const pct = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=%25",
    });
    expect(pct.json().members).toEqual([]);

    // `_` is the single-character wildcard. `spam_bot` is the only row with a
    // literal underscore, so an unescaped `_bot` would also match nothing new
    // here — but `m_lo` would find "milo", which it must not.
    const underscore = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=m_lo",
    });
    expect(underscore.json().members).toEqual([]);

    const literalUnderscore = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=spam_bot",
    });
    expect(literalUnderscore.json().members.map((m: any) => m.id)).toEqual([
      ID.susp,
    ]);

    // `\` IS THE THIRD METACHARACTER, AND IT WAS THE UNREACHED ONE. It is the
    // escape character itself (`ESCAPE '\'`), so an unescaped one does not
    // widen the search the way `%` does — it consumes the pattern's own
    // trailing `%` and makes it literal, and the operator searching for a
    // Windows path is handed rows containing a percent sign instead. Nothing
    // in the suite had a backslash in it, so dropping `\\` from `likePattern`
    // left every case green.
    const backslash = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?q=%5C", // a single `\`
    });
    expect(backslash.json().members.map((m: any) => m.id)).toEqual([ID.slash]);

    // And the whole path, which contains two of them.
    const path = await app.inject({
      method: "GET",
      url: `/admin/dashboard/members?q=${encodeURIComponent("C:\\photos\\")}`,
    });
    expect(path.json().members.map((m: any) => m.id)).toEqual([ID.slash]);
    await app.close();
  });

  it("says when the list was capped rather than letting a LIMIT read as everyone", async () => {
    const app = await build();

    const small = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    expect(small.json().truncated).toBe(false);
    expect(small.json().shown).toBe(5);

    // 201 active rows: one over the route's cap, which is what makes the flag
    // the difference between an honest page and a silent one.
    accounts = Array.from({ length: 201 }, (_, i) =>
      acct({
        id: `bulk-${i}`,
        email: `bulk${i}@example.com`,
        created_at: T(`2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
      }),
    );
    const big = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    expect(big.json().truncated).toBe(true);
    expect(big.json().shown).toBe(200);
    // The count is the true total, not the page — that is the whole point.
    expect(big.json().matched).toBe(201);
    await app.close();
  });

  it("refuses a status that is not a status", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members?status=banished",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("answers 500 without leaking the database error", async () => {
    failNext = true;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/members",
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.json())).not.toContain("db down");
    await app.close();
  });
});

describe("POST /admin/reinstate/:accountId", () => {
  it("lifts a suspension and drops the cached session", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.susp}`,
      payload: { reason: "a reason, which the route now requires" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountId: ID.susp, status: "active" });
    expect(accounts.find((a) => a.id === ID.susp)!.status).toBe("active");
    // L5.5b — and they are told, with the reason the operator gave. The
    // fourth argument is L6.4's appeal options, and it is EMPTY here on
    // purpose: a reinstatement is not an action against the member, so there
    // is nothing for them to appeal and no token is minted. Pinned rather than
    // loosened to `expect.anything()`, because an appeal link appearing on a
    // reinstatement notice would be a live token handed out for no decision.
    expect(sendModerationNoticeEmail).toHaveBeenCalledWith(
      ID.susp,
      "account_reinstated",
      "a reason, which the route now requires",
      { appealUrl: undefined, appealDeadline: undefined },
    );
    // Without this the suspended row stays in the auth cache for a full TTL
    // and the member is still locked out of the session they are sitting in.
    expect(invalidateAuthCache).toHaveBeenCalledWith(ID.susp);
    await app.close();
  });

  it("lifts a moderation too — the same kind of state, imposed by us", async () => {
    accounts.find((a) => a.id === ID.susp)!.status = "moderated";
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.susp}`,
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(200);
    expect(accounts.find((a) => a.id === ID.susp)!.status).toBe("active");
    await app.close();
  });

  it("refuses an account that is already active, and says so", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.reader}`,
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "not_reinstatable",
      status: "active",
    });
    // A silent 200 would tell the operator something happened. Nothing did.
    expect(invalidateAuthCache).not.toHaveBeenCalled();
    await app.close();
  });

  it("will not undo a member's own deactivation", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.closed}`,
      payload: { reason: "a reason, which the route now requires" },
    });

    // Their decision, not ours — and they reverse it by signing back in. The
    // response names the state so the surface can say which of the three
    // refusals this is.
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("deactivated");
    expect(accounts.find((a) => a.id === ID.closed)!.status).toBe(
      "deactivated",
    );
    await app.close();
  });

  it("will not resurrect a deleted account", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.deleted}`,
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe("deleted");
    expect(accounts.find((a) => a.id === ID.deleted)!.status).toBe("deleted");
    await app.close();
  });

  it("404s on an account that does not exist", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/admin/reinstate/00000000-0000-0000-0000-000000000000",
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "account_not_found" });
    await app.close();
  });

  it("requires admin", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/reinstate/${ID.susp}`,
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(403);
    expect(accounts.find((a) => a.id === ID.susp)!.status).toBe("suspended");
    await app.close();
  });

  it("404s a MALFORMED id the same as an absent one, without touching the DB", async () => {
    // A path id answers 404, never 400 and never 500. Straight into
    // `WHERE id = $1` a non-uuid raises `invalid input syntax for type uuid`,
    // which the error funnel answers as a 500 `internal_error` — so the
    // malformed and the absent were told apart from outside, which is the
    // oracle the rule forbids.
    //
    // Asserted on the STATEMENTS, not the status: a route that ran the UPDATE
    // and let the cast raise would answer 500 here and 404 there, and both
    // would look like "it refused".
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/admin/reinstate/not-a-uuid",
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "account_not_found" });
    expect(seen).toEqual([]);
    expect(invalidateAuthCache).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /admin/suspend/:accountId", () => {
  it("404s a malformed id BEFORE the tombstone prepare", async () => {
    // Worse on this route than on its inverse: `prepareAllContentRemovalForAccount`
    // runs ahead of any existence check and signs a kind-5 through key-custody
    // per removable row, so a malformed id spent that whole errand before
    // Postgres refused the cast. The guard is what stops the work starting.
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/admin/suspend/not-a-uuid",
      payload: { reason: "a reason, which the route now requires" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "account_not_found" });
    expect(seen).toEqual([]);
    expect(withTransactionSpy).not.toHaveBeenCalled();
    await app.close();
  });

  // L5.5b — the reason is required, and nothing happens without one.
  it("refuses a suspension with NO reason, and starts no work", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/suspend/${ID.writer}`,
      // An EMPTY BODY, not an absent one. With no payload at all Fastify hands
      // the route `undefined` and the schema refuses it whatever the reason
      // field says — so the case would pass against an optional reason, which
      // is the regression it is here to catch.
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    // The refusal has to come before the tombstone prepare AND before the
    // status write: a 400 returned after either would leave a member suspended
    // and un-notified, told nothing at all.
    expect(withTransactionSpy).not.toHaveBeenCalled();
    expect(accounts.find((a) => a.id === ID.writer)!.status).toBe("active");
    expect(sendModerationNoticeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a reason that is only whitespace", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/suspend/${ID.writer}`,
      payload: { reason: "   " },
    });

    expect(res.statusCode).toBe(400);
    expect(accounts.find((a) => a.id === ID.writer)!.status).toBe("active");
    await app.close();
  });
});

describe("POST /admin/suspend/:accountId — a standing decision is not downgraded (§0z item 14)", () => {
  it("refuses to suspend a deleted account, naming the state it found", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/suspend/${ID.deleted}`,
      payload: { reason: "spam" },
    });
    // Pre-fix: 200, the row rewritten to `suspended` and a record opened
    // against an account its owner had closed.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "standing_decision", status: "deleted" });
    expect(accounts.find((a) => a.id === ID.deleted)!.status).toBe("deleted");
    expect(withTransactionSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it("control: an active member is suspended, and the write carries the guard", async () => {
    // This harness leaves the transaction spy bare (its other cases refuse
    // before any transaction opens); the control needs a real one, on the
    // same scripted table.
    const txSql: string[] = [];
    withTransactionSpy.mockImplementation(async (cb: (c: { query: typeof query }) => Promise<unknown>) =>
      cb({
        query: (sql: string, params?: unknown[]) => {
          txSql.push(sql);
          return query(sql, params);
        },
      }),
    );
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: `/admin/suspend/${ID.writer}`,
      payload: { reason: "spam" },
    });
    expect(res.statusCode).toBe(200);
    expect(accounts.find((a) => a.id === ID.writer)!.status).toBe("suspended");
    const write = txSql.find((sql) => /UPDATE accounts SET status = 'suspended'/.test(sql));
    expect(write).toMatch(/status = ANY\(\$2::account_status\[\]\)/);
    await app.close();
  });
});
