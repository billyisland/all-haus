import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { holdDefaultSeed } from "./default-seed-lock.js";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// Admission appends the new member to the default seed (RESHAPE-PLAN-2026-10
// §A, session A1) — and a member admit created is seeded but NAMED to nobody
// until they arrive.
//
// DB-BACKED, because every claim here is about rows across tables and three of
// the guarantees are Postgres's own: the partial unique index that makes the
// append idempotent (and must not collide a member with an external Nostr
// source sharing the pubkey), the FOR UPDATE that serialises two admits'
// `max(position) + 1`, and the arrival predicate's NULL handling over a LEFT
// JOIN. A mocked pool would answer each from the mock.
//
// THIS FILE MUTATES GLOBAL STATE — designation is one platform-wide slot, so
// the incumbent is parked in beforeAll and restored in afterAll, and
// undesignated BEFORE the fixture accounts are deleted (the D11 trigger
// refuses the CASCADE otherwise). The ADMIN fixture is find-or-created by a
// fixed pubkey and never deleted, and neither is a member an append audited:
// `config_audit` is append-only and holds a plain FK to its actor AND its
// subject, so an audited account can never be deleted — which is the table
// working, not a leak to fix.
//
// Run locally (both vars — the code under test uses the shared pool):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/seed-on-admit.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.APP_URL ??= "http://app.test";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let adminId = "unset";
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: adminId };
    done();
  },
  getAdminIds: () => Promise.resolve([adminId]),
}));

// key-custody is another service; the pubkey is all the seed needs of it.
vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: async () => ({
    pubkeyHex: `fixture-admitted-${process.hrtime.bigint().toString(16)}`,
    privkeyEncrypted: "fixture-enc",
  }),
}));

const sendWaitlistInviteEmail = vi.fn(async (_to: string) => {});
vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendWaitlistInviteEmail: (to: string) => sendWaitlistInviteEmail(to),
}));

// The seed's failure log is the witness this whole design protects, so it is
// read, not silenced.
const loggedErrors: string[] = [];
vi.mock("@platform-pub/shared/lib/logger.js", () => {
  const l = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (_o: unknown, msg?: string) => {
      loggedErrors.push(String(msg));
    },
    child: () => l,
  };
  return { default: l };
});

const { seedStarterFeeds } = await import("../src/routes/feeds/crud.js");
const { loadFeedSources } = await import("../src/routes/feeds/sources.js");
const { freezeFeedSources, populateFeedFromFormula } = await import(
  "../src/routes/feeds/formulas.js"
);
const { createFeedForOwner } = await import("../src/routes/feeds/shared.js");
const { appendAccountToSeed } = await import("../src/routes/feeds/seed-append.js");
const { invalidatePlatformConfig } = await import("../src/lib/platform-config.js");
const { adminDashboardRoutes } = await import("../src/routes/admin-dashboard.js");
const { writerRoutes } = await import("../src/routes/writers.js");
const { searchRoutes } = await import("../src/routes/search.js");
const { authorRoutes } = await import("../src/routes/author.js");

describe.skipIf(!DB_URL)("seed on admit", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  const cleanupEmails: string[] = [];
  let parked: string | null = null;
  let seedId = "";

  async function build() {
    const a = Fastify({ logger: false });
    await a.register(adminDashboardRoutes);
    await a.register(writerRoutes);
    await a.register(searchRoutes);
    await a.register(authorRoutes);
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    // The seed is a singleton another suite also parks (default-seed-lock.ts).
    await holdDefaultSeed(client);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE feed_formulas SET is_default_seed = FALSE
        WHERE is_default_seed RETURNING id`,
    );
    parked = rows[0]?.id ?? null;
    const { rows: admin } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ('fixture-seed-on-admit-admin', 'fixture-enc', 'Seed Admin')
       ON CONFLICT (nostr_pubkey) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
    );
    adminId = admin[0].id;
    app = await build();
  });

  afterAll(async () => {
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
    // The admin's own feeds and formulas go (formulas cascade from their
    // author only on account delete, which never happens for this fixture).
    await client.query(`DELETE FROM feed_formulas WHERE author_id = $1`, [adminId]);
    await client.query(`DELETE FROM feeds WHERE owner_id = $1`, [adminId]);
    if (cleanupEmails.length)
      await client.query(`DELETE FROM waitlist WHERE email = ANY($1::text[])`, [cleanupEmails]);
    const { rows: made } = await client.query<{ id: string }>(
      `SELECT id FROM accounts WHERE email = ANY($1::text[])`,
      [cleanupEmails],
    );
    const ids = [...cleanupAccounts, ...made.map((r) => r.id)];
    // An account an append AUDITED stays: `config_audit` holds a plain FK to
    // its subject as well as its actor, and is append-only. Everything else goes.
    const keepAudited = `NOT EXISTS (SELECT 1 FROM config_audit ca
                             WHERE ca.subject_account_id = a.id OR ca.actor_account_id = a.id)`;
    if (ids.length)
      await client.query(
        `DELETE FROM reading_tabs t USING accounts a
          WHERE t.reader_id = a.id AND a.id = ANY($1::uuid[]) AND ${keepAudited}`,
        [ids],
      );
    if (ids.length)
      await client.query(
        `DELETE FROM accounts a WHERE a.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM config_audit ca
                             WHERE ca.subject_account_id = a.id OR ca.actor_account_id = a.id)`,
        [ids],
      );
    if (parked)
      await client.query(`UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`, [
        parked,
      ]);
    await app?.close();
    await client.end();
  });

  beforeEach(async () => {
    loggedErrors.length = 0;
    sendWaitlistInviteEmail.mockReset();
    sendWaitlistInviteEmail.mockImplementation(async () => {});
    // A fresh designated seed per test, holding one ordinary member, so no
    // test reads another's appends.
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
    const anchor = await account("anchor");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, 'seed', 'Cohort seed', '{}'::jsonb, $2, 1, 0) RETURNING id`,
      [adminId, `tok-${uniq()}`],
    );
    seedId = rows[0].id;
    await client.query(
      `INSERT INTO feed_formula_sources (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account')`,
      [seedId, anchor.pubkey],
    );
    await client.query(`UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`, [seedId]);
  });

  async function account(
    slug: string,
    opts: { byAdmit?: boolean } = {},
  ): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, provisioned_by_admit)
       VALUES ($1, 'fixture-enc', $2, $3) RETURNING id`,
      [pubkey, `Fixture ${slug}`, opts.byAdmit === true],
    );
    cleanupAccounts.push(rows[0].id);
    return { id: rows[0].id, pubkey };
  }

  /** A waitlister's address, joined to the list. */
  async function waitlister(slug: string): Promise<string> {
    const email = `seed-${slug}-${uniq()}@fixture.example`;
    cleanupEmails.push(email);
    await client.query(`INSERT INTO waitlist (email) VALUES ($1)`, [email]);
    return email;
  }

  const admit = (emails: string[], reason = "fixture cohort") =>
    app.inject({
      method: "POST",
      url: "/admin/dashboard/waitlist/admit",
      payload: { emails, reason },
    });

  async function accountFor(email: string): Promise<{ id: string; pubkey: string }> {
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `SELECT id, nostr_pubkey FROM accounts WHERE email = $1`,
      [email],
    );
    return { id: rows[0].id, pubkey: rows[0].nostr_pubkey };
  }

  async function seedRows(pubkey: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT 1 FROM feed_formula_sources
        WHERE formula_id = $1 AND source_type = 'account' AND tag_value = $2`,
      [seedId, pubkey],
    );
    return rows.length;
  }

  async function sourceCount(): Promise<number> {
    const { rows } = await client.query<{ source_count: number }>(
      `SELECT source_count FROM feed_formulas WHERE id = $1`,
      [seedId],
    );
    return rows[0].source_count;
  }

  /** The account ids in a member's seeded feed, from the rows themselves. */
  async function seededAccountIds(memberId: string): Promise<string[]> {
    const { rows } = await client.query<{ account_id: string }>(
      `SELECT fs.account_id FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
        WHERE f.owner_id = $1 AND fs.source_type = 'account'`,
      [memberId],
    );
    return rows.map((r) => r.account_id);
  }

  async function arrive(accountId: string) {
    await client.query(
      `UPDATE accounts SET date_of_birth = '1990-01-01', age_declared_at = now() WHERE id = $1`,
      [accountId],
    );
  }

  it("appends exactly one row, with its audit row, and a second admit appends none", async () => {
    const email = await waitlister("once");
    const before = await sourceCount();

    const res = await admit([email]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ outcome: "admitted", seed: "appended" });
    const x = await accountFor(email);
    expect(await seedRows(x.pubkey)).toBe(1);
    expect(await sourceCount()).toBe(before + 1);

    // The audit row names the ACCOUNT and the operator's note — never the
    // address, which would outlive an erasure in an append-only table.
    const { rows: audit } = await client.query(
      `SELECT actor_account_id, subject_account_id, new_value, reason, old_value
         FROM config_audit WHERE key = 'default_seed:admit_append' AND subject_account_id = $1`,
      [x.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_account_id: adminId,
      new_value: seedId,
      reason: "fixture cohort",
    });
    expect(JSON.stringify(audit[0])).not.toContain(email);

    // The repair door on a row that needs no repair: nothing moves.
    const again = await admit([email]);
    expect(again.json().results[0]).toMatchObject({
      outcome: "already_admitted",
      seed: "already_present",
    });
    expect(await seedRows(x.pubkey)).toBe(1);
    expect(await sourceCount()).toBe(before + 1);
  });

  it("marks the account it created — and not one it linked", async () => {
    const made = await waitlister("made");
    const linkedEmail = await waitlister("linked");
    const existing = await account("linked-existing");
    await client.query(`UPDATE accounts SET email = $1 WHERE id = $2`, [linkedEmail, existing.id]);

    await admit([made, linkedEmail]);
    const { rows } = await client.query<{ email: string; provisioned_by_admit: boolean }>(
      `SELECT email, provisioned_by_admit FROM accounts WHERE email = ANY($1::text[]) ORDER BY email`,
      [[made, linkedEmail]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.email, r.provisioned_by_admit]));
    expect(by[made]).toBe(true);
    expect(by[linkedEmail]).toBe(false);
  });

  it("a cohort admitted together finds itself: each seed holds the other, not themselves, with no failure", async () => {
    const [ex, ey] = [await waitlister("x"), await waitlister("y")];
    await admit([ex, ey]);
    const [x, y] = [await accountFor(ex), await accountFor(ey)];

    expect(await seedStarterFeeds(x.id)).toBe(1);
    expect(await seedStarterFeeds(y.id)).toBe(1);

    expect(await seededAccountIds(x.id)).toContain(y.id);
    expect(await seededAccountIds(x.id)).not.toContain(x.id);
    expect(await seededAccountIds(y.id)).toContain(x.id);
    expect(await seededAccountIds(y.id)).not.toContain(y.id);
    // The failure log stays a witness to REAL failures: a newcomer's own row
    // is expected, not reported.
    expect(loggedErrors).not.toContain("Default-seed formula redeemed with failures");

    // Seeded account sources write no follows.
    const { rows: follows } = await client.query(
      `SELECT 1 FROM follows WHERE follower_id = ANY($1::uuid[])`,
      [[x.id, y.id]],
    );
    expect(follows).toHaveLength(0);
  });

  it("the replay counts self and gone as skips, never as failures", async () => {
    const [ex, ey] = [await waitlister("self"), await waitlister("gone")];
    await admit([ex, ey]);
    const [x, y] = [await accountFor(ex), await accountFor(ey)];
    await client.query(`UPDATE accounts SET status = 'deleted' WHERE id = $1`, [y.id]);

    const feed = await createFeedForOwner(x.id, "Replay", client as any, {});
    const result = await populateFeedFromFormula(feed.id, x.id, seedId);
    expect(result.failed).toEqual([]);
    expect(result.skippedSelf).toBe(1);
    expect(result.skippedGone).toBe(1);
    expect(result.added).toBe(1); // the anchor

    // And the panel offers no repair for the gone member: there is nothing to
    // append that the replay would not skip.
    const list = (await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })).json();
    expect(list.entries.find((e: any) => e.email === ey).inSeed).toBeNull();
    expect(list.entries.find((e: any) => e.email === ex).inSeed).toBe(true);
  });

  it("a member seeded before Y's admission does not gain Y — the seed is a snapshot", async () => {
    const ex = await waitlister("early");
    await admit([ex]);
    const x = await accountFor(ex);
    await seedStarterFeeds(x.id);

    const ey = await waitlister("late");
    await admit([ey]);
    const y = await accountFor(ey);
    expect(await seedRows(y.pubkey)).toBe(1);
    expect(await seededAccountIds(x.id)).not.toContain(y.id);
  });

  it("with nothing designated, admit succeeds and appends nothing", async () => {
    await client.query(`UPDATE feed_formulas SET is_default_seed = FALSE WHERE id = $1`, [seedId]);
    const email = await waitlister("noseed");
    const res = await admit([email]);
    expect(res.json().results[0]).toMatchObject({ outcome: "admitted", seed: "no_seed" });
    const x = await accountFor(email);
    expect(await seedRows(x.pubkey)).toBe(0);
  });

  it("two concurrent appends land at distinct positions — the FOR UPDATE is what decides", async () => {
    const a = await account("race-a", { byAdmit: true });
    const b = await account("race-b", { byAdmit: true });
    const ca = new pg.Client({ connectionString: DB_URL });
    const cb = new pg.Client({ connectionString: DB_URL });
    await ca.connect();
    await cb.connect();
    try {
      // FORCED INTERLEAVING: A holds its append open, uncommitted; B starts
      // and must be seen WAITING before A commits. Without the lock B reads
      // the same max(position) and fails on UNIQUE (formula_id, position).
      await ca.query("BEGIN");
      await cb.query("BEGIN");
      expect(
        await appendAccountToSeed(ca as any, { accountId: a.id, actorId: adminId, reason: "race" }),
      ).toBe("appended");
      const pidB = (await cb.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const bDone = appendAccountToSeed(cb as any, { accountId: b.id, actorId: adminId, reason: "race" });
      for (let i = 0; i < 50; i++) {
        const { rows } = await client.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`,
          [pidB],
        );
        if (rows.length) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await ca.query("COMMIT");
      expect(await bDone).toBe("appended");
      await cb.query("COMMIT");
    } finally {
      await ca.query("ROLLBACK").catch(() => {});
      await cb.query("ROLLBACK").catch(() => {});
      await ca.end();
      await cb.end();
    }
    const { rows } = await client.query<{ position: number }>(
      `SELECT position FROM feed_formula_sources
        WHERE formula_id = $1 AND tag_value = ANY($2::text[]) ORDER BY position`,
      [seedId, [a.pubkey, b.pubkey]],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].position).not.toBe(rows[1].position);
  });

  it("an admitted member missing from the seed is repaired by admitting again", async () => {
    const email = await waitlister("repair");
    await admit([email]);
    const x = await accountFor(email);
    // The state a failed append leaves: a member who exists, not in the seed.
    await client.query(
      `DELETE FROM feed_formula_sources WHERE formula_id = $1 AND tag_value = $2`,
      [seedId, x.pubkey],
    );

    const list = (await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })).json();
    expect(list.entries.find((e: any) => e.email === email).inSeed).toBe(false);

    const res = await admit([email]);
    expect(res.json().results[0]).toMatchObject({ outcome: "already_admitted", seed: "appended" });
    expect(await seedRows(x.pubkey)).toBe(1);
  });

  it("a failed invitation is distinguishable from a row not yet invited", async () => {
    const [ok, bad] = [await waitlister("told"), await waitlister("untold")];
    await admit([ok, bad]);
    sendWaitlistInviteEmail.mockImplementation(async (to: string) => {
      if (to === bad) throw new Error("postmark down");
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/waitlist/invite",
      payload: { emails: [ok, bad] },
    });
    expect(res.json().results.map((r: any) => r.outcome)).toEqual(["invited", "send_failed"]);

    const third = await waitlister("waiting-to-be-told");
    await admit([third]);
    const list = (await app.inject({ method: "GET", url: "/admin/dashboard/waitlist" })).json();
    const e = (m: string) => list.entries.find((x: any) => x.email === m);
    expect(e(bad).invitedAt).toBeNull();
    expect(e(bad).inviteFailedAt).not.toBeNull();
    // Admitted, deliberately not yet told: NOT a failure.
    expect(e(third).invitedAt).toBeNull();
    expect(e(third).inviteFailedAt).toBeNull();
    expect(e(ok).invitedAt).not.toBeNull();
  });

  it("an unarrived member is carried but NOT NAMED, and appears on arrival with no write", async () => {
    const [ex, ey] = [await waitlister("unarrived"), await waitlister("viewer")];
    await admit([ex, ey]);
    const [x, y] = [await accountFor(ex), await accountFor(ey)];
    await arrive(y.id);
    await seedStarterFeeds(y.id);
    const { rows: feeds } = await client.query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at FROM feeds WHERE owner_id = $1`,
      [y.id],
    );
    const feedId = feeds[0].id;

    // The row is there; the name is not.
    expect(await seededAccountIds(y.id)).toContain(x.id);
    const listed = await loadFeedSources(feedId);
    expect(listed.some((s: any) => s.accountId === x.id)).toBe(false);
    expect(listed.length).toBe((await seededAccountIds(y.id)).length - 1);

    const { rows: before } = await client.query(
      `SELECT id, throughput, muted_at FROM feed_sources WHERE feed_id = $1 ORDER BY id`,
      [feedId],
    );
    await arrive(x.id);
    const after = await loadFeedSources(feedId);
    expect(after.some((s: any) => s.accountId === x.id)).toBe(true);
    // Nothing of Y's was written: the filter is on the read.
    const { rows: unchanged } = await client.query(
      `SELECT id, throughput, muted_at FROM feed_sources WHERE feed_id = $1 ORDER BY id`,
      [feedId],
    );
    expect(unchanged).toEqual(before);
  });

  it("an unarrived member is not found by search and has no profile until they arrive (§A.5)", async () => {
    const email = await waitlister("hidden-profile");
    await admit([email]);
    const x = await accountFor(email);
    const { rows } = await client.query<{ username: string }>(
      `SELECT username FROM accounts WHERE id = $1`,
      [x.id],
    );
    const username = rows[0].username;
    const found = async () =>
      (
        await app.inject({ method: "GET", url: `/search?q=${encodeURIComponent(username)}&type=writers` })
      ).json().results.some((r: any) => r.id === x.id);

    expect((await app.inject({ method: "GET", url: `/writers/${username}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/author/${x.id}/profile` })).statusCode).toBe(404);
    expect(await found()).toBe(false);

    await arrive(x.id);
    expect((await app.inject({ method: "GET", url: `/writers/${username}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/author/${x.id}/profile` })).statusCode).toBe(200);
    expect(await found()).toBe(true);
  });

  it("a long-standing account with no age declaration, not created by admit, is still listed", async () => {
    // The case the predicate must never catch: most existing members have no
    // declaration, and "age_declared_at IS NULL" alone would hide them all.
    const old = await account("long-standing");
    const viewer = await account("viewer-2");
    const feed = await createFeedForOwner(viewer.id, "Mine", client as any, {});
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
      [feed.id, old.id],
    );
    const listed = await loadFeedSources(feed.id);
    expect(listed.some((s: any) => s.accountId === old.id)).toBe(true);
  });

  it("a shared feed's projection omits the unarrived member and counts them excluded; the seed cut keeps them", async () => {
    const pending = await account("pending", { byAdmit: true });
    const arrived = await account("arrived", { byAdmit: true });
    await arrive(arrived.id);
    const owner = await account("sharer");
    const feed = await createFeedForOwner(owner.id, "Shared", client as any, {});
    for (const a of [pending, arrived])
      await client.query(
        `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
        [feed.id, a.id],
      );

    const link = await freezeFeedSources(client as any, feed.id, 200);
    expect(link.sources.map((s) => s.tagValue)).toEqual([arrived.pubkey]);
    expect(link.excludedCount).toBe(1);

    const cut = await freezeFeedSources(client as any, feed.id, 200, { includeUnarrived: true });
    expect(cut.sources.map((s) => s.tagValue).sort()).toEqual([arrived.pubkey, pending.pubkey].sort());
    expect(cut.excludedCount).toBe(0);
  });

  it("does not collide a member with an external Nostr source holding the same pubkey", async () => {
    const x = await account("shared-pubkey", { byAdmit: true });
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, source_type, protocol)
       VALUES ($1, 50, 'p', $2, 'external_source', 'nostr_external')`,
      [seedId, x.pubkey],
    );
    const outcome = await withClient((c) =>
      appendAccountToSeed(c, { accountId: x.id, actorId: adminId, reason: "collide" }),
    );
    expect(outcome).toBe("appended");
    expect(await seedRows(x.pubkey)).toBe(1);
  });

  it("at the cap, admit still admits and says the seed is full", async () => {
    const { rows: prior } = await client.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'feed_formula_max_sources'`,
    );
    await client.query(
      `UPDATE platform_config SET value = '1' WHERE key = 'feed_formula_max_sources'`,
    );
    invalidatePlatformConfig();
    try {
      const email = await waitlister("full");
      const res = await admit([email]);
      expect(res.json().results[0]).toMatchObject({ outcome: "admitted", seed: "seed_full" });
      expect(await seedRows((await accountFor(email)).pubkey)).toBe(0);
    } finally {
      if (prior[0])
        await client.query(
          `UPDATE platform_config SET value = $1 WHERE key = 'feed_formula_max_sources'`,
          [prior[0].value],
        );
      invalidatePlatformConfig();
    }
  });

  it("a re-cut carries the admitted members across, and leaves them only on the opt-out", async () => {
    const email = await waitlister("carried");
    await admit([email]);
    const x = await accountFor(email);
    // The operator's own feed, holding somebody else entirely.
    const other = await account("feed-member");
    const feed = await createFeedForOwner(adminId, "Operator feed", client as any, {});
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
      [feed.id, other.id],
    );

    const panel = (await app.inject({ method: "GET", url: "/admin/dashboard/seed-formula" })).json();
    expect(panel.designated.admittedCount).toBe(1);
    expect(panel.designated.awaitingArrivalCount).toBe(1);
    expect(panel.feeds.find((f: any) => f.id === feed.id).carryCount).toBe(1);

    const carried = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed.id },
    });
    expect(carried.statusCode).toBe(200);
    expect(carried.json()).toMatchObject({ carried: 1, carryDropped: 0 });
    const newId = carried.json().designated.id;
    const tags = async (id: string) =>
      (
        await client.query<{ tag_value: string }>(
          `SELECT tag_value FROM feed_formula_sources WHERE formula_id = $1 AND source_type = 'account'`,
          [id],
        )
      ).rows.map((r) => r.tag_value);
    expect(await tags(newId)).toContain(x.pubkey);
    // source_count agrees with the rows.
    const { rows: cnt } = await client.query<{ source_count: number; n: number }>(
      `SELECT ff.source_count, (SELECT COUNT(*)::int FROM feed_formula_sources s WHERE s.formula_id = ff.id) AS n
         FROM feed_formulas ff WHERE ff.id = $1`,
      [newId],
    );
    expect(cnt[0].source_count).toBe(cnt[0].n);

    const fresh = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed.id, carryAdmitted: false },
    });
    expect(fresh.json()).toMatchObject({ carried: 0 });
    expect(await tags(fresh.json().designated.id)).not.toContain(x.pubkey);
    // The anchor was never admitted, so it was never the carry's to take.
    seedId = fresh.json().designated.id;
  });

  async function withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
});
