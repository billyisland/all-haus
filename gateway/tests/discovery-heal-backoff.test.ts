import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { HEAL_SELECT_SQL } from "../src/lib/discovery-publish.js";

// =============================================================================
// A PERMANENT FAILURE DOES NOT STARVE THE HEAL (CA-D5, 2026-09-29).
//
// The heal selected the 25 least-recently-SYNCED opted-in accounts and stamped
// `discovery_synced_at` only on success. So 25 accounts that fail every time
// (key-custody refusing that one key) sat at the head of `NULLS FIRST` for
// ever: re-picked every 60s, and nobody behind them was ever healed. The
// attempt is now its own column and a recent one is skipped.
//
// DB-backed, running the SHIPPED statement: only Postgres evaluates the
// interval arithmetic and the NULL ordering. Every other account is switched
// out of discovery inside the transaction, so the batch is exactly the fixture.
//
// MUTATION: drop the `discovery_attempted_at` clause from HEAL_SELECT_SQL →
// the starvation case goes red (the 25 failures fill the batch again).
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("discovery heal selection", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("BEGIN");
    await client.query("UPDATE accounts SET discovery_enabled = FALSE WHERE discovery_enabled");
  });
  afterAll(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  async function account(synced: string | null, attempted: string | null): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, discovery_enabled, status,
                             discovery_synced_at, discovery_attempted_at)
       VALUES ($1, TRUE, 'active', ${synced ?? "NULL"}, ${attempted ?? "NULL"})
       RETURNING id`,
      [randomBytes(32).toString("hex")],
    );
    return rows[0].id;
  }

  const select = async (limit: number) =>
    (await client.query<{ id: string }>(HEAL_SELECT_SQL, [limit, "7 days", "1 hour"])).rows.map(
      (r) => r.id,
    );

  it("25 accounts that just failed do not hold back the one that has never been tried", async () => {
    const failing: string[] = [];
    for (let i = 0; i < 25; i++) failing.push(await account(null, "now() - interval '5 minutes'"));
    const waiting = await account("now() - interval '30 days'", null);

    const batch = await select(25);

    expect(batch).toContain(waiting);
    expect(batch.some((id) => failing.includes(id))).toBe(false);
  });

  it("a failure is retried once its window has passed", async () => {
    const retried = await account(null, "now() - interval '2 hours'");
    expect(await select(100)).toContain(retried);
  });

  it("CONTROL — an account synced inside the heal interval is not selected at all", async () => {
    const fresh = await account("now() - interval '1 day'", null);
    expect(await select(100)).not.toContain(fresh);
  });
});
