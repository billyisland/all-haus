import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// AN OPERATOR ACT THAT MOVES MONEY LEAVES EVIDENCE (L5.2, migration 209).
//
// Two acts change what the platform does with other people's money without
// touching a line of code: editing a `platform_config` dial, and releasing a
// payout halt. Both recorded a pino line and nothing else — retention-bounded,
// outside the transaction, unqueryable beside the row it describes, and silent
// about WHY, the config editor having had no reason field at all. So the
// platform could not answer "who changed the fee rate, when, from what, and
// what did they say they were doing".
//
// WHAT THIS FILE ASSERTS IS WHAT REACHED THE DATABASE. A refusal that returns
// 400 after writing the dial is not a refusal, and an audit row written outside
// the transaction is not evidence — so every case reads the captured statements
// IN ORDER and checks which client issued them.
//
// THE MOCK ANSWERS FROM THE SQL AND THE PARAMS. `platform_config` is a real
// in-memory table here: the pre-read answers from the keys the route asked for,
// the UPDATE moves the value and reports its own `rowCount`, and the audit
// INSERT is captured with its parameters. A fixture that answered regardless of
// the key could not tell a route that audited the wrong dial from one that
// audited the right one.
//
// The halt-release proxies are asserted on the BODY they forward, because the
// whole point of routing the release through the gateway is the one thing the
// payment service cannot know: which admin asked.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

interface Stmt {
  sql: string;
  params: unknown[];
  /** Was it issued on the transaction's client, or on the bare pool? */
  inTxn: boolean;
}

/** Every statement, in order. The instrument. */
let stmts: Stmt[] = [];
/** Make the next config_audit INSERT fail, as a dropped connection would. */
let auditFails = false;
/** The live `platform_config` table. */
let config: Record<string, string> = {};

function run(sql: string, params: unknown[], inTxn: boolean) {
  stmts.push({ sql, params: [...params], inTxn });

  if (/SELECT key, value FROM platform_config WHERE key = ANY/.test(sql)) {
    const keys = params[0] as string[];
    return Promise.resolve({
      rows: keys.filter((k) => k in config).map((k) => ({ key: k, value: config[k] })),
      rowCount: keys.filter((k) => k in config).length,
    });
  }

  if (/UPDATE platform_config SET value/.test(sql)) {
    const [key, value] = params as [string, string];
    // rowCount answered from the table, so the route's "vanished mid-update"
    // guard is exercised by reality rather than by a constant.
    if (!(key in config)) return Promise.resolve({ rows: [], rowCount: 0 });
    config[key] = value;
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  if (/INSERT INTO config_audit/.test(sql)) {
    if (auditFails) return Promise.reject(new Error("connection lost"));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[] = []) => run(sql, params, false) },
  withTransaction: (cb: (c: { query: typeof run }) => Promise<unknown>) =>
    cb({
      query: ((sql: string, params: unknown[] = []) =>
        run(sql, params, true)) as unknown as typeof run,
    }),
  loadConfig: vi.fn(async () => ({})),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/platform-config.js", () => ({
  invalidatePlatformConfig: vi.fn(),
  getPlatformConfig: vi.fn(async () => new Map()),
}));

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: ADMIN };
    done();
  },
  getAdminIds: () => Promise.resolve([ADMIN]),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: ADMIN };
    done();
  },
  optionalAuth: (_req: any, _reply: any, done: any) => done(),
  invalidateAuthCache: vi.fn(),
}));

/** What the gateway sent the payment service, per call. */
let proxied: { url: string; body: unknown }[] = [];
/**
 * What the payment service answers next. Settable because the freeze's most
 * important answer is a REFUSAL — a 409 saying the account was already frozen
 * by somebody else — and a proxy that swallowed it would tell the operator
 * their freeze is in force when it is not theirs.
 */
let upstream: { status: number; body: unknown } = { status: 200, body: { resumed: true } };
const fetchMock = vi.fn(async (url: string, init: any) => {
  proxied.push({ url, body: init?.body ? JSON.parse(init.body) : null });
  return {
    status: upstream.status,
    json: async () => upstream.body,
  } as unknown as Response;
});
vi.stubGlobal("fetch", fetchMock);

const { adminDashboardRoutes } = await import("../src/routes/admin-dashboard.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  return app;
}

async function patchConfig(payload: unknown) {
  const app = await build();
  const res = await app.inject({
    method: "PATCH",
    url: "/admin/dashboard/config",
    payload: payload as Record<string, unknown>,
  });
  await app.close();
  return res;
}

const audits = () => stmts.filter((s) => /INSERT INTO config_audit/.test(s.sql));
const updates = () => stmts.filter((s) => /UPDATE platform_config/.test(s.sql));

beforeEach(() => {
  auditFails = false;
  stmts = [];
  proxied = [];
  fetchMock.mockClear();
  upstream = { status: 200, body: { resumed: true } };
  config = { platform_fee_bps: "800", tab_ceiling_pence: "800" };
});

// -----------------------------------------------------------------------------
describe("PATCH /admin/dashboard/config — a reason is required", () => {
  it("refuses an edit with no reason at all, and writes NOTHING", async () => {
    const res = await patchConfig({ updates: [{ key: "platform_fee_bps", value: "1000" }] });

    expect(res.statusCode).toBe(400);
    // The assertion that makes this a test of a refusal: a 400 returned AFTER
    // the UPDATE would leave the fee rate changed and unaccounted for.
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(config.platform_fee_bps).toBe("800");
  });

  it("refuses a reason that is only whitespace", async () => {
    // A required field that accepts " " is required in name only. The schema
    // trims BEFORE the length check, so this is refused at the same door.
    const res = await patchConfig({
      updates: [{ key: "platform_fee_bps", value: "1000" }],
      reason: "   ",
    });

    expect(res.statusCode).toBe(400);
    expect(updates()).toHaveLength(0);
    expect(config.platform_fee_bps).toBe("800");
  });
});

describe("PATCH /admin/dashboard/config — a whole-number dial takes a whole number (CA-F2)", () => {
  it("refuses '20.00' for a pence dial and writes NOTHING — it was accepted and read as 20p", async () => {
    const res = await patchConfig({
      updates: [{ key: "tab_ceiling_pence", value: "20.00" }],
      reason: "typed in pounds by mistake",
    });
    expect(res.statusCode).toBe(400);
    expect(updates()).toHaveLength(0);
    expect(config.tab_ceiling_pence).toBe("800");
  });

  it("control: a fractional dial still takes a decimal", async () => {
    config.feed_gravity = "1.5";
    const res = await patchConfig({
      updates: [{ key: "feed_gravity", value: "1.8" }],
      reason: "retuning decay",
    });
    expect(res.statusCode).toBe(200);
    expect(config.feed_gravity).toBe("1.8");
  });
});

describe("PATCH /admin/dashboard/config — the record", () => {
  it("writes the audit row in the SAME TRANSACTION as the change", async () => {
    const res = await patchConfig({
      updates: [{ key: "platform_fee_bps", value: "1000" }],
      reason: "dropping the rate for the next quarter",
    });

    expect(res.statusCode).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    // Both on the transaction's client. Written on the pool, a crash between
    // them leaves a change nobody can account for or a record of one that never
    // happened — and afterwards no way to tell which.
    expect(updates()[0].inTxn).toBe(true);
    expect(audits()[0].inTxn).toBe(true);
    // And the audit follows the UPDATE it describes, in one transaction.
    expect(stmts.indexOf(audits()[0])).toBeGreaterThan(stmts.indexOf(updates()[0]));
  });

  it("records the actor, the key, BOTH values and the reason", async () => {
    await patchConfig({
      updates: [{ key: "platform_fee_bps", value: "1000" }],
      reason: "raising the fee for the next quarter",
    });

    const [actor, key, subject, oldValue, newValue, reason] = audits()[0].params;
    expect(actor).toBe(ADMIN);
    expect(key).toBe("platform_fee_bps");
    // Platform-wide: the subject column is for the W4 per-account halt.
    expect(subject).toBeNull();
    // The OLD value is what makes this evidence rather than a note — without
    // it the row says a change happened and not what changed.
    expect(oldValue).toBe("800");
    expect(newValue).toBe("1000");
    expect(reason).toBe("raising the fee for the next quarter");
  });

  it("records one row per dial in a batch, all under the one reason", async () => {
    // The batch is the operator's act, so it takes one reason — but the record
    // is per dial, because "what has ever happened to this key" is the question
    // the table is asked.
    await patchConfig({
      updates: [
        { key: "platform_fee_bps", value: "900" },
        { key: "tab_ceiling_pence", value: "1200" },
      ],
      reason: "quarterly retune",
    });

    expect(audits()).toHaveLength(2);
    expect(audits().map((a) => a.params[1])).toEqual([
      "platform_fee_bps",
      "tab_ceiling_pence",
    ]);
    expect(audits().every((a) => a.params[5] === "quarterly retune")).toBe(true);
  });

  it("records NOTHING for a value that did not change", async () => {
    // A no-op edit changed nothing, so there is nothing to account for. A row
    // here would make the log read as a history of decisions that were never
    // taken.
    const res = await patchConfig({
      updates: [
        { key: "platform_fee_bps", value: "800" }, // unchanged
        { key: "tab_ceiling_pence", value: "1200" },
      ],
      reason: "only the ceiling",
    });

    expect(res.statusCode).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0].params[1]).toBe("tab_ceiling_pence");
  });

  it("refuses an unknown key before anything is written — the reason does not buy an INSERT", async () => {
    const res = await patchConfig({
      updates: [{ key: "a_dial_that_does_not_exist", value: "1" }],
      reason: "a good reason for a bad key",
    });

    expect(res.statusCode).toBe(400);
    expect(updates()).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
describe("POST /admin/dashboard/resume-payouts — the halt release", () => {
  async function resume(url: string, payload: unknown) {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url,
      payload: payload as Record<string, unknown>,
    });
    await app.close();
    return res;
  }

  it("forwards the ADMIN'S OWN id and the reason, and never the service token as the actor", async () => {
    const res = await resume("/admin/dashboard/resume-payouts", {
      reason: "reconciled the orphan by hand",
    });

    expect(res.statusCode).toBe(200);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].url).toContain("/payouts/resume");
    expect(proxied[0].body).toEqual({
      actorId: ADMIN,
      reason: "reconciled the orphan by hand",
    });
  });

  it("refuses a release with no reason, and calls the payment service NOT AT ALL", async () => {
    const res = await resume("/admin/dashboard/resume-payouts", {});

    expect(res.statusCode).toBe(400);
    // The refusal has to happen before the proxy: a release forwarded and then
    // reported as a 400 would resume payouts and tell the operator it had not.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the per-account release carries its account in the PATH and the actor in the body", async () => {
    const account = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const res = await resume(`/admin/dashboard/resume-payouts/${account}`, {
      reason: "this writer's divergence was a stale pending payout",
    });

    expect(res.statusCode).toBe(200);
    expect(proxied[0].url).toContain(`/payouts/resume/${account}`);
    expect((proxied[0].body as { actorId: string }).actorId).toBe(ADMIN);
  });

  it("answers 404 for a malformed account id, without calling the payment service", async () => {
    // The path-id rule: a malformed id and an absent one answer alike, and
    // neither spends a round trip.
    const res = await resume("/admin/dashboard/resume-payouts/not-a-uuid", {
      reason: "a reason",
    });

    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe("POST /admin/dashboard/halt-payouts/:accountId — the freeze itself", () => {
  // The release's inverse, and the one that had no route at all: D9 §4.1 shipped
  // with an INSERT written out in it for the operator to paste into psql. Same
  // proxy discipline — the gateway decides nothing except WHO — plus a class,
  // which is what separates an operator's legal hold from the reconciler's
  // books divergence in the table they share.
  const ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  async function halt(url: string, payload: unknown) {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url,
      payload: payload as Record<string, unknown>,
    });
    await app.close();
    return res;
  }

  it("forwards the admin's own id, the reason AND the class", async () => {
    upstream = { status: 200, body: { halted: true, accountId: ACCOUNT } };
    const res = await halt(`/admin/dashboard/halt-payouts/${ACCOUNT}`, {
      reason: "OFSI suspected match, ref 44",
      mismatchClass: "sanctions_review",
    });

    expect(res.statusCode).toBe(200);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].url).toContain(`/payouts/halt/${ACCOUNT}`);
    expect(proxied[0].body).toEqual({
      actorId: ADMIN,
      reason: "OFSI suspected match, ref 44",
      mismatchClass: "sanctions_review",
    });
  });

  it("refuses a freeze with no reason, and calls the payment service NOT AT ALL", async () => {
    // The refusal has to happen before the proxy. Forwarded and then reported
    // as a 400, it would freeze a writer's money and tell the operator it had
    // not — which is the direction nobody re-checks.
    const res = await halt(`/admin/dashboard/halt-payouts/${ACCOUNT}`, {
      mismatchClass: "sanctions_review",
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a class outside the vocabulary — including a reconciler's own", async () => {
    // `ledger_orphans` is what the reconciler writes when the books do not
    // balance. An operator able to send it could file a legal hold as a books
    // problem, which is exactly the confusion the class exists to prevent.
    const res = await halt(`/admin/dashboard/halt-payouts/${ACCOUNT}`, {
      reason: "a reason",
      mismatchClass: "ledger_orphans",
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a freeze with no class at all rather than choosing one", async () => {
    const res = await halt(`/admin/dashboard/halt-payouts/${ACCOUNT}`, {
      reason: "a reason",
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed account id, without calling the payment service", async () => {
    const res = await halt("/admin/dashboard/halt-payouts/not-a-uuid", {
      reason: "a reason",
      mismatchClass: "sanctions_review",
    });

    expect(res.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes the upstream REFUSAL through, status and body, rather than flattening it", async () => {
    // 409 means the account was already frozen — by the reconciler, or by
    // another operator. The class in that body is what stops the operator
    // releasing somebody else's halt believing they are undoing their own, so
    // it has to survive the proxy.
    upstream = {
      status: 409,
      body: {
        halted: false,
        error: "already_halted",
        mismatchClass: "ledger_orphans",
        reason: "orphaned writer_payout entry 7",
        since: "2026-09-01T00:00:00.000Z",
      },
    };
    const res = await halt(`/admin/dashboard/halt-payouts/${ACCOUNT}`, {
      reason: "OFSI suspected match, ref 44",
      mismatchClass: "sanctions_review",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "already_halted",
      mismatchClass: "ledger_orphans",
    });
  });
});

// -----------------------------------------------------------------------------
// The manual triggers (walkthrough A17). They change no dial — they run a cron
// cycle early — but at the card networks that is a decision, so each takes a
// reason and writes a REQUEST-shaped row before anything runs. The order is
// the assertion: the row first, in a transaction, then the proxy; and a row
// that cannot be written means the proxy is never called.
//
// MUTATION CHECK: move the audit write after the proxy and "records before it
// runs" fails; drop the catch's early return and "nothing runs" fails; drop the
// reason from the zod schema and the 400 cases fail.
// -----------------------------------------------------------------------------
describe.each([
  {
    route: "/admin/dashboard/trigger-settlements",
    key: "operator_trigger:settlement",
    upstreamPath: "/settlement-check/monthly",
  },
  {
    route: "/admin/dashboard/trigger-payouts",
    key: "operator_trigger:payout",
    upstreamPath: "/payout-cycle",
  },
])("POST $route — a manual trigger", ({ route, key, upstreamPath }) => {
  async function press(payload: unknown) {
    const app = await build();
    return app.inject({ method: "POST", url: route, payload: payload as object });
  }

  it.each([{}, { reason: "" }, { reason: "   \n" }])(
    "refuses %j without writing or proxying anything",
    async (payload) => {
      const res = await press(payload);
      expect(res.statusCode).toBe(400);
      expect(stmts).toHaveLength(0);
      expect(proxied).toHaveLength(0);
    },
  );

  it("records the request, in a transaction, BEFORE it runs — and forwards who and why", async () => {
    upstream = { status: 200, body: { ok: true } };
    const order: string[] = [];
    fetchMock.mockImplementationOnce(async (url: string, init: any) => {
      order.push(`proxy after ${stmts.length} stmt(s)`);
      proxied.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    });

    const res = await press({ reason: "  cron missed the 1st  " });
    expect(res.statusCode).toBe(200);

    const audits = stmts.filter((s) => /INSERT INTO config_audit/.test(s.sql));
    expect(audits).toHaveLength(1);
    expect(audits[0].inTxn).toBe(true);
    // actor, key, subject, old, new, reason
    expect(audits[0].params).toEqual([ADMIN, key, null, null, "requested", "cron missed the 1st"]);
    expect(order).toEqual(["proxy after 1 stmt(s)"]);

    expect(proxied).toHaveLength(1);
    expect(proxied[0].url).toMatch(new RegExp(`${upstreamPath.replace(/\//g, "\\/")}$`));
    expect(proxied[0].body).toEqual({ actorId: ADMIN, reason: "cron missed the 1st" });
  });

  it("runs NOTHING when the record cannot be written, and says so", async () => {
    auditFails = true;
    const res = await press({ reason: "month end" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("not_recorded");
    expect(proxied).toHaveLength(0);
  });

  it("answers an unreachable payment service as MAY HAVE RUN, never as failed", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const res = await press({ reason: "month end" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("upstream_ambiguous");
    expect(res.json().message).toMatch(/may have run/);
  });
});
