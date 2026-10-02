import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// The writers' waiting list (READER-WRITER-SPLIT-ADR §8, reshape D3).
//
// DB-BACKED, because the guarantees are Postgres's: the primary key that makes
// applying idempotent, the INSERT … SELECT that admits only a reader, the
// UPDATE claim that lets exactly one of two concurrent grants record anything,
// and the one transaction the column, the application's stamp and the
// `config_audit` row commit in. A mocked pool would answer each from the mock.
//
// The contract:
//   · a reader applies with one press; a second press answers the first row;
//   · a writer applying is 409 `already_writer`, and no row is written;
//   · the admin list is oldest first and leaves a deleted account out;
//   · a grant sets the column and its `_by`, stamps the application, writes
//     one `config_audit` row carrying the reason, and emails AFTER commit;
//   · a second grant is refused (409) and records nothing;
//   · no application → 404 and nothing changes; a blank reason → 400;
//   · a failed email leaves the grant standing and says so;
//   · two grants at once: one granted, one refused, one audit row.
//
// `config_audit` is append-only with plain FKs to actor and subject, so an
// audited fixture account stays (seed-on-admit's convention).
//
// Run locally (both vars):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/writer-applications.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.APP_URL ??= "http://app.test";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let adminId = "unset";
let memberId = "unset";
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: adminId };
    done();
  },
  getAdminIds: () => Promise.resolve([adminId]),
  invalidateAdminIdsCache: () => {},
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: memberId };
    done();
  },
  optionalAuth: (_req: any, _reply: any, done: any) => done(),
  invalidateAuthCache: () => {},
}));

const sendWriterAccessGrantedEmail = vi.fn(async (_to: string) => {});
vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendWaitlistInviteEmail: async () => {},
  sendWriterAccessGrantedEmail: (to: string) => sendWriterAccessGrantedEmail(to),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => {
  const l = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => l };
  return { default: l };
});

const { writerApplicationRoutes } = await import("../src/routes/writer-applications.js");
const { adminDashboardRoutes } = await import("../src/routes/admin-dashboard.js");
const { pendingWriterApplication, WRITER_GRANT_AUDIT_KEY } = await import(
  "../src/lib/writer-gate.js"
);

describe.skipIf(!DB_URL)("the writers' waiting list", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const made: string[] = [];

  async function build() {
    const a = Fastify({ logger: false });
    await a.register(writerApplicationRoutes);
    await a.register(adminDashboardRoutes);
    return a;
  }

  async function account(
    slug: string,
    opts: { writer?: boolean; email?: boolean; status?: string } = {},
  ): Promise<string> {
    const u = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, email,
                             writer_admitted_at, status)
       VALUES ($1, 'fixture-enc', $2, $3, $4, $5) RETURNING id`,
      [
        `fixture-wa-${slug}-${u}`,
        `Fixture ${slug}`,
        opts.email ? `wa-${slug}-${u}@test.local` : null,
        opts.writer ? new Date() : null,
        opts.status ?? "active",
      ],
    );
    made.push(rows[0].id);
    return rows[0].id;
  }

  const apply = (as: string) => {
    memberId = as;
    return app.inject({ method: "POST", url: "/writer-applications" });
  };
  const grant = (accountId: string, reason = "Writes well about gardens") =>
    app.inject({
      method: "POST",
      url: "/admin/dashboard/writer-applications/grant",
      payload: { accountId, reason },
    });
  const audits = async (subject: string) =>
    (
      await client.query(
        `SELECT actor_account_id, key, new_value, reason FROM config_audit
          WHERE subject_account_id = $1 AND key = $2`,
        [subject, WRITER_GRANT_AUDIT_KEY],
      )
    ).rows;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ('fixture-writer-applications-admin', 'fixture-enc', 'WA Admin')
       ON CONFLICT (nostr_pubkey) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
    );
    adminId = rows[0].id;
    app = await build();
  });

  afterAll(async () => {
    if (made.length) {
      await client.query(`DELETE FROM writer_applications WHERE account_id = ANY($1::uuid[])`, [made]);
      await client.query(
        `DELETE FROM accounts a WHERE a.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM config_audit ca
                             WHERE ca.subject_account_id = a.id OR ca.actor_account_id = a.id)`,
        [made],
      );
    }
    await app?.close();
    await client.end();
  });

  beforeEach(() => {
    sendWriterAccessGrantedEmail.mockReset();
    sendWriterAccessGrantedEmail.mockImplementation(async () => {});
  });

  it("a reader applies once, and a second press answers the first row", async () => {
    const reader = await account("reader");
    const first = await apply(reader);
    expect(first.statusCode).toBe(200);
    const appliedAt = first.json().appliedAt;
    expect(typeof appliedAt).toBe("string");

    const second = await apply(reader);
    expect(second.statusCode).toBe(200);
    expect(second.json().appliedAt).toBe(appliedAt);

    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM writer_applications WHERE account_id = $1`,
      [reader],
    );
    expect(rows[0].n).toBe(1);
    expect(await pendingWriterApplication(reader, client)).toEqual({ appliedAt });
  });

  it("a writer applying is refused, and nothing is written", async () => {
    const writer = await account("writer", { writer: true });
    const res = await apply(writer);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_writer");
    const { rows } = await client.query(`SELECT 1 FROM writer_applications WHERE account_id = $1`, [
      writer,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("lists pending applications oldest first, and leaves a deleted account out", async () => {
    const earlier = await account("earlier");
    const later = await account("later");
    const gone = await account("gone", { status: "deleted" });
    await client.query(
      `INSERT INTO writer_applications (account_id, created_at) VALUES
         ($1, now() - interval '2 days'),
         ($2, now() - interval '1 day'),
         ($3, now() - interval '3 days')`,
      [earlier, later, gone],
    );
    const res = await app.inject({ method: "GET", url: "/admin/dashboard/writer-applications" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().pending.map((p: { accountId: string }) => p.accountId);
    // The order they asked in, whatever order the rows were inserted.
    expect(ids.indexOf(earlier)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(earlier)).toBeLessThan(ids.indexOf(later));
    expect(ids).not.toContain(gone);
  });

  it("a grant sets the column, stamps the application, audits, and emails after commit", async () => {
    const reader = await account("granted", { email: true });
    await apply(reader);
    let committedWhenEmailed = false;
    sendWriterAccessGrantedEmail.mockImplementation(async () => {
      // Read on ANOTHER connection: visible only if the grant committed.
      const { rows } = await client.query(
        `SELECT writer_admitted_at IS NOT NULL AS w FROM accounts WHERE id = $1`,
        [reader],
      );
      committedWhenEmailed = rows[0].w === true;
    });

    const res = await grant(reader);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "granted", emailed: "sent" });
    expect(sendWriterAccessGrantedEmail).toHaveBeenCalledTimes(1);
    expect(sendWriterAccessGrantedEmail.mock.calls[0][0]).toMatch(/^wa-granted-.*@test\.local$/);
    expect(committedWhenEmailed).toBe(true);

    const { rows } = await client.query(
      `SELECT a.writer_admitted_at IS NOT NULL AS w, a.writer_admitted_by, wa.admitted_at IS NOT NULL AS stamped,
              wa.admitted_by
         FROM accounts a JOIN writer_applications wa ON wa.account_id = a.id WHERE a.id = $1`,
      [reader],
    );
    expect(rows[0]).toMatchObject({ w: true, writer_admitted_by: adminId, stamped: true, admitted_by: adminId });
    expect(await audits(reader)).toEqual([
      {
        actor_account_id: adminId,
        key: "writer_access:grant",
        new_value: "granted:application",
        reason: "Writes well about gardens",
      },
    ]);
    // A writer has nothing pending to show.
    expect(await pendingWriterApplication(reader, client)).toBeNull();
    // ...and appears in the granted record.
    const list = await app.inject({ method: "GET", url: "/admin/dashboard/writer-applications" });
    const g = list.json().granted.find((x: { accountId: string }) => x.accountId === reader);
    expect(g?.grantedBy).toBeDefined();
  });

  it("a second grant is refused and records nothing", async () => {
    const reader = await account("twice");
    await apply(reader);
    expect((await grant(reader)).statusCode).toBe(200);
    const again = await grant(reader);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_writer");
    expect(await audits(reader)).toHaveLength(1);
  });

  it("no application is a 404, and the member stays a reader", async () => {
    const reader = await account("unasked");
    const res = await grant(reader);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no_application");
    const { rows } = await client.query(`SELECT writer_admitted_at FROM accounts WHERE id = $1`, [reader]);
    expect(rows[0].writer_admitted_at).toBeNull();
    expect(await audits(reader)).toHaveLength(0);
  });

  it("a blank reason is refused before anything is written", async () => {
    const reader = await account("noreason");
    await apply(reader);
    const res = await grant(reader, "   ");
    expect(res.statusCode).toBe(400);
    const { rows } = await client.query(`SELECT writer_admitted_at FROM accounts WHERE id = $1`, [reader]);
    expect(rows[0].writer_admitted_at).toBeNull();
  });

  it("a failed email leaves the grant standing, and says so", async () => {
    const reader = await account("mailfail", { email: true });
    await apply(reader);
    sendWriterAccessGrantedEmail.mockImplementation(async () => {
      throw new Error("postmark 406");
    });
    const res = await grant(reader);
    expect(res.statusCode).toBe(200);
    expect(res.json().emailed).toBe("failed");
    const { rows } = await client.query(`SELECT writer_admitted_at FROM accounts WHERE id = $1`, [reader]);
    expect(rows[0].writer_admitted_at).not.toBeNull();
  });

  it("an account with no address is granted and not emailed", async () => {
    const reader = await account("noaddress");
    await apply(reader);
    const res = await grant(reader);
    expect(res.json()).toEqual({ outcome: "granted", emailed: "no_address" });
    expect(sendWriterAccessGrantedEmail).not.toHaveBeenCalled();
  });

  it("two grants at once: exactly one records anything", async () => {
    const reader = await account("race");
    await apply(reader);
    const [a, b] = await Promise.all([grant(reader, "first"), grant(reader, "second")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await audits(reader)).toHaveLength(1);
  });
});
