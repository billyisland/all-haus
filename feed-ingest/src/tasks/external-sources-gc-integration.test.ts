import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { GC_MARK_SQL, GC_DEACTIVATE_SQL, GC_CULL_SQL, GC_REHOME_SQL } from "./external-sources-gc.js";

// =============================================================================
// external_sources_gc — the guards a cull needs (MIRROR-AUDIT §3 *Data
// integrity and ingest*, S17).
//
// Culling an external_sources row CASCADEs: feed_sources, external_items and
// through those the feed_items twins all go with it. Two classes of reference
// were unguarded, and both fail SILENTLY — which is why nobody noticed, unlike
// the citation_edges case (M15), where a RESTRICT violation wedged the whole
// batch loudly enough to be found.
//
//   • feed_sources. In a healthy database an external_subscriptions row exists
//     iff the source sits in ≥1 feed, so the subscriber guard covers this. The
//     guard is for the day the projection drifts — CLAUDE.md's own warning that
//     an external add path forgetting the upsert "orphans an in-use source" —
//     where the cull would quietly remove a source from a member's feed.
//
//   • notes.external_parent_id (ON DELETE SET NULL — the native reply survives,
//     unhooked, and the thread breaks) and votes.target_nostr_event_id (no FK
//     at all — the vote survives pointing at nothing). external_items_prune
//     guards both per ITEM; without them here the cull is simply a way around
//     that guard.
//
// Runs the task's own exported statements against a live Postgres inside a
// transaction that is ALWAYS rolled back. The assertions are per-fixture, never
// rowCounts: the statements are unfiltered, so on a dev database they act on
// every row in the table.
//
// Mutation-proved: removing any one guard from the task fails its case here.
// The presence guard (CROSS-NETWORK-ROUNDTRIP-ADR D2, 2026-09-27): removed from
// all three statements → 3 FAIL; its `lifecycle_state = 'active'` term dropped
// in shared/src/lib/presence-claim.ts → the control fails (1 FAIL).
//
// Skipped unless a DB URL is supplied — CI supplies one and fails on a skip:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/tasks/external-sources-gc-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Long past both windows (defaults 7 / 90 days), so only the guards decide.
const LONG_AGO = "now() - interval '400 days'";

describe.skipIf(!DB_URL)("external_sources_gc reference guards (S17)", () => {
  let client: pg.Client;
  let seq = 0;
  const uniq = () => `s17gc-${Date.now().toString(36)}-${seq++}`;

  let ownerId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    ownerId = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** An orphan source, already deactivated and long past the cull window. */
  async function cullableSource(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources
         (protocol, source_uri, is_active, orphaned_at, created_at)
       VALUES ('rss', $1, FALSE, ${LONG_AGO}, ${LONG_AGO})
       RETURNING id`,
      [`https://example.com/${uniq()}.xml`],
    );
    return rows[0].id;
  }

  async function itemOn(sourceId: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_items (source_id, protocol, tier, source_item_uri, published_at)
       VALUES ($1, 'rss', 'tier4', $2, now()) RETURNING id`,
      [sourceId, `uri://${uniq()}`],
    );
    return rows[0].id;
  }

  async function feedContaining(sourceId: string): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'a feed', 1) RETURNING id`,
      [ownerId],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [rows[0].id, sourceId],
    );
  }

  const survives = async (sourceId: string) =>
    (await client.query(`SELECT 1 FROM external_sources WHERE id = $1`, [sourceId]))
      .rowCount === 1;

  const orphanedAt = async (sourceId: string) =>
    (
      await client.query<{ orphaned_at: Date | null }>(
        `SELECT orphaned_at FROM external_sources WHERE id = $1`,
        [sourceId],
      )
    ).rows[0].orphaned_at;

  const isActive = async (sourceId: string) =>
    (
      await client.query<{ is_active: boolean }>(
        `SELECT is_active FROM external_sources WHERE id = $1`,
        [sourceId],
      )
    ).rows[0].is_active;

  // ── the control ─────────────────────────────────────────────────────────

  it("an unreferenced orphan is still culled", async () => {
    // Without this the whole suite would pass against a GC that culls nothing.
    const src = await cullableSource();
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(false);
  });

  // ── feed_sources ────────────────────────────────────────────────────────

  it("a source still in a feed is not culled, even with no subscription row", async () => {
    const src = await cullableSource();
    await feedContaining(src);
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(true);
  });

  it("a source still in a feed is not even MARKED orphaned", async () => {
    // The grace window must not start ticking on a live source: by the time
    // anyone looked it would already be deactivated and half-way to culled.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri) VALUES ('rss', $1) RETURNING id`,
      [`https://example.com/${uniq()}.xml`],
    );
    const src = rows[0].id;
    await feedContaining(src);
    await client.query(GC_MARK_SQL);
    expect(await orphanedAt(src)).toBeNull();
  });

  it("a source still in a feed is not deactivated", async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active, orphaned_at)
       VALUES ('rss', $1, TRUE, ${LONG_AGO}) RETURNING id`,
      [`https://example.com/${uniq()}.xml`],
    );
    const src = rows[0].id;
    await feedContaining(src);
    await client.query(GC_DEACTIVATE_SQL, [7]);
    expect(await isActive(src)).toBe(true);
  });

  // ── a member's own presence (CROSS-NETWORK-ROUNDTRIP-ADR D2) ─────────────
  //
  // presence_sources_sync keeps a linked Bluesky/Mastodon identity ingesting
  // with NO external_subscriptions row (that row is a projection of feed
  // membership). The GC must spare it on the presence instead, in every phase,
  // and only while the presence is live.

  async function presenceSource(
    state: "active" | "deprovisioned",
    source: { isActive: boolean; orphanedLongAgo: boolean } = { isActive: true, orphanedLongAgo: false },
  ): Promise<string> {
    const did = `did:plc:${uniq()}`;
    await client.query(
      `INSERT INTO network_presences (account_id, protocol, external_id, stable_handle, lifecycle_state)
       VALUES ($1, 'atproto', $2, $2, $3)`,
      [ownerId, did, state],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, is_active, orphaned_at)
       VALUES ('atproto', $1, $2, CASE WHEN $3 THEN ${LONG_AGO} END) RETURNING id`,
      [did, source.isActive, source.orphanedLongAgo],
    );
    return rows[0].id;
  }

  it("a member's own presence source is not MARKED orphaned", async () => {
    const src = await presenceSource("active");
    await client.query(GC_MARK_SQL);
    expect(await orphanedAt(src)).toBeNull();
  });

  it("a member's own presence source is not deactivated", async () => {
    const src = await presenceSource("active", { isActive: true, orphanedLongAgo: true });
    await client.query(GC_DEACTIVATE_SQL, [7]);
    expect(await isActive(src)).toBe(true);
  });

  it("a member's own presence source is not culled", async () => {
    const src = await presenceSource("active", { isActive: false, orphanedLongAgo: true });
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(true);
  });

  it("an UNLINKED presence spares nothing (control)", async () => {
    // A guard that matched any presence row would keep a deprovisioned
    // member's source polling for ever.
    const src = await presenceSource("deprovisioned");
    await client.query(GC_MARK_SQL);
    expect(await orphanedAt(src)).not.toBeNull();
  });

  // ── the prune-parity guards ─────────────────────────────────────────────

  it("a source whose item is a native reply's parent is not culled", async () => {
    const src = await cullableSource();
    const itemId = await itemOn(src);
    await client.query(
      `INSERT INTO notes (author_id, nostr_event_id, content, external_parent_id)
       VALUES ($1, $2, 'a reply', $3)`,
      [ownerId, uniq().padEnd(64, "0"), itemId],
    );
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(true);
  });

  it("a source whose item a notification names is not culled", async () => {
    // The linked-notification poller anchors every reply that reaches a
    // member on its author's SHADOW source — inactive and orphaned, exactly
    // what this cull is for — and the notification CASCADEs with the item
    // (migration 236). Without the guard, every one vanishes at the window.
    const src = await cullableSource();
    const itemId = await itemOn(src);
    await client.query(
      `INSERT INTO notifications (recipient_id, type, external_item_id) VALUES ($1, 'external_reply', $2)`,
      [ownerId, itemId],
    );
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(true);
  });

  it("a source whose item carries a vote is not culled", async () => {
    const src = await cullableSource();
    const itemId = await itemOn(src);
    await client.query(
      `INSERT INTO votes (voter_id, target_nostr_event_id, target_author_id, direction, sequence_number)
       VALUES ($1, $2, $1, 'up', 1)`,
      [ownerId, itemId],
    );
    await client.query(GC_CULL_SQL, [90]);
    expect(await survives(src)).toBe(true);
  });

  // ── CA-C4: an item another live source SERVES outlives its home's cull ──

  async function liveSource(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri) VALUES ('rss', $1) RETURNING id`,
      [`https://example.com/live-${uniq()}.xml`],
    );
    return rows[0].id;
  }
  async function servedBy(itemId: string, sourceId: string): Promise<void> {
    await client.query(
      `INSERT INTO external_item_sources (external_item_id, source_id) VALUES ($1, $2)`,
      [itemId, sourceId],
    );
  }
  async function feedItemFor(itemId: string, sourceId: string): Promise<void> {
    await client.query(
      `INSERT INTO feed_items (item_type, external_item_id, published_at, source_protocol, source_item_uri, source_id)
       SELECT 'external', id, published_at, 'rss', source_item_uri, $2 FROM external_items WHERE id = $1`,
      [itemId, sourceId],
    );
  }
  const homeOf = async (itemId: string) =>
    (
      await client.query<{ ei: string | null; fi: string | null }>(
        `SELECT ei.source_id AS ei, fi.source_id AS fi
           FROM external_items ei LEFT JOIN feed_items fi ON fi.external_item_id = ei.id
          WHERE ei.id = $1`,
        [itemId],
      )
    ).rows[0];

  const cull = async () => {
    await client.query(GC_REHOME_SQL, [90]);
    await client.query(GC_CULL_SQL, [90]);
  };

  it("an item a live source also serves is re-homed onto it, on both tables, and survives the cull", async () => {
    const doomed = await cullableSource();
    const live = await liveSource();
    const itemId = await itemOn(doomed);
    await feedItemFor(itemId, doomed);
    await servedBy(itemId, live);

    await cull();

    expect(await survives(doomed)).toBe(false);
    expect(await homeOf(itemId)).toEqual({ ei: live, fi: live });
  });

  it("CONTROL: without the re-home the cull's cascade takes the shared item", async () => {
    const doomed = await cullableSource();
    const live = await liveSource();
    const itemId = await itemOn(doomed);
    await servedBy(itemId, live);

    await client.query(GC_CULL_SQL, [90]);

    expect(await homeOf(itemId)).toBeUndefined();
  });

  it("an item served only by orphans goes with the cull", async () => {
    const doomed = await cullableSource();
    const alsoDoomed = await cullableSource();
    const itemId = await itemOn(doomed);
    await servedBy(itemId, alsoDoomed);

    await cull();

    expect(await homeOf(itemId)).toBeUndefined();
  });
});
