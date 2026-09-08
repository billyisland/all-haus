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
  insertNostrItem,
  applyNostrDeletions,
  nostrEventUri,
  type NostrEvent,
} from "./nostr-ingest.js";
import { insertAtprotoItem } from "./atproto-ingest.js";
import { insertActivityPubItem } from "./activitypub-ingest.js";
import type { NormalisedAtprotoItem } from "../adapters/atproto.js";
import type { NormalisedActivityPubItem } from "../adapters/activitypub.js";

// =============================================================================
// §4.2 promotion on real ingest (EXTERNAL-AUTHOR-HISTORY-ADR §1.5/§4.2).
//
// A row first persisted context-only by thread/profile hydration must be
// PROMOTED when the same post arrives through real ingest: is_context_only /
// is_profile_hydrated cleared and source_id re-homed from the hydrating
// focal's source to the author's own — on BOTH external_items and feed_items.
// The re-home is load-bearing: nostr kind-5 deletion application matches on
// source_id, and feed membership resolves through feed_sources.source_id.
// Real rows must keep the old semantics (atproto/AP: DO NOTHING no-op; nostr:
// the published_at ratchet still blocks re-ingest of the same event).
//
// Runs the REAL writers against a live Postgres, seeding fixtures inside a
// transaction that is ALWAYS rolled back. Skipped unless a DB URL is supplied —
// CI supplies one (it boots Postgres and FAILS on a skip). Run locally against dev:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run src/lib/ingest-promotion.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const AUTHOR_PUBKEY = "a".repeat(64);
const EVENT_ID = "b".repeat(64);

describe.skipIf(!DB_URL)("§4.2 ingest promotion", () => {
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

  async function createSource(
    protocol: string,
    sourceUri: string,
  ): Promise<{
    id: string;
    source_uri: string;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
  }> {
    const { rows } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, source_uri, handle, display_name, avatar_url`,
      [protocol, sourceUri, `src ${sourceUri.slice(0, 12)}`],
    );
    return rows[0];
  }

  // Mimic persistHydratedThreadNodes' dual-write: a context-only row filed
  // under the HYDRATING FOCAL's source (not the author's own).
  async function seedContextRow(opts: {
    sourceId: string;
    protocol: string;
    uri: string;
    publishedAt: Date;
    interactionData?: Record<string, unknown>;
    profileHydrated?: boolean;
  }): Promise<string> {
    // Same tier rule as persistHydratedThreadNodes (protocol_tier_consistency).
    const tier = opts.protocol === "nostr_external" ? "tier2" : "tier3";
    const { rows } = await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri,
         author_name, content_text, published_at,
         interaction_data, is_context_only, is_profile_hydrated
       ) VALUES ($1, $2, ${tier === "tier2" ? "'tier2'" : "'tier3'"}, $3, 'Hydrated Author', 'hydrated body', $4, $5, TRUE, $6)
       RETURNING id`,
      [
        opts.sourceId,
        opts.protocol,
        opts.uri,
        opts.publishedAt,
        JSON.stringify(opts.interactionData ?? {}),
        opts.profileHydrated ?? false,
      ],
    );
    const extId = rows[0].id as string;
    await client.query(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, title, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, 'Hydrated Author', NULL, 'hydrated body', $2, $3, $4, $5, '[]'::jsonb, FALSE)
       ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING`,
      [extId, opts.publishedAt, opts.protocol, opts.uri, opts.sourceId],
    );
    return extId;
  }

  async function rowState(uri: string) {
    const { rows } = await client.query(
      `SELECT ei.id, ei.source_id AS ei_source, ei.is_context_only,
              ei.is_profile_hydrated, ei.deleted_at AS ei_deleted,
              fi.source_id AS fi_source, fi.deleted_at AS fi_deleted
         FROM external_items ei
         JOIN feed_items fi ON fi.external_item_id = ei.id
        WHERE ei.source_item_uri = $1`,
      [uri],
    );
    return rows[0];
  }

  const nostrEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent => ({
    id: EVENT_ID,
    pubkey: AUTHOR_PUBKEY,
    created_at: 1_750_000_000,
    kind: 1,
    tags: [],
    content: "hello from the author",
    sig: "f".repeat(128),
    ...overrides,
  });

  // ── nostr ─────────────────────────────────────────────────────────────────

  it("nostr: promotes a context row on real ingest of the identical event", async () => {
    const focalSource = await createSource("nostr_external", "c".repeat(64));
    const authorSource = await createSource("nostr_external", AUTHOR_PUBKEY);
    const event = nostrEvent();
    const uri = nostrEventUri(EVENT_ID);

    await seedContextRow({
      sourceId: focalSource.id,
      protocol: "nostr_external",
      uri,
      publishedAt: new Date(event.created_at * 1000),
      interactionData: { id: EVENT_ID, pubkey: AUTHOR_PUBKEY, relays: [] },
      profileHydrated: true,
    });

    const outcome = await insertNostrItem(client, authorSource, event, {
      relays: ["wss://relay.example"],
      sourceNip05: null,
    });
    expect(outcome).toBe("updated");

    const state = await rowState(uri);
    expect(state.is_context_only).toBe(false);
    expect(state.is_profile_hydrated).toBe(false);
    expect(state.ei_source).toBe(authorSource.id); // re-homed
    expect(state.fi_source).toBe(authorSource.id); // re-homed on feed_items too
    expect(state.fi_deleted).toBeNull();
  });

  it("nostr: ratchet still blocks re-ingest of an already-real event", async () => {
    const authorSource = await createSource("nostr_external", AUTHOR_PUBKEY);
    const event = nostrEvent();
    const opts = { relays: ["wss://relay.example"], sourceNip05: null };

    expect(await insertNostrItem(client, authorSource, event, opts)).toBe(
      "inserted",
    );
    expect(await insertNostrItem(client, authorSource, event, opts)).toBe(
      "skipped",
    );
  });

  it("nostr: a promoted row is then hit by its author's kind-5 deletion", async () => {
    const focalSource = await createSource("nostr_external", "c".repeat(64));
    const authorSource = await createSource("nostr_external", AUTHOR_PUBKEY);
    const event = nostrEvent();
    const uri = nostrEventUri(EVENT_ID);

    await seedContextRow({
      sourceId: focalSource.id,
      protocol: "nostr_external",
      uri,
      publishedAt: new Date(event.created_at * 1000),
      interactionData: { id: EVENT_ID, pubkey: AUTHOR_PUBKEY, relays: [] },
    });
    await insertNostrItem(client, authorSource, event, {
      relays: [],
      sourceNip05: null,
    });

    // The author's deletion applies via THEIR source id — this is exactly what
    // the source_id re-home buys (a row left on the focal's source would miss).
    const del = nostrEvent({
      id: "d".repeat(64),
      kind: 5,
      tags: [["e", EVENT_ID]],
      created_at: event.created_at + 10,
    });
    await applyNostrDeletions(client, authorSource.id, [del], AUTHOR_PUBKEY);

    const state = await rowState(uri);
    expect(state.ei_deleted).not.toBeNull();
    expect(state.fi_deleted).not.toBeNull();
  });

  // ── atproto ───────────────────────────────────────────────────────────────

  const AT_URI = "at://did:plc:author123/app.bsky.feed.post/rkey1";
  const atprotoItem = (): NormalisedAtprotoItem => ({
    sourceItemUri: AT_URI,
    authorDid: "did:plc:author123",
    contentText: "bsky post body",
    contentHtml: "<p>bsky post body</p>",
    media: [],
    publishedAt: new Date("2026-06-01T10:00:00Z"),
    language: null,
    sourceReplyUri: null,
    sourceQuoteUri: null,
    isRepost: false,
    interactionData: { uri: AT_URI, cid: "cid123" },
  });

  it("atproto: promotes a context row, then no-ops on re-ingest", async () => {
    const focalSource = await createSource("atproto", "did:plc:focal999");
    const authorSource = await createSource("atproto", "did:plc:author123");

    await seedContextRow({
      sourceId: focalSource.id,
      protocol: "atproto",
      uri: AT_URI,
      publishedAt: new Date("2026-06-01T10:00:00Z"),
      profileHydrated: true,
    });

    const promoted = await insertAtprotoItem(client, authorSource, atprotoItem());
    expect(promoted).toBe(true);

    const state = await rowState(AT_URI);
    expect(state.is_context_only).toBe(false);
    expect(state.is_profile_hydrated).toBe(false);
    expect(state.ei_source).toBe(authorSource.id);
    expect(state.fi_source).toBe(authorSource.id);
    expect(state.fi_deleted).toBeNull();

    // Now a REAL row — the old DO NOTHING contract must hold.
    const again = await insertAtprotoItem(client, authorSource, atprotoItem());
    expect(again).toBe(false);
  });

  // ── activitypub ───────────────────────────────────────────────────────────

  const AP_URI = "https://mastodon.example/users/author/statuses/1";
  const apItem = (): NormalisedActivityPubItem => ({
    sourceItemUri: AP_URI,
    title: null,
    authorName: "AP Author",
    authorHandle: "author@mastodon.example",
    authorAvatarUrl: null,
    authorUri: "https://mastodon.example/users/author",
    contentText: "toot body",
    contentHtml: "<p>toot body</p>",
    language: null,
    media: [],
    sourceReplyUri: null,
    sourceQuoteUri: null,
    contentWarning: null,
    publishedAt: new Date("2026-06-01T11:00:00Z"),
    webUrl: null,
    interactionData: { id: AP_URI },
  });

  it("activitypub: promotes a context row, then no-ops on re-ingest", async () => {
    const focalSource = await createSource(
      "activitypub",
      "https://mastodon.example/users/focal",
    );
    const authorSource = await createSource(
      "activitypub",
      "https://mastodon.example/users/author",
    );

    await seedContextRow({
      sourceId: focalSource.id,
      protocol: "activitypub",
      uri: AP_URI,
      publishedAt: new Date("2026-06-01T11:00:00Z"),
    });

    const promoted = await insertActivityPubItem(client, authorSource, apItem());
    expect(promoted).toBe(true);

    const state = await rowState(AP_URI);
    expect(state.is_context_only).toBe(false);
    expect(state.is_profile_hydrated).toBe(false);
    expect(state.ei_source).toBe(authorSource.id);
    expect(state.fi_source).toBe(authorSource.id);
    expect(state.fi_deleted).toBeNull();

    const again = await insertActivityPubItem(client, authorSource, apItem());
    expect(again).toBe(false);
  });
});
