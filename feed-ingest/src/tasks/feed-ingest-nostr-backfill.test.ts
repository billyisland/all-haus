import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import pg from "pg";
import {
  collectNostrBackfill,
  buildBackfillRelaySet,
  mergeRelayUrls,
  completeBackfillSource,
  NOSTR_BACKFILL_PAGE_LIMIT,
  NOSTR_BACKFILL_MAX_PAGES,
  NOSTR_BACKFILL_MAX_ITEMS,
} from "./feed-ingest-nostr-backfill.js";
import { NOSTR_FALLBACK_RELAYS } from "@platform-pub/shared/lib/nostr-relay-req.js";
import {
  normaliseNostrEvent,
  nostrEventUri,
  nostrAddrUri,
  type NostrEvent,
} from "../lib/nostr-ingest.js";

// =============================================================================
// feed_ingest_nostr_backfill — pager, relay-set assembly/persistence, cursor
// handoff and identity encoding (EXTERNAL-AUTHOR-HISTORY-ADR §2, §7 Phase 2).
// The pager tests inject a fake fetchPage; the cursor test runs the real SQL
// against a rolled-back transaction (skipped without a DB URL, like the other
// integration tests).
// =============================================================================

const PUBKEY = "a".repeat(64);
const NOW = 2_000_000_000;
const HOUR = 3600;

let seq = 0;
function ev(created_at: number, kind = 1): NostrEvent {
  seq++;
  return {
    id: seq.toString(16).padStart(64, "0"),
    pubkey: PUBKEY,
    created_at,
    kind,
    tags: [],
    content: `event ${seq}`,
    sig: "f".repeat(128),
  };
}

// A full page of `kind` events descending from `newest`, 1s apart.
function fullPage(newest: number, kind = 1): NostrEvent[] {
  return Array.from({ length: NOSTR_BACKFILL_PAGE_LIMIT }, (_, i) =>
    ev(newest - i, kind),
  );
}

function pagedFetcher(pages: NostrEvent[][]) {
  const calls: Record<string, unknown>[][] = [];
  const fetchPage = (filters: Record<string, unknown>[]) => {
    calls.push(filters);
    return Promise.resolve(pages[calls.length - 1] ?? []);
  };
  return { calls, fetchPage };
}

describe("collectNostrBackfill (the `until` pager)", () => {
  it("descends `until` past each page's oldest event; first page carries the kind-0 filter", async () => {
    const page1 = fullPage(NOW - 10);
    const page2: NostrEvent[] = []; // ends the walk
    const { calls, fetchPage } = pagedFetcher([page1, page2]);

    const out = await collectNostrBackfill(PUBKEY, fetchPage, {
      nowSecs: NOW,
      cutoffSecs: NOW - 168 * HOUR,
    });

    expect(calls).toHaveLength(2);
    // Page 1: until = now, plus the kind-0 metadata filter.
    expect(calls[0][0]).toMatchObject({ authors: [PUBKEY], until: NOW });
    expect(calls[0][1]).toMatchObject({ kinds: [0], limit: 1 });
    // Page 2: until = (oldest accepted) − 1, and NO kind-0 filter.
    const oldest = page1[page1.length - 1].created_at;
    expect(calls[1][0]).toMatchObject({ until: oldest - 1 });
    expect(calls[1]).toHaveLength(1);
    expect(out.items).toHaveLength(NOSTR_BACKFILL_PAGE_LIMIT);
  });

  it("stops on the cutoff and excludes events older than it", async () => {
    const cutoff = NOW - 168 * HOUR;
    const page1 = [ev(NOW - 10), ev(cutoff + 5), ev(cutoff - 5)]; // last one too old
    const { calls, fetchPage } = pagedFetcher([page1, fullPage(NOW)]);

    const out = await collectNostrBackfill(PUBKEY, fetchPage, {
      nowSecs: NOW,
      cutoffSecs: cutoff,
    });

    expect(calls).toHaveLength(1); // cutoff reached — no further pages
    expect(out.items).toHaveLength(2);
    expect(out.items.every((e) => e.created_at >= cutoff)).toBe(true);
  });

  it("stops on an empty page and on an undersized page", async () => {
    const empty = pagedFetcher([[]]);
    await collectNostrBackfill(PUBKEY, empty.fetchPage, {
      nowSecs: NOW,
      cutoffSecs: 0,
    });
    expect(empty.calls).toHaveLength(1);

    const undersized = pagedFetcher([[ev(NOW - 1), ev(NOW - 2)], fullPage(NOW)]);
    const out = await collectNostrBackfill(PUBKEY, undersized.fetchPage, {
      nowSecs: NOW,
      cutoffSecs: 0,
    });
    expect(undersized.calls).toHaveLength(1);
    expect(out.items).toHaveLength(2);
  });

  it("stops at MAX_PAGES on endless full pages", async () => {
    // Full pages of kind-5s: they page (full page ⇒ keep descending) but do
    // not count toward the accepted-item cap, so MAX_PAGES is what stops us.
    const pages = Array.from({ length: 10 }, (_, i) =>
      fullPage(NOW - i * (NOSTR_BACKFILL_PAGE_LIMIT + 1), 5),
    );
    const fetcher = pagedFetcher(pages);
    await collectNostrBackfill(PUBKEY, fetcher.fetchPage, {
      nowSecs: NOW,
      cutoffSecs: 0,
    });
    expect(fetcher.calls).toHaveLength(NOSTR_BACKFILL_MAX_PAGES);
  });

  it("stops at the total-accepted item cap", async () => {
    // 100 fresh items per page; cap 200 ⇒ stop after page 2 of 5.
    const pages = Array.from({ length: 5 }, (_, i) =>
      fullPage(NOW - i * (NOSTR_BACKFILL_PAGE_LIMIT + 1)),
    );
    const fetcher = pagedFetcher(pages);
    const out = await collectNostrBackfill(PUBKEY, fetcher.fetchPage, {
      nowSecs: NOW,
      cutoffSecs: 0,
    });
    expect(fetcher.calls).toHaveLength(NOSTR_BACKFILL_MAX_ITEMS / NOSTR_BACKFILL_PAGE_LIMIT);
    expect(out.items).toHaveLength(NOSTR_BACKFILL_MAX_ITEMS);
  });

  it("partitions kinds: 5→deletions, 6/16→reposts, 0→newest-wins profile", async () => {
    const profile1 = ev(NOW - 50, 0);
    const profile2 = ev(NOW - 20, 0);
    const page = [
      ev(NOW - 1, 1),
      ev(NOW - 2, 30023),
      ev(NOW - 3, 5),
      ev(NOW - 4, 6),
      ev(NOW - 5, 16),
      profile1,
      profile2,
    ];
    const fetcher = pagedFetcher([page]);
    const out = await collectNostrBackfill(PUBKEY, fetcher.fetchPage, {
      nowSecs: NOW,
      cutoffSecs: 0,
    });
    expect(out.items.map((e) => e.kind).sort()).toEqual([1, 30023]);
    expect(out.deletions.map((e) => e.kind)).toEqual([5]);
    expect(out.reposts.map((e) => e.kind).sort()).toEqual([16, 6]);
    expect(out.latestProfile?.id).toBe(profile2.id);
    expect(out.newestCreatedAt).toBe(NOW - 1);
  });
});

describe("relay-set assembly (§2.2)", () => {
  it("orders NIP-65 write relays first, then hints, then fallbacks; dedup + cap 6", () => {
    const set = buildBackfillRelaySet(
      ["wss://write1.example", "wss://write2.example", "wss://hint.example"],
      ["wss://hint.example", "wss://hint2.example"],
    );
    expect(set).toEqual([
      "wss://write1.example",
      "wss://write2.example",
      "wss://hint.example",
      "wss://hint2.example",
      NOSTR_FALLBACK_RELAYS[0],
      NOSTR_FALLBACK_RELAYS[1],
    ]);
    expect(set).toHaveLength(6);
  });

  it("rejects non-websocket schemes", () => {
    const set = buildBackfillRelaySet(["https://nope.example"], []);
    expect(set).toEqual(NOSTR_FALLBACK_RELAYS.slice(0, 6));
  });

  it("mergeRelayUrls keeps user entries first, unions, caps at 10", () => {
    const existing = Array.from(
      { length: 8 },
      (_, i) => `wss://user${i}.example`,
    );
    const discovered = [
      "wss://user0.example", // dup
      "wss://disc1.example",
      "wss://disc2.example",
      "wss://disc3.example",
    ];
    const merged = mergeRelayUrls(existing, discovered);
    expect(merged.slice(0, 8)).toEqual(existing); // user entries never dropped
    expect(merged).toHaveLength(10);
    expect(merged).toContain("wss://disc1.example");
    expect(merged).not.toContain("wss://disc3.example"); // capped off
  });
});

describe("identity encoding (C1)", () => {
  it("a backfilled kind-1 and kind-30023 mint the same source_item_uri the poll path mints", () => {
    // Both paths share normaliseNostrEvent (lib/nostr-ingest.ts); this pins
    // the encoding so a refactor that forks them fails loudly.
    const note = ev(NOW - 1, 1);
    expect(normaliseNostrEvent(note, []).sourceItemUri).toBe(
      nostrEventUri(note.id),
    );
    const longform: NostrEvent = {
      ...ev(NOW - 2, 30023),
      tags: [["d", "my-article"]],
    };
    expect(normaliseNostrEvent(longform, []).sourceItemUri).toBe(
      nostrAddrUri(30023, PUBKEY, "my-article"),
    );
    // Relay hints must never enter the identity.
    expect(
      normaliseNostrEvent(note, ["wss://relay.example"]).sourceItemUri,
    ).toBe(normaliseNostrEvent(note, []).sourceItemUri);
  });
});

// ── cursor handoff (§2.4) — real SQL, rolled back ───────────────────────────

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("completeBackfillSource cursor handoff", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  const noProfile = {
    profileName: null,
    profileAvatar: null,
    profileCreatedAt: null,
  };

  async function seedSource(cursor: string | null): Promise<string> {
    const { rows } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, cursor, error_count, last_error)
       VALUES ('nostr_external', $1, $2, 3, 'boom') RETURNING id`,
      ["b".repeat(64), cursor],
    );
    return rows[0].id;
  }

  async function readSource(id: string) {
    const { rows } = await client.query(
      `SELECT cursor, error_count, last_error, last_fetched_at
         FROM external_sources WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  it("advances a NULL / older cursor and resets error accounting", async () => {
    const id = await seedSource(null);
    await completeBackfillSource(client, id, 1_900_000_000, noProfile);
    const row = await readSource(id);
    expect(row.cursor).toBe("1900000000");
    expect(row.error_count).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.last_fetched_at).not.toBeNull();
  });

  it("never moves the cursor backwards (concurrent poll won the race)", async () => {
    const id = await seedSource("1950000000");
    await completeBackfillSource(client, id, 1_900_000_000, noProfile);
    expect((await readSource(id)).cursor).toBe("1950000000");
  });

  it("leaves the cursor untouched when the backfill found nothing", async () => {
    const id = await seedSource("1950000000");
    await completeBackfillSource(client, id, 0, noProfile);
    expect((await readSource(id)).cursor).toBe("1950000000");
  });
});
