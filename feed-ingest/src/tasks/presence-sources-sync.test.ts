import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";

// =============================================================================
// presence_sources_sync — a member's own posts elsewhere are ingested because
// they linked the account (CROSS-NETWORK-ROUNDTRIP-ADR rung D2).
//
// Against a live Postgres: which presences get a source, what the upsert does
// to a source that already exists, the first-fetch job, and the Mastodon key.
// The instance's account endpoint is faked at `fetchMastodonAccountById`;
// everything past it — the §2.9 authority check, the UPDATE, the trigger it
// fires (migration 237), the unique index — is real. The shared pool is routed
// onto ONE client inside a transaction that is always rolled back. The task's
// statements are unfiltered, so every assertion is about a fixture's own row.
// Skipped without a DB URL; CI attaches one and fails on a skip.
//
// Mutations it was proved against (2026-09-27, each turns ONE case red):
//   · PRESENCES_NEEDING_SOURCE_SQL loses `provenance <> 'concierge'`
//                                           → "a concierge presence …"
//   · the failing-source guard removed from BOTH layers (the select's
//     `OR es.orphaned_at IS NULL` and the upsert's WHERE)
//                                           → "a source ingest switched off …"
//     Either layer alone holds it, deliberately: the select keeps the work
//     off such a row, the upsert's WHERE keeps a race from reviving one.
//   · the `blocked` skip ignored            → "a platform-blocked identity …"
//   · authoritativeId bypassed (the claimed uri taken as given)
//                                           → "an instance naming another host's actor …"
//   · phase 1's per-presence catch removed  → "one presence failing …"
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const db: { client: pg.PoolClient | null } = { client: null };
const q = (text: string, values?: unknown[]) => db.client!.query(text, values);

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (text: string, values?: unknown[]) => q(text, values) },
  withTransaction: async (cb: (c: unknown) => Promise<unknown>) => {
    await q("SAVEPOINT sync");
    try {
      const out = await cb(db.client);
      await q("RELEASE SAVEPOINT sync");
      return out;
    } catch (err) {
      await q("ROLLBACK TO SAVEPOINT sync");
      throw err;
    }
  },
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// What each instance answers for an account id: its `uri`, or nothing.
const accounts = new Map<string, string | null>();
vi.mock("@platform-pub/shared/lib/mastodon-api.js", () => ({
  fetchMastodonAccountById: vi.fn(async (origin: string, id: string) => {
    const uri = accounts.get(`${origin}|${id}`);
    return uri === undefined ? null : { id, acct: "m", uri };
  }),
}));

const { syncPresenceSources } = await import("./presence-sources-sync.js");

const hex = (n = 16) => randomBytes(n).toString("hex");

describe.skipIf(!DB_URL)("presence_sources_sync", () => {
  let pool: pg.Pool;
  let member: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    db.client = await pool.connect();
    await q("BEGIN");
    accounts.clear();
    member = (
      await q(`INSERT INTO accounts (username, nostr_pubkey) VALUES ($1, $2) RETURNING id`, [
        `m-${hex(4)}`,
        hex(32),
      ])
    ).rows[0].id;
  });
  afterEach(async () => {
    await q("ROLLBACK");
    db.client!.release();
    db.client = null;
  });

  async function bluesky(opts: { provenance?: string; accountId?: string } = {}): Promise<string> {
    const did = `did:plc:${hex(8)}`;
    await q(
      `INSERT INTO network_presences (account_id, protocol, external_id, stable_handle, provenance)
       VALUES ($1, 'atproto', $2, $2, $3)`,
      [opts.accountId ?? member, did, opts.provenance ?? "linked"],
    );
    return did;
  }

  async function sourceOf(protocol: string, uri: string) {
    const { rows } = await q(
      `SELECT id, is_active, orphaned_at FROM external_sources WHERE protocol = $1 AND source_uri = $2`,
      [protocol, uri],
    );
    return rows[0] as { id: string; is_active: boolean; orphaned_at: Date | null } | undefined;
  }

  async function jobFor(sourceId: string) {
    const { rows } = await q(
      `SELECT t.identifier, j.max_attempts, j.payload
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE j.key = 'feed_ingest_' || $1`,
      [sourceId],
    );
    return rows[0] as { identifier: string; max_attempts: number; payload: { sourceId: string } } | undefined;
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — the source
  // ---------------------------------------------------------------------------

  it("a linked Bluesky identity gets an active source and its first fetch", async () => {
    const did = await bluesky();
    await syncPresenceSources();
    const src = await sourceOf("atproto", did);
    expect(src?.is_active).toBe(true);
    const job = await jobFor(src!.id);
    expect(job).toMatchObject({ identifier: "feed_ingest_atproto_backfill", max_attempts: 5 });
    expect(job!.payload.sourceId).toBe(src!.id);
  });

  it("writes no external_subscriptions row — a presence is not a feed", async () => {
    const did = await bluesky();
    await syncPresenceSources();
    const src = await sourceOf("atproto", did);
    const { rows } = await q(`SELECT 1 FROM external_subscriptions WHERE source_id = $1`, [src!.id]);
    expect(rows).toHaveLength(0);
  });

  it("a source the GC switched off is revived, with a fetch", async () => {
    const did = await bluesky();
    const { rows } = await q(
      `INSERT INTO external_sources (protocol, source_uri, is_active, orphaned_at)
       VALUES ('atproto', $1, FALSE, now() - interval '30 days') RETURNING id`,
      [did],
    );
    await syncPresenceSources();
    const src = await sourceOf("atproto", did);
    expect(src).toMatchObject({ id: rows[0].id, is_active: true, orphaned_at: null });
    expect(await jobFor(src!.id)).toBeDefined();
  });

  it("a source ingest switched off for FAILING is left off, and fetched no more", async () => {
    const did = await bluesky();
    const { rows } = await q(
      `INSERT INTO external_sources (protocol, source_uri, is_active, error_count)
       VALUES ('atproto', $1, FALSE, 10) RETURNING id`,
      [did],
    );
    await syncPresenceSources();
    expect((await sourceOf("atproto", did))?.is_active).toBe(false);
    expect(await jobFor(rows[0].id)).toBeUndefined();
  });

  it("an existing live source is left exactly as it is (control)", async () => {
    const did = await bluesky();
    const { rows } = await q(
      `INSERT INTO external_sources (protocol, source_uri, display_name) VALUES ('atproto', $1, 'Named first') RETURNING id`,
      [did],
    );
    await syncPresenceSources();
    const { rows: after } = await q(`SELECT display_name FROM external_sources WHERE id = $1`, [rows[0].id]);
    expect(after[0].display_name).toBe("Named first");
    expect(await jobFor(rows[0].id)).toBeUndefined();
  });

  it("a concierge presence gets no source — everything on it is a cross-post", async () => {
    const did = await bluesky({ provenance: "concierge" });
    await syncPresenceSources();
    expect(await sourceOf("atproto", did)).toBeUndefined();
  });

  it("an unlinked (deprovisioned) presence gets no source", async () => {
    const did = await bluesky();
    await q(`UPDATE network_presences SET lifecycle_state = 'deprovisioned' WHERE stable_handle = $1`, [did]);
    await syncPresenceSources();
    expect(await sourceOf("atproto", did)).toBeUndefined();
  });

  it("a platform-blocked identity gets no source, and is counted", async () => {
    const did = await bluesky();
    await q(
      `INSERT INTO platform_blocks (kind, protocol, target_key, reason) VALUES ('source', 'atproto', $1, 'test')`,
      [did],
    );
    const tally = await syncPresenceSources();
    expect(await sourceOf("atproto", did)).toBeUndefined();
    expect(tally.blocked).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Phase 1 — the Mastodon key
  // ---------------------------------------------------------------------------

  async function mastodon(instance: string, id: string): Promise<string> {
    const { rows } = await q(
      `INSERT INTO network_presences (account_id, protocol, external_id, service_url)
       VALUES ($1, 'activitypub', $2, $3) RETURNING id`,
      [member, id, instance],
    );
    return rows[0].id;
  }

  const keyOf = async (presenceId: string) =>
    (await q(`SELECT stable_handle FROM network_presences WHERE id = $1`, [presenceId])).rows[0]
      .stable_handle as string | null;

  it("a Mastodon presence linked before 237 is keyed by its actor uri — and claims, and gets a source", async () => {
    const instance = `https://m${hex(3)}.example`;
    const id = hex(4);
    const actor = `${instance}/users/me`;
    accounts.set(`${instance}|${id}`, actor);
    const presence = await mastodon(instance, id);
    await syncPresenceSources();
    expect(await keyOf(presence)).toBe(actor);
    const { rows } = await q(
      `SELECT account_id FROM external_authors WHERE protocol = 'activitypub' AND stable_handle = $1`,
      [actor],
    );
    expect(rows[0].account_id).toBe(member);
    const src = await sourceOf("activitypub", actor);
    expect(await jobFor(src!.id)).toMatchObject({ identifier: "feed_ingest_activitypub", max_attempts: 1 });
  });

  it("an instance naming another host's actor is refused, and the presence stays unkeyed", async () => {
    const instance = `https://m${hex(3)}.example`;
    const id = hex(4);
    const stolen = `https://victim.example/users/someone`;
    accounts.set(`${instance}|${id}`, stolen);
    const presence = await mastodon(instance, id);
    const tally = await syncPresenceSources();
    expect(await keyOf(presence)).toBeNull();
    expect(tally.unkeyed).toBeGreaterThanOrEqual(1);
    const { rows } = await q(
      `SELECT 1 FROM external_authors WHERE protocol = 'activitypub' AND stable_handle = $1`,
      [stolen],
    );
    expect(rows).toHaveLength(0);
  });

  it("one presence failing does not stop the rest (and is counted)", async () => {
    // Two presences claim one actor: the second key write hits the unique
    // index and fails ALONE; the Bluesky presence after it still gets its
    // source.
    const instance = `https://m${hex(3)}.example`;
    const actor = `${instance}/users/shared`;
    const other = (
      await q(`INSERT INTO accounts (username, nostr_pubkey) VALUES ($1, $2) RETURNING id`, [
        `o-${hex(4)}`,
        hex(32),
      ])
    ).rows[0].id;
    await q(
      `INSERT INTO network_presences (account_id, protocol, external_id, service_url, stable_handle)
       VALUES ($1, 'activitypub', $2, $3, $4)`,
      [other, hex(4), instance, actor],
    );
    const id = hex(4);
    accounts.set(`${instance}|${id}`, actor);
    await mastodon(instance, id);
    const did = await bluesky();
    const tally = await syncPresenceSources();
    expect(tally.failed).toBeGreaterThanOrEqual(1);
    expect((await sourceOf("atproto", did))?.is_active).toBe(true);
  });
});
