import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// PATCH /publications/:id/members/:memberId must never write revenue_share_bps.
//
// WHY THIS FILE EXISTS. That route is gated on `can_manage_members` and, until
// 2026-08-06, carried `revenueShareBps` in its fieldMap — so a members-manager
// holding NO finance mandate could move a member's standing share of every
// future publication payout. The M9 escalation guard could not see it: M9
// guards permission GRANTS, and revenue_share_bps is not a permission. Nothing
// in the web client ever sent the field (the only writer is `updatePayroll` →
// the can_manage_finances-gated PATCH /payroll), so the hole was reachable
// only by hand — which is exactly the caller it mattered against.
//
// It is a MANDATE hole, not a money-math bug: the Σ ≤ 10000 clamp and the
// pub_shares advisory lock both held. So what this file pins is *who* may
// write, not *what* arithmetic results — and it matters more once
// PAYMENT-PERIMETER-ADR §3.W5 stamps split versions with `set_by`, where a
// version is only mandate evidence if its author actually held the mandate.
//
// The scripted client answers from the SQL it is handed and records every
// statement, so the assertion is over the UPDATE production really issues.
// Mutate `revenueShareBps: 'revenue_share_bps'` back into the fieldMap (and the
// field back into UpdateMemberSchema) and test 1 goes red.
// =============================================================================

let calls: Array<{ sql: string; params: unknown[] }> = [];

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
  // The route's own pre-checks, answered from the SQL:
  if (sql.includes("SELECT is_owner FROM publication_members"))
    return Promise.resolve({ rows: [{ is_owner: false }], rowCount: 1 });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params) },
  withTransaction: (cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const EDITOR = "00000000-0000-4000-8000-00000000aaaa";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: EDITOR };
  },
}));

// A members-manager with NO finance mandate — the caller the hole was open to.
vi.mock("../src/middleware/publication-auth.js", () => ({
  requirePublicationPermission: () => async (req: Record<string, unknown>) => {
    req.publicationMember = {
      id: "pm-editor",
      is_owner: false,
      can_publish: true,
      can_edit_others: true,
      can_manage_members: true,
      can_manage_finances: false,
      can_manage_settings: false,
    };
  },
  requirePublicationOwner: () => async () => {},
}));

const { publicationMembersRoutes } = await import(
  "../src/routes/publications/members.js"
);

const PUB = "00000000-0000-4000-8000-00000000bbbb";
const MEMBER = "00000000-0000-4000-8000-00000000cccc";

async function buildApp() {
  const app = Fastify();
  await app.register(publicationMembersRoutes);
  await app.ready();
  return app;
}

function updateStatements() {
  return calls.filter((c) => /UPDATE publication_members SET/.test(c.sql));
}

beforeEach(() => {
  calls = [];
});

describe("PATCH /publications/:id/members/:memberId — finance mandate", () => {
  it("ignores revenueShareBps: no UPDATE touches revenue_share_bps, and the value never reaches Postgres", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/publications/${PUB}/members/${MEMBER}`,
      payload: { title: "Deputy Editor", revenueShareBps: 9000 },
    });

    expect(res.statusCode).toBe(200);

    const updates = updateStatements();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).not.toContain("revenue_share_bps");
    // Not merely absent from the SET list — absent from the bound params too,
    // so no rewrite of the clause builder can smuggle it in positionally.
    expect(updates[0].params).not.toContain(9000);

    // And the finance path's own guard machinery is never reached: no Σ read,
    // no pub_shares lock. Their presence would mean the field is live again.
    expect(calls.some((c) => /SUM\(revenue_share_bps\)/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /pub_shares/.test(c.sql))).toBe(false);

    await app.close();
  });

  it("still writes the membership fields the route does own", async () => {
    // The paired control: a route that had stopped writing ANYTHING would pass
    // test 1 for the wrong reason.
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/publications/${PUB}/members/${MEMBER}`,
      payload: { title: "Deputy Editor", canEditOthers: true },
    });

    expect(res.statusCode).toBe(200);
    const updates = updateStatements();
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("title = $");
    expect(updates[0].sql).toContain("can_edit_others = $");
    expect(updates[0].params).toContain("Deputy Editor");

    await app.close();
  });

  it("a body carrying ONLY revenueShareBps is a 400, not a silent success", async () => {
    // With the field gone from the schema it strips to {}, so the route's
    // existing "No fields to update" arm answers — the caller is told nothing
    // happened rather than being left to believe the share moved.
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/publications/${PUB}/members/${MEMBER}`,
      payload: { revenueShareBps: 9000 },
    });

    expect(res.statusCode).toBe(400);
    expect(updateStatements()).toHaveLength(0);

    await app.close();
  });
});
