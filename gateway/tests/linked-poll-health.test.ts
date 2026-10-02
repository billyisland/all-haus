import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";

// =============================================================================
// The overview's liveness figure for the linked-notification poller
// (CROSS-NETWORK-ROUNDTRIP-ADR C4) — LINKED_POLL_HEALTH_SQL against Postgres.
//
// What it decides is only Postgres's to evaluate: the threshold built from two
// dials with `make_interval`, the never-polled presence aging from its link
// date (DOWN, never "unknown"), the FILTERed subset awaiting a reconnect, and
// the predicate that says which presences the poller serves at all. The
// statement counts DB-wide, so each case measures the DELTA its fixtures make.
//
// Fixtures in a transaction that is always rolled back. Skipped without a DB
// URL; CI attaches one and fails on a skip.
//
// Mutations it was proved against (each turns the case red):
//   · COALESCE(polled_at, created_at) → polled_at alone (a never-polled
//     presence reads as never stale)
//   · the `$1 || '%'` LIKE dropped from awaiting_reconnect (every stale
//     presence counted as awaiting a reconnect)
//   · `provenance <> 'concierge'` dropped from `served`
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hex = (n = 32) => randomBytes(n).toString("hex");

const { LINKED_POLL_HEALTH_SQL } = await import("../src/routes/admin-dashboard.js");
const { NOTIFICATIONS_NEEDS_RECONNECT } = await import("@platform-pub/shared/lib/presence-health.js");

describe.skipIf(!DB_URL)("linked-notification poll health", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    // Pin the dials, whatever the dev DB carries: 60s × 5 = a 5-minute window.
    await client.query(
      `INSERT INTO platform_config (key, value) VALUES
         ('linked_notifications_poll_seconds', '60'), ('linked_notifications_stale_intervals', '5')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  const health = async () => (await client.query(LINKED_POLL_HEALTH_SQL, [NOTIFICATIONS_NEEDS_RECONNECT])).rows[0];

  async function presence(opts: {
    polledMinsAgo: number | null;
    createdMinsAgo: number;
    error?: string;
    provenance?: string;
  }) {
    const acct = (
      await client.query<{ id: string }>(`INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`, [hex()])
    ).rows[0].id;
    await client.query(
      `INSERT INTO network_presences
         (account_id, protocol, external_id, provenance, created_at, notifications_polled_at, notifications_poll_error)
       VALUES ($1, 'atproto', $2, $3, now() - make_interval(mins => $4),
               CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(mins => $5::int) END, $6)`,
      [acct, `did:plc:${hex(6)}`, opts.provenance ?? "linked", opts.createdMinsAgo, opts.polledMinsAgo, opts.error ?? null],
    );
  }

  it("counts DOWN from the last success, a never-polled presence from its link date, and reconnects apart", async () => {
    const before = await health();
    expect(Number(before.poll_seconds)).toBe(60);
    expect(Number(before.stale_intervals)).toBe(5);

    await presence({ polledMinsAgo: 1, createdMinsAgo: 600 }); // healthy
    await presence({ polledMinsAgo: 30, createdMinsAgo: 600 }); // down
    await presence({ polledMinsAgo: null, createdMinsAgo: 600 }); // never polled, long linked: down
    await presence({ polledMinsAgo: null, createdMinsAgo: 1 }); // never polled, just linked: not yet
    await presence({ polledMinsAgo: 30, createdMinsAgo: 600, error: `${NOTIFICATIONS_NEEDS_RECONNECT} lacks read:notifications` });
    await presence({ polledMinsAgo: 30, createdMinsAgo: 600, error: "PDS 502" }); // down, not a reconnect
    await presence({ polledMinsAgo: null, createdMinsAgo: 600, provenance: "concierge" }); // not served

    const after = await health();
    expect(after.presences - before.presences).toBe(6);
    expect(after.down - before.down).toBe(4);
    expect(after.awaiting_reconnect - before.awaiting_reconnect).toBe(1);
  });
});
