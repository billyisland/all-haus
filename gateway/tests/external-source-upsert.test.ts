import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  EXTERNAL_SOURCE_UPSERT_SQL,
  addSource,
} from "../src/routes/feeds/sources.js";
import { mergeNostrRelayUrls } from "@platform-pub/shared/lib/nip65.js";

// =============================================================================
// One row, many subscribers — the second one may not rewrite the first's
// (MIRROR-AUDIT §2.11, S7).
//
// `external_sources` is a SHARED row: every subscriber to a given
// (protocol, source_uri) reads the same `display_name` / `description` /
// `avatar_url` / `relay_urls`. `POST /workspace/feeds/:id/sources` used to let
// the caller's values WIN on conflict, so one add relabelled the Guardian for
// everyone, and the relay hints REPLACED the stored list, which silences a
// shared Nostr author site-wide once the hostile list fills the persist cap.
//
// WHY DB-BACKED. Fill-only-NULL is Postgres's evaluation of
// COALESCE(NULLIF(existing,''), NULLIF($n,'')) inside an ON CONFLICT DO UPDATE
// — a mocked `pool.query` dispatching on query text would hand back whichever
// row the fixture holds and agree with itself whichever operand order the
// statement has. So this runs the REAL exported statement.
//
// The last case drives the REAL `addSource` rather than the statement, because
// the rule this closes is split across two statements — the upsert leaves
// `relay_urls` alone and the call site unions them — and a suite that only ran
// the SQL would be green against a route that had silently dropped the merge.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/external-source-upsert.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("external_sources shared-row upsert", () => {
  let client: pg.Client;
  const stamp = Date.now().toString(36);
  const uris: string[] = [];
  const accounts: string[] = [];

  // The route's own argument order.
  const upsert = (
    protocol: string,
    sourceUri: string,
    displayName: string | null,
    description: string | null,
    avatarUrl: string | null,
    relayUrls: string[] | null,
  ) =>
    client.query<{ id: string; relay_urls: string[] | null; created: boolean }>(
      EXTERNAL_SOURCE_UPSERT_SQL,
      [protocol, sourceUri, displayName, description, avatarUrl, relayUrls],
    );

  const uri = (name: string) => {
    const u = `https://example.com/${name}-${stamp}.xml`;
    uris.push(u);
    return u;
  };

  const read = async (sourceUri: string) =>
    (
      await client.query<{
        display_name: string | null;
        description: string | null;
        avatar_url: string | null;
        relay_urls: string[] | null;
        is_active: boolean;
        orphaned_at: Date | null;
      }>(
        `SELECT display_name, description, avatar_url, relay_urls, is_active, orphaned_at
           FROM external_sources WHERE source_uri = $1`,
        [sourceUri],
      )
    ).rows[0];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (accounts.length > 0) {
      // feeds / feed_sources / external_subscriptions all cascade from accounts.
      await client.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accounts]);
    }
    if (uris.length > 0) {
      await client.query(`DELETE FROM external_sources WHERE source_uri = ANY($1)`, [uris]);
    }
    await client.end();
  });

  it("lets the first subscriber name a source", async () => {
    const u = uri("first");
    await upsert("rss", u, "The Guardian", "News", "https://cdn/a.png", null);
    expect(await read(u)).toMatchObject({
      display_name: "The Guardian",
      description: "News",
      avatar_url: "https://cdn/a.png",
    });
  });

  it("says whether it CREATED the row — only a new source takes the start-interval dial (CA-F4)", async () => {
    // addSource stamps feed_ingest_rss_interval_seconds only where this is
    // true: a shared row that already exists has an interval its adaptive
    // polling earned, and a later subscriber must not reset it.
    const u = uri("created");
    const first = await upsert("rss", u, null, null, null, null);
    const second = await upsert("rss", u, null, null, null, null);
    expect(first.rows[0].created).toBe(true);
    expect(second.rows[0].created).toBe(false);
  });

  it("refuses to let a later subscriber rewrite what is already there", async () => {
    const u = uri("relabel");
    await upsert("rss", u, "The Guardian", "News", "https://cdn/a.png", null);
    await upsert("rss", u, "NOT THE GUARDIAN", "spam", "https://evil/x.png", null);
    // THE finding: under the old operand order all three would now be the
    // second caller's.
    expect(await read(u)).toMatchObject({
      display_name: "The Guardian",
      description: "News",
      avatar_url: "https://cdn/a.png",
    });
  });

  it("still fills a column that is NULL, which is what the liveness probe needs", async () => {
    const u = uri("backfill");
    // A direct-API add naming nothing — the probe's metadata rides this same
    // statement, so a probed name must still land.
    await upsert("rss", u, null, null, null, null);
    await upsert("rss", u, "Probed Title", null, "https://cdn/p.png", null);
    expect(await read(u)).toMatchObject({
      display_name: "Probed Title",
      description: null,
      avatar_url: "https://cdn/p.png",
    });
    // And a THIRD caller still cannot overwrite what the probe filled.
    await upsert("rss", u, "Hostile", "Hostile", "https://evil/x.png", null);
    expect(await read(u)).toMatchObject({
      display_name: "Probed Title",
      avatar_url: "https://cdn/p.png",
      description: "Hostile", // the one that was still NULL
    });
  });

  it("treats an empty string as nothing, on both sides", async () => {
    const u = uri("blank");
    await upsert("rss", u, "", "", "", null);
    await upsert("rss", u, "Real Name", null, null, null);
    expect(await read(u)).toMatchObject({ display_name: "Real Name" });
  });

  it("revives an orphaned source and leaves relay_urls to the caller", async () => {
    const u = uri("revive");
    await upsert("nostr_external", u, "Author", null, null, ["wss://one.example"]);
    await client.query(
      `UPDATE external_sources SET is_active = FALSE, orphaned_at = now() WHERE source_uri = $1`,
      [u],
    );
    const { rows } = await upsert("nostr_external", u, null, null, null, [
      "wss://two.example",
    ]);
    expect(await read(u)).toMatchObject({ is_active: true, orphaned_at: null });
    // The DO UPDATE does not touch relay_urls — the union happens at the call
    // site, over exactly the list this statement RETURNS. Under the old
    // `relay_urls = COALESCE($6, …)` the stored relay would be gone by now.
    expect(rows[0].relay_urls).toEqual(["wss://one.example"]);
  });

  it("adds through the real addSource without letting the newcomer silence the source", async () => {
    // End to end: two owners add the same Nostr author, the second one hostile.
    // `skipProbe` is the bulk-import path (D6), which is what lets this run with
    // no network — the upsert and the merge are unchanged by it.
    const u = uri("wiring");
    const acct = async (tag: string) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
          [`src${stamp}${tag}`.padEnd(64, "0")],
        )
      ).rows[0].id;
    const feed = async (owner: string, name: string) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, $2, 0) RETURNING id`,
          [owner, name],
        )
      ).rows[0].id;

    const alice = await acct("a");
    const mallory = await acct("m");
    accounts.push(alice, mallory);
    const aliceFeed = await feed(alice, `alice-${stamp}`);
    const malloryFeed = await feed(mallory, `mallory-${stamp}`);

    await addSource(
      aliceFeed,
      alice,
      {
        sourceType: "external_source",
        protocol: "nostr_external",
        sourceUri: u,
        displayName: "Real Author",
        relayUrls: ["wss://alice-relay.example"],
      },
      { skipProbe: true },
    );

    await addSource(
      malloryFeed,
      mallory,
      {
        sourceType: "external_source",
        protocol: "nostr_external",
        sourceUri: u,
        displayName: "NOT THE AUTHOR",
        relayUrls: [
          "wss://evil-1.example",
          "wss://evil-2.example",
          "wss://evil-3.example",
        ],
      },
      { skipProbe: true },
    );

    const row = await read(u);
    expect(row.display_name).toBe("Real Author");
    // Alice's relay is still first and still there — the hostile hints could
    // only append. Replacing would have left the author unreachable for both.
    expect(row.relay_urls).toEqual([
      "wss://alice-relay.example",
      "wss://evil-1.example",
      "wss://evil-2.example",
      "wss://evil-3.example",
    ]);
  });

  it("a NEW RSS source starts at the dial's interval; a later add leaves the earned one alone (CA-F4)", async () => {
    // The dial's seeded value (300) equals the column DEFAULT, so a test at
    // the seeded value passes against a reader that reads nothing. Set it to
    // something the default cannot produce, and move it again before the
    // second add, then assert which value reached the row.
    const { invalidatePlatformConfig } = await import("../src/lib/platform-config.js");
    const key = "feed_ingest_rss_interval_seconds";
    const before = (
      await client.query<{ value: string }>(`SELECT value FROM platform_config WHERE key = $1`, [key])
    ).rows[0]?.value;
    const setDial = async (v: string) => {
      await client.query(`UPDATE platform_config SET value = $2 WHERE key = $1`, [key, v]);
      invalidatePlatformConfig();
    };
    const acct = async (tag: string) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
          [`rss${stamp}${tag}`.padEnd(64, "0")],
        )
      ).rows[0].id;
    const feed = async (owner: string, name: string) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, $2, 0) RETURNING id`,
          [owner, name],
        )
      ).rows[0].id;
    const interval = async (sourceUri: string) =>
      (
        await client.query<{ fetch_interval_seconds: number }>(
          `SELECT fetch_interval_seconds FROM external_sources WHERE source_uri = $1`,
          [sourceUri],
        )
      ).rows[0].fetch_interval_seconds;

    const u = uri("rss-start");
    const a = await acct("a");
    const b = await acct("b");
    accounts.push(a, b);
    try {
      await setDial("777");
      await addSource(
        await feed(a, `rss-a-${stamp}`),
        a,
        { sourceType: "external_source", protocol: "rss", sourceUri: u },
        { skipProbe: true },
      );
      expect(await interval(u)).toBe(777);

      await setDial("999");
      await addSource(
        await feed(b, `rss-b-${stamp}`),
        b,
        { sourceType: "external_source", protocol: "rss", sourceUri: u },
        { skipProbe: true },
      );
      expect(await interval(u)).toBe(777);
    } finally {
      if (before !== undefined) await setDial(before);
    }
  });

  it("unions a newcomer's relay hints onto the stored list, newcomer LAST", async () => {
    // The call-site rule, run over the statement's own RETURNING. Ordering is
    // the security half: existing first means the cap drops the newcomer's
    // entries, never the author's real write relays.
    const stored = ["wss://real-a", "wss://real-b"];
    const hostile = ["wss://evil-1", "wss://evil-2", "wss://evil-3"];
    const merged = mergeNostrRelayUrls(stored, hostile);
    expect(merged.slice(0, 2)).toEqual(stored);
    expect(merged).toHaveLength(5);

    // At the cap, a newcomer's hints cannot land at all.
    const full = Array.from({ length: 10 }, (_, i) => `wss://real-${i}`);
    expect(mergeNostrRelayUrls(full, hostile)).toEqual(full);
  });
});
