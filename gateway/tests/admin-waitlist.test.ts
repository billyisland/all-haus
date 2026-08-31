import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The waitlist panel's two halves (CLOSED-BETA-ADR §XI.2).
//
// GET /admin/dashboard/waitlist — the read half:
//   · it is behind requireAdmin — the list is prospects' email addresses, and
//     the enumeration-safety that protects POST /waitlist is worth nothing if
//     the whole table is readable without a session;
//   · newest first, because an operator picking a cohort reads down from the
//     most recent;
//   · the counts are the demand signal D2 promised and nobody has yet seen;
//   · a capped response says so (`truncated`), because a silent LIMIT reads as
//     "that's everyone" precisely when it isn't;
//   · it does NOT filter disposable domains — that is an operator's call, and
//     a route that quietly dropped rows would hide people who are waiting.
//
// POST /admin/dashboard/waitlist/remove — the other write, whose contract is
// mostly about what it REFUSES:
//   · a waiting row is deleted outright, so a re-signup can come back (a
//     tombstone would be swallowed by POST /waitlist's ON CONFLICT DO NOTHING
//     and the person would wait invisibly);
//   · an ADMITTED row is never removable — it is the record of an account that
//     exists, and the account outlives anything this panel does;
//   · the guard rides the DELETE itself, so a remove racing an admit contends
//     in the database rather than in a read-then-write window.
//
// POST /admin/dashboard/waitlist/admit — the write half, whose whole contract
// is about what happens when something goes wrong:
//   · a double-click must not mint two accounts or two invitations;
//   · a prospect who is already a member is LINKED, never duplicated;
//   · a failed email must not undo a real account — but must be reported, and
//     retryable, because an admission nobody heard about is the failure this
//     section exists to stop;
//   · a failed account create must RELEASE the claim, so the row is retryable
//     rather than stuck at "admitted" with nothing behind it.
//
// THE MOCK ANSWERS FROM THE SQL IT IS HANDED. It keeps a real in-memory table
// and honours the guards the route actually wrote: the claim's
// `admitted_at IS NULL` and the release's `admitted_account_id IS NULL` are
// read out of the query string, so a route that dropped either would fail here
// instead of passing against a fixture. (Mutation-checked: dropping the claim
// guard fails the double-click test; dropping the release fails the retry
// test.)
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

interface Row {
  id: string;
  email: string;
  created_at: Date;
  admitted_at: Date | null;
  admitted_account_id: string | null;
  invited_at: Date | null;
}

let waitlistRows: Row[] = [];
let accounts: Array<{ id: string; email: string; username: string }> = [];
let configValue: string | null = null;
let failNext = false;
let adminAllowed = true;
/** Set by the concurrency test; see the read branch in `query`. */
let selectBarrier: (() => Promise<void>) | null = null;
/** The counts query as sent — the structural pin below reads it back. */
let lastCountSql = "";

/** Hold the first `n` waitlist reads until all `n` have arrived, then let go. */
function holdReadsUntil(n: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  selectBarrier = () => {
    if (++arrived >= n) open();
    return gate;
  };
}

/**
 * Hold every waitlist read open, and say when the first one ARRIVED.
 *
 * The two-party races (an admit and a remove contending for one row) need a
 * specific order rather than a rendezvous: the admit must have LOOKED, then
 * the remove must land whole, then the admit's claim must run. Awaiting
 * `arrived` is what makes the first of those three real — without it
 * `app.inject` has not yet reached its first query when the remove runs, the
 * admit looks the address up afterwards and 404s on its own lookup, never
 * reaching the branch under test.
 */
function holdReadsManually(): { arrived: Promise<void>; release: () => void } {
  let open!: () => void;
  let announce!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (announce = r));
  selectBarrier = () => {
    announce();
    return gate;
  };
  return { arrived, release: open };
}

const provisionAccount = vi.fn(async (email: string) => {
  const account = {
    id: `acct-${accounts.length + 1}`,
    email,
    username: email.split("@")[0],
  };
  accounts.push(account);
  return { accountId: account.id, username: account.username };
});
const sendWaitlistInviteEmail = vi.fn(async (_to: string) => {});

function query(sql: string, params: unknown[] = []) {
  if (failNext) return Promise.reject(new Error("db down"));

  // --- reads -----------------------------------------------------------------
  if (sql.includes("COUNT(*)") && sql.includes("FROM waitlist")) {
    lastCountSql = sql;
    return Promise.resolve({
      rows: [
        {
          total: String(waitlistRows.length),
          joined_7d: String(waitlistRows.length),
          admitted: String(
            waitlistRows.filter((r) => r.admitted_at !== null).length,
          ),
          admitted_not_invited: String(
            waitlistRows.filter(
              (r) => r.admitted_at !== null && r.invited_at === null,
            ).length,
          ),
        },
      ],
      rowCount: 1,
    });
  }
  if (/SELECT id, admitted_at, invited_at, admitted_account_id/.test(sql)) {
    const read = () => {
      const row = waitlistRows.find((r) => r.email === params[0]);
      // A COPY, never the live row. Handing out the object itself lets one
      // request observe another's writes through shared identity — a snapshot
      // no database would ever give it, and it made a losing racer look like a
      // resend rather than a refused claim.
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    };
    // A barrier the concurrency tests install so two requests both READ before
    // either WRITES — the only interleaving in which the claim's
    // `admitted_at IS NULL` does any work. Without it the event loop runs the
    // first request to completion and the second takes the already-admitted
    // path, so a route with no claim at all would pass.
    //
    // The snapshot is taken when the read ARRIVES, not when the gate opens: a
    // held read is a request that has already looked, and its row is what it
    // saw. Resolving `read()` afterwards would hand it the post-write state
    // instead, which is how a losing racer stops looking like one — it would
    // see the deletion that beat it and 404 on its own lookup rather than
    // reaching the claim this exists to test.
    const snapshot = read();
    return selectBarrier
      ? selectBarrier().then(() => snapshot)
      : Promise.resolve(snapshot);
  }
  // The remove path's DELETE. The guard is read out of the SQL, exactly like
  // the admit claim's: drop `AND admitted_at IS NULL` from the route and this
  // mock will happily delete an admitted row, which is what the refusal test
  // then catches.
  if (/DELETE FROM waitlist/.test(sql)) {
    const i = waitlistRows.findIndex((r) => r.email === params[0]);
    if (i === -1) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/admitted_at IS NULL/.test(sql) && waitlistRows[i].admitted_at !== null) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const [gone] = waitlistRows.splice(i, 1);
    return Promise.resolve({
      rows: [{ id: gone.id, created_at: gone.created_at }],
      rowCount: 1,
    });
  }
  // The two "why did nothing happen?" read-backs. They differ by the column
  // they key on — remove looks the address up again, admit already holds the
  // row id — so dispatching on the SQL is honest here rather than a mock
  // pinning itself; both are answered from the same table either way.
  if (/SELECT admitted_at FROM waitlist WHERE email/.test(sql)) {
    const row = waitlistRows.find((r) => r.email === params[0]);
    return Promise.resolve({
      rows: row ? [{ admitted_at: row.admitted_at }] : [],
      rowCount: row ? 1 : 0,
    });
  }
  if (/SELECT admitted_at FROM waitlist WHERE id/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    return Promise.resolve({
      rows: row ? [{ admitted_at: row.admitted_at }] : [],
      rowCount: row ? 1 : 0,
    });
  }
  if (sql.includes("FROM waitlist")) {
    const limit = Number(params[0] ?? 1000);
    // Honour the ORDER BY the route actually wrote. A mock that always sorted
    // newest-first would let a route flipped to ASC pass the ordering test —
    // the same blind spot that let a missing ::timestamptz cast through in the
    // digest's suite. Where the mock CAN read the SQL, it should.
    const desc = /ORDER BY w?\.?created_at DESC/i.test(sql);
    const rows = [...waitlistRows]
      .sort((a, b) =>
        desc
          ? b.created_at.getTime() - a.created_at.getTime()
          : a.created_at.getTime() - b.created_at.getTime(),
      )
      .slice(0, limit)
      // The route LEFT JOINs accounts for the username; an unadmitted row (or
      // one whose account was deleted) resolves to null, which is the case the
      // panel reads as "admitted, account gone".
      .map((r) => ({
        ...r,
        username:
          accounts.find((a) => a.id === r.admitted_account_id)?.username ??
          null,
      }));
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (sql.includes("platform_config")) {
    return Promise.resolve({
      rows: configValue === null ? [] : [{ value: configValue }],
      rowCount: configValue === null ? 0 : 1,
    });
  }

  // --- the admit path --------------------------------------------------------
  if (/SELECT id, username FROM accounts WHERE email/.test(sql)) {
    const a = accounts.find((x) => x.email === params[0]);
    return Promise.resolve({ rows: a ? [a] : [], rowCount: a ? 1 : 0 });
  }
  if (/SELECT username FROM accounts WHERE id/.test(sql)) {
    const a = accounts.find((x) => x.id === params[0]);
    return Promise.resolve({ rows: a ? [a] : [], rowCount: a ? 1 : 0 });
  }
  if (/UPDATE waitlist SET admitted_at = now\(\)/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    // The guard is read out of the SQL, not assumed. Without it in the query,
    // this claim would succeed twice — which is the whole point of the test
    // below, and would be invisible if the mock enforced it unconditionally.
    if (/admitted_at IS NULL/.test(sql) && row.admitted_at !== null) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    row.admitted_at = new Date();
    return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
  }
  if (/UPDATE waitlist SET admitted_at = NULL/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    if (
      /admitted_account_id IS NULL/.test(sql) &&
      row.admitted_account_id !== null
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    row.admitted_at = null;
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/UPDATE waitlist SET admitted_account_id/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[1]);
    if (row) row.admitted_account_id = params[0] as string;
    return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
  }
  if (/UPDATE waitlist SET invited_at = now\(\)/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    // Same discipline as the admission claim: the guard is read out of the
    // SQL. Drop `AND invited_at IS NULL` from the route and two concurrent
    // clicks both send — which the double-click test then catches.
    if (/invited_at IS NULL/.test(sql) && row.invited_at !== null) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    row.invited_at = new Date();
    return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
  }
  if (/UPDATE waitlist SET invited_at = NULL/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (row) row.invited_at = null;
    return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendWaitlistInviteEmail: (to: string) => sendWaitlistInviteEmail(to),
}));

vi.mock("../src/lib/account-provision.js", () => ({
  provisionAccount: (email: string, displayName: string) =>
    provisionAccount(email, displayName),
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, reply: any, done: any) => {
    if (!adminAllowed) return reply.status(403).send({ error: "forbidden" });
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

const { adminDashboardRoutes } = await import(
  "../src/routes/admin-dashboard.js"
);

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  return app;
}

const T = (iso: string) => new Date(iso);

const row = (over: Partial<Row> & Pick<Row, "id" | "email">): Row => ({
  created_at: T("2026-07-27T08:47:00Z"),
  admitted_at: null,
  admitted_account_id: null,
  invited_at: null,
  ...over,
});

beforeEach(() => {
  failNext = false;
  adminAllowed = true;
  configValue = null;
  selectBarrier = null;
  accounts = [];
  provisionAccount.mockClear();
  sendWaitlistInviteEmail.mockClear();
  sendWaitlistInviteEmail.mockImplementation(async () => {});
  waitlistRows = [
    row({
      id: "w1",
      email: "early@example.com",
      created_at: T("2026-07-27T08:47:00Z"),
    }),
    row({
      id: "w2",
      email: "middle@example.com",
      created_at: T("2026-07-27T09:12:00Z"),
    }),
    row({
      id: "w3",
      email: "throwaway@example.com",
      created_at: T("2026-07-27T14:05:00Z"),
    }),
  ];
});

describe("GET /admin/dashboard/waitlist", () => {
  it("requires admin", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("returns every entry, newest first, with the counts", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: any) => e.email)).toEqual([
      "throwaway@example.com",
      "middle@example.com",
      "early@example.com",
    ]);
    expect(body.totals).toEqual({
      total: 3,
      joinedLast7d: 3,
      admitted: 0,
      admittedNotInvited: 0,
    });
    // NOTHING about publish interest, in the totals or per row: the question
    // left the page on 2026-07-27 and its tile and column went with it. toEqual
    // above already pins the totals exactly; this pins the row shape too, so
    // reinstating either half fails here.
    expect(body.entries.every((e: any) => !("publishInterest" in e))).toBe(true);
    expect(body.truncated).toBe(false);
    await app.close();
  });

  it("reports admission state per row, and who they became", async () => {
    accounts.push({ id: "acct-1", email: "early@example.com", username: "early" });
    waitlistRows[0].admitted_at = T("2026-07-27T18:00:00Z");
    waitlistRows[0].admitted_account_id = "acct-1";
    waitlistRows[0].invited_at = T("2026-07-27T18:00:05Z");
    // Admitted, but the invitation never went — the state that wants a retry.
    waitlistRows[1].admitted_at = T("2026-07-27T18:01:00Z");

    const app = await build();
    const body = (
      await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })
    ).json();

    const byEmail = Object.fromEntries(
      body.entries.map((e: any) => [e.email, e]),
    );
    expect(byEmail["early@example.com"].admittedAt).not.toBeNull();
    expect(byEmail["early@example.com"].invitedAt).not.toBeNull();
    expect(byEmail["early@example.com"].username).toBe("early");
    expect(byEmail["middle@example.com"].admittedAt).not.toBeNull();
    expect(byEmail["middle@example.com"].invitedAt).toBeNull();
    expect(byEmail["throwaway@example.com"].admittedAt).toBeNull();
    expect(body.totals.admitted).toBe(2);
    expect(body.totals.admittedNotInvited).toBe(1);
    await app.close();
  });

  it("does not filter disposable domains — that is an operator's call", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    // A route that quietly dropped these would hide someone who IS waiting,
    // and the operator would have no way to know the difference.
    expect(res.json().entries.map((e: any) => e.email)).toContain(
      "throwaway@example.com",
    );
    await app.close();
  });

  it("flags a capped list instead of silently truncating it", async () => {
    waitlistRows = Array.from({ length: 501 }, (_, i) =>
      row({ id: `w${i}`, email: `person${i}@example.com` }),
    );
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });

    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.shown).toBe(500);
    expect(body.entries).toHaveLength(500);
    // The count is the WHOLE list, so the panel can say how many are hidden.
    expect(body.totals.total).toBe(501);
    await app.close();
  });

  it("reports when the operator was last told, and null when never", async () => {
    const app = await build();
    expect(
      (
        await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })
      ).json().lastDigestAt,
    ).toBeNull();

    configValue = "2026-07-27T09:00:00.000Z";
    expect(
      (
        await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })
      ).json().lastDigestAt,
    ).toBe("2026-07-27T09:00:00.000Z");
    await app.close();
  });

  it("asks Postgres for each count with a FILTER — A STRUCTURAL PIN", async () => {
    // NOT A BEHAVIOURAL TEST, and it should not be read as one. A FILTER is
    // evaluated by Postgres and nothing else, so the mock cannot derive these
    // counts from the query the way it derives the ORDER BY — it computes them
    // from its own rows, which means a route that replaced a FILTER with a
    // literal would still return the mock's number and every count assertion
    // above would stay green. (It did: that mutation was the one survivor of
    // the sweep.) This pins the SHAPE of the query instead, and the real
    // arithmetic is covered by the DB-backed drive, not here.
    const app = await build();
    await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" });

    expect(lastCountSql).toMatch(
      /FILTER \(WHERE created_at > now\(\) - interval '7 days'\) AS joined_7d/,
    );
    // No publish-interest aggregate: the question left the page on 2026-07-27,
    // so the route must stop counting it rather than report on something
    // nobody is being asked.
    expect(lastCountSql).not.toMatch(/publish_interest/);
    expect(lastCountSql).toMatch(
      /FILTER \(WHERE admitted_at IS NOT NULL\) AS admitted/,
    );
    expect(lastCountSql).toMatch(
      /FILTER \(WHERE admitted_at IS NOT NULL AND invited_at IS NULL\) AS admitted_not_invited/,
    );
    await app.close();
  });

  it("500s rather than rendering a half-read list", async () => {
    failNext = true;
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

const admit = (app: any, email: string) =>
  app.inject({
    method: "POST",
    url: "/admin/dashboard/waitlist/admit",
    payload: { email },
  });

/** Admit through the real route, asserting it worked — a fixture, not a test. */
async function admitVia(app: any, email: string) {
  const res = await admit(app, email);
  expect(res.statusCode).toBe(200);
}

describe("POST /admin/dashboard/waitlist/admit", () => {

  it("requires admin — this one creates accounts and emails strangers", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await admit(app, "early@example.com");
    expect(res.statusCode).toBe(403);
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates the account, stamps the row, and sends the invitation", async () => {
    const app = await build();
    const res = await admit(app, "early@example.com");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: "early@example.com",
      admitted: true,
      accountCreated: true,
      username: "early",
      invited: true,
    });
    expect(provisionAccount).toHaveBeenCalledTimes(1);
    expect(sendWaitlistInviteEmail).toHaveBeenCalledWith("early@example.com");

    const r = waitlistRows[0];
    expect(r.admitted_at).not.toBeNull();
    expect(r.admitted_account_id).toBe("acct-1");
    expect(r.invited_at).not.toBeNull();
    await app.close();
  });

  it("matches the stored lower-cased address whatever the operator types", async () => {
    const app = await build();
    const res = await admit(app, "  Early@Example.COM ");
    expect(res.statusCode).toBe(200);
    expect(waitlistRows[0].admitted_at).not.toBeNull();
    await app.close();
  });

  it("links an existing member instead of minting a second account", async () => {
    // The likely first real case: the operator joined their own waiting list
    // while testing the form. accounts.email is unique, so a blind insert here
    // would 500 — and a second account for one person is worse than the 500.
    accounts.push({
      id: "acct-existing",
      email: "early@example.com",
      username: "ed",
    });

    const app = await build();
    const res = await admit(app, "early@example.com");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      accountCreated: false,
      username: "ed",
      invited: true,
    });
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(waitlistRows[0].admitted_account_id).toBe("acct-existing");
    await app.close();
  });

  it("refuses a second admit of an already-admitted-and-invited row", async () => {
    const app = await build();
    await admit(app, "early@example.com");
    sendWaitlistInviteEmail.mockClear();
    provisionAccount.mockClear();

    const res = await admit(app, "early@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_admitted");
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("absorbs a double-click: two reads before either claim make ONE account", async () => {
    // THE INTERLEAVING IS FORCED, NOT HOPED FOR. Left to the event loop the
    // first request runs to completion before the second issues a query, and
    // the second then takes the plain already-admitted path — so this test
    // passed against a route whose claim had no `admitted_at IS NULL` guard at
    // all. Holding both reads open until both have arrived is the only
    // arrangement in which the claim is what decides, and it kills that
    // mutation.
    holdReadsUntil(2);

    const app = await build();
    const [a, b] = await Promise.all([
      admit(app, "early@example.com"),
      admit(app, "early@example.com"),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(provisionAccount).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(1);
    expect(sendWaitlistInviteEmail).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("sends no duplicate when a second click lands mid-admission", async () => {
    // The other window, and the one the invite claim closes: the second click
    // arrives AFTER the first has claimed the admission but BEFORE it has
    // sent. Read naively that row says "admitted, never told" — the exact
    // shape of a resend — so without a claim on the invitation too, the
    // prospect gets two identical emails.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    provisionAccount.mockImplementationOnce(async (email: string) => {
      await held;
      const account = {
        id: `acct-${accounts.length + 1}`,
        email,
        username: email.split("@")[0],
      };
      accounts.push(account);
      return { accountId: account.id, username: account.username };
    });

    const app = await build();
    const first = admit(app, "early@example.com");
    await new Promise((r) => setTimeout(r, 0));
    const second = admit(app, "early@example.com");
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([first, second]);

    expect(sendWaitlistInviteEmail).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(1);
    expect(waitlistRows[0].admitted_account_id).toBe("acct-1");
    expect(waitlistRows[0].invited_at).not.toBeNull();
    await app.close();
  });

  it("sends one email when two resends of the same row race", async () => {
    // Two clicks on "Send invite" for a row that IS fully admitted and simply
    // never heard. Both pass every check — the account exists, the invitation
    // is outstanding — so the invite claim is the only thing standing between
    // this prospect and two identical emails.
    accounts.push({
      id: "acct-existing",
      email: "early@example.com",
      username: "ed",
    });
    waitlistRows[0].admitted_at = T("2026-07-27T18:00:00Z");
    waitlistRows[0].admitted_account_id = "acct-existing";
    holdReadsUntil(2);

    const app = await build();
    const [a, b] = await Promise.all([
      admit(app, "early@example.com"),
      admit(app, "early@example.com"),
    ]);

    expect(sendWaitlistInviteEmail).toHaveBeenCalledTimes(1);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(waitlistRows[0].invited_at).not.toBeNull();
    await app.close();
  });

  it("refuses to invite a row stamped with no account behind it", async () => {
    // The half-done state: admitted_at set, no account. Reachable only if a
    // provisioning failure's release ALSO failed (which logs loudly), or
    // momentarily while another click is mid-flight. Inviting here would send
    // someone to a login page for an account that may not exist.
    waitlistRows[0].admitted_at = T("2026-07-27T18:00:00Z");

    const app = await build();
    const res = await admit(app, "early@example.com");

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("admit_in_progress");
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps the admission when the invitation fails, and says so", async () => {
    sendWaitlistInviteEmail.mockRejectedValueOnce(new Error("postmark down"));
    const app = await build();
    const res = await admit(app, "early@example.com");

    // The account is real and the person is a member — the courtesy failed,
    // not the admission. A 500 here would invite a retry that double-creates.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ admitted: true, invited: false });
    expect(waitlistRows[0].admitted_at).not.toBeNull();
    expect(waitlistRows[0].admitted_account_id).toBe("acct-1");
    expect(waitlistRows[0].invited_at).toBeNull();
    await app.close();
  });

  it("resends to an admitted-but-never-told row without touching the account", async () => {
    sendWaitlistInviteEmail.mockRejectedValueOnce(new Error("postmark down"));
    const app = await build();
    await admit(app, "early@example.com");
    provisionAccount.mockClear();

    const res = await admit(app, "early@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      invited: true,
      accountCreated: false,
      username: "early",
    });
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(accounts).toHaveLength(1);
    expect(waitlistRows[0].invited_at).not.toBeNull();
    await app.close();
  });

  it("releases the claim when provisioning fails, so a retry works", async () => {
    provisionAccount.mockRejectedValueOnce(new Error("key-custody down"));
    const app = await build();

    const first = await admit(app, "early@example.com");
    expect(first.statusCode).toBe(500);
    // Not stuck at "admitted" with nothing behind it — that row would need a
    // human with psql, which is the situation this panel exists to end.
    expect(waitlistRows[0].admitted_at).toBeNull();
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();

    const second = await admit(app, "early@example.com");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accountCreated: true, invited: true });
    await app.close();
  });

  it("404s an address that never joined the list", async () => {
    const app = await build();
    const res = await admit(app, "stranger@example.com");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_on_list");
    expect(provisionAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it("400s a malformed address rather than looking it up", async () => {
    const app = await build();
    const res = await admit(app, "not-an-email");
    expect(res.statusCode).toBe(400);
    expect(provisionAccount).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /admin/dashboard/waitlist/remove", () => {
  const remove = (app: any, email: string) =>
    app.inject({
      method: "POST",
      url: "/admin/dashboard/waitlist/remove",
      payload: { email },
    });

  it("requires admin — the list is prospects' addresses", async () => {
    adminAllowed = false;
    const app = await build();
    const res = await remove(app, "throwaway@example.com");
    expect(res.statusCode).toBe(403);
    expect(waitlistRows).toHaveLength(3);
    await app.close();
  });

  it("deletes a waiting row, and it is gone from the list", async () => {
    const app = await build();
    const res = await remove(app, "throwaway@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      email: "throwaway@example.com",
      removed: true,
    });

    // A hard delete, not a flag: the row is not in the table, so nothing about
    // the address survives to swallow a later signup.
    expect(waitlistRows.map((r) => r.email)).toEqual([
      "early@example.com",
      "middle@example.com",
    ]);

    const list = await app.inject({
      method: "GET",
      url: "/admin/dashboard/waitlist",
    });
    expect(list.json().entries.map((e: any) => e.email)).not.toContain(
      "throwaway@example.com",
    );
    expect(list.json().totals.total).toBe(2);
    await app.close();
  });

  it("matches the stored lower-cased address whatever the operator types", async () => {
    const app = await build();
    const res = await remove(app, "  Throwaway@Example.COM ");
    expect(res.statusCode).toBe(200);
    expect(waitlistRows).toHaveLength(2);
    await app.close();
  });

  it("refuses an admitted row, and leaves it exactly where it was", async () => {
    const app = await build();
    await admitVia(app, "early@example.com");
    const res = await remove(app, "early@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_admitted");
    // The record of the admission survives, account and all. Mutation-checked:
    // drop `AND admitted_at IS NULL` from the route's DELETE and this row
    // disappears while its account stays a member.
    expect(waitlistRows.find((r) => r.email === "early@example.com")).toBeTruthy();
    expect(accounts).toHaveLength(1);
    await app.close();
  });

  it("refuses a row that is admitted but not yet invited", async () => {
    // The half-state the panel offers a retry on. It is still an account we
    // made, so it is no more removable than a fully invited one.
    const app = await build();
    sendWaitlistInviteEmail.mockRejectedValueOnce(new Error("postmark down"));
    await admitVia(app, "early@example.com");
    const res = await remove(app, "early@example.com");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_admitted");
    await app.close();
  });

  it("404s an address that never joined the list", async () => {
    const app = await build();
    const res = await remove(app, "stranger@example.com");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_on_list");
    expect(waitlistRows).toHaveLength(3);
    await app.close();
  });

  it("404s a second remove of the same row rather than reporting a delete", async () => {
    const app = await build();
    expect((await remove(app, "throwaway@example.com")).statusCode).toBe(200);
    const res = await remove(app, "throwaway@example.com");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_on_list");
    await app.close();
  });

  it("400s a malformed address rather than deleting anything", async () => {
    const app = await build();
    const res = await remove(app, "not-an-email");
    expect(res.statusCode).toBe(400);
    expect(waitlistRows).toHaveLength(3);
    await app.close();
  });

  it("creates no account and sends no email — ever", async () => {
    const app = await build();
    await remove(app, "throwaway@example.com");
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("an admit that loses its row to a remove says so, and mints nothing", async () => {
    // The interleaving that only exists now that removal does: admit reads the
    // row, remove deletes it, admit's claim finds nothing to stamp. Reporting
    // "already admitted" there would tell the operator someone is a member
    // when no account was created at all.
    const app = await build();
    const { arrived, release } = holdReadsManually();

    const admitting = admit(app, "throwaway@example.com");
    await arrived;
    const removed = await remove(app, "throwaway@example.com");
    expect(removed.statusCode).toBe(200);

    release();
    const res = await admitting;
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("removed_meanwhile");
    // Mutation-checked: return the old bare 409 from the claim-loss branch and
    // this fails on both the code and the status.
    expect(provisionAccount).not.toHaveBeenCalled();
    expect(sendWaitlistInviteEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("still reports already_admitted when the claim loses to another ADMIT", async () => {
    // The control for the test above: the same branch, the other cause. Both
    // read-backs have to be exercised or 'removed_meanwhile' could simply have
    // replaced the 409 outright.
    const app = await build();
    holdReadsUntil(2);
    const [a, b] = await Promise.all([
      admit(app, "early@example.com"),
      admit(app, "early@example.com"),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("already_admitted");
    expect(provisionAccount).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
