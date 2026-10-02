import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { EXTERNAL_CONTEXT_GC_SQL } from "./external-context-gc.js";

// =============================================================================
// The context GC spares a context row a NOTIFICATION names (migration 236).
//
// The linked-notification poller (CROSS-NETWORK-ROUNDTRIP-ADR rung C) files
// every reply, mention and quote that reaches a member from Bluesky or
// Mastodon as a CONTEXT-ONLY row, and the notification's foreign key CASCADEs.
// So this reaper, whose whole job is context rows past their window, would
// silently delete the member's notification with it — no error, no log, one
// fewer row in the panel. Runs the task's own exported statement.
//
// Fixtures in a transaction that is always rolled back (the statement reaps
// DB-wide, and the rollback returns everything). Skipped without a DB URL.
//
// Mutation it was proved against: the `notifications` NOT EXISTS deleted from
// EXTERNAL_CONTEXT_GC_SQL → "a context row a notification names survives".
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hex = (n = 32) => randomBytes(n).toString("hex");

describe.skipIf(!DB_URL)("external_context_gc", () => {
  let client: pg.Client;
  let sourceId: string;
  let recipient: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    sourceId = (
      await client.query<{ id: string }>(
        `INSERT INTO external_sources (protocol, source_uri, is_active) VALUES ('atproto', $1, FALSE) RETURNING id`,
        [`did:plc:${hex(8)}`],
      )
    ).rows[0].id;
    recipient = (
      await client.query<{ id: string }>(`INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`, [hex()])
    ).rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function oldContextItem(label: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at, created_at, is_context_only)
       VALUES ($1, 'atproto', 'tier3', $2, now() - interval '200 days', now() - interval '200 days', TRUE)
       RETURNING id`,
      [sourceId, `at://x/${label}-${hex(4)}`],
    );
    return rows[0].id;
  }
  const exists = async (id: string) =>
    (await client.query(`SELECT 1 FROM external_items WHERE id = $1`, [id])).rowCount === 1;

  it("a context row a notification names survives; an unreferenced one is reaped", async () => {
    const named = await oldContextItem("named");
    const plain = await oldContextItem("plain");
    await client.query(
      `INSERT INTO notifications (recipient_id, type, external_item_id) VALUES ($1, 'external_reply', $2)`,
      [recipient, named],
    );
    await client.query(EXTERNAL_CONTEXT_GC_SQL, ["30"]);
    expect(await exists(named)).toBe(true);
    expect(await exists(plain)).toBe(false);
    const n = await client.query(`SELECT 1 FROM notifications WHERE recipient_id = $1`, [recipient]);
    expect(n.rowCount).toBe(1);
  });
});
