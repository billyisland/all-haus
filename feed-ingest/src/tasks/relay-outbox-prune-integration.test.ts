import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { RELAY_OUTBOX_PRUNE_SQL } from "./relay-outbox-prune.js";

// =============================================================================
// §8.14 — relay_outbox_prune ran a DELETE against a column that does not exist.
//
// The whole fault was `updated_at`: relay_outbox has created_at / last_attempt_at
// / sent_at and no updated_at, so every nightly run raised 42703, exhausted its
// 25 graphile attempts and left a dead job row nobody reads. Nothing had ever
// been pruned.
//
// This test HAS to be DB-backed. The defect is "the SQL names a column the
// schema doesn't have", which only Postgres can adjudicate — a mocked
// pool.query would answer from a fixture and pass just as happily against the
// broken query as against the fixed one (CLAUDE.md's mocked-query rule). The
// SQL is imported rather than copied for the same reason: a test that inlines a
// duplicate proves the duplicate.
//
// The negative control is the pre-fix DELETE verbatim, which must still raise
// 42703 — without it, a test that only asserts the new query works cannot tell
// you it is testing anything the old one failed.
//
// The discriminating case is `recentlySentButAncient`: created 200 days ago,
// sent 5 days ago. Retention is measured from when the row reached the RELAY,
// so it must SURVIVE — which is what separates this from a query that keys on
// created_at and would look correct on every other fixture here.
//
// Skipped unless a DB URL is supplied (CI supplies one and fails on a skip).
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/relay-outbox-prune-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The pre-fix DELETE, verbatim. `updated_at` is the defect.
const BUGGY_DELETE = `
  DELETE FROM relay_outbox
  WHERE status = 'sent'
    AND updated_at < now() - INTERVAL '30 days'
`;

describe.skipIf(!DB_URL)("relay_outbox_prune — retention (§8.14)", () => {
  let client: pg.Client;
  let seq = 0;

  // Fixture ids, rebuilt per test; keyed by the label they are asserted under.
  let ids: Record<string, string>;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const row = async (
      status: string,
      createdDaysAgo: number,
      sentDaysAgo: number | null,
    ): Promise<string> => {
      const { rows: [r] } = await client.query<{ id: string }>(
        `INSERT INTO relay_outbox (entity_type, signed_event, status, created_at, sent_at)
         VALUES ('article', $1::jsonb, $2,
                 now() - ($3 || ' days')::interval,
                 CASE WHEN $4::text IS NULL THEN NULL
                      ELSE now() - ($4 || ' days')::interval END)
         RETURNING id`,
        [
          JSON.stringify({ id: `prune-fixture-${seq++}` }),
          status,
          String(createdDaysAgo),
          sentDaysAgo === null ? null : String(sentDaysAgo),
        ],
      );
      return r.id;
    };

    ids = {
      // Prunable: sent, and sent long ago.
      oldSent: await row("sent", 200, 40),
      // Prunable via the COALESCE arm: 'sent' with no sent_at stamp (a hand-run
      // recovery UPDATE that forgot it) must age out on created_at, not live
      // forever because a NULL comparison is never true.
      oldSentNoStamp: await row("sent", 200, null),
      // Survives: sent, but recently.
      recentSent: await row("sent", 40, 5),
      // Survives, and this is the discriminating one: ancient row, recent send.
      recentlySentButAncient: await row("sent", 200, 5),
      // Survive: not 'sent'. 'abandoned' in particular is what
      // relay_outbox_reconcile alerts on — pruning it would erase the evidence.
      oldAbandoned: await row("abandoned", 200, null),
      oldFailed: await row("failed", 200, null),
      oldPending: await row("pending", 200, null),
    };
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** Which fixture rows are still present, by label. */
  const survivors = async (): Promise<string[]> => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM relay_outbox WHERE id = ANY($1::uuid[])`,
      [Object.values(ids)],
    );
    const alive = new Set(rows.map((r) => r.id));
    return Object.entries(ids)
      .filter(([, id]) => alive.has(id))
      .map(([label]) => label)
      .sort();
  };

  it("CONTROL: the pre-fix DELETE still fails — relay_outbox has no updated_at", async () => {
    // A failed statement aborts the transaction, so the control runs inside a
    // savepoint — otherwise the fixture and afterEach's ROLLBACK go with it.
    await client.query("SAVEPOINT ctl");
    await expect(client.query(BUGGY_DELETE)).rejects.toMatchObject({
      code: "42703", // undefined_column
    });
    await client.query("ROLLBACK TO SAVEPOINT ctl");
  });

  it("deletes sent rows past the window and spares everything else", async () => {
    await client.query(RELAY_OUTBOX_PRUNE_SQL);

    expect(await survivors()).toEqual([
      "oldAbandoned",
      "oldFailed",
      "oldPending",
      "recentSent",
      "recentlySentButAncient",
    ]);
  });

  it("measures retention from sent_at, not created_at", async () => {
    await client.query(RELAY_OUTBOX_PRUNE_SQL);

    // Created 200 days ago, sent 5 days ago: inside the window, so it stays.
    // A prune keying on created_at would have deleted this.
    expect(await survivors()).toContain("recentlySentButAncient");
  });

  it("a 'sent' row with no sent_at stamp still ages out (COALESCE arm)", async () => {
    await client.query(RELAY_OUTBOX_PRUNE_SQL);

    expect(await survivors()).not.toContain("oldSentNoStamp");
  });
});
