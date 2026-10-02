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
import { persistHydratedThreadNodes } from "../src/lib/external-hydration.js";
import { CONTEXT_INTERACTION_MERGE_SQL } from "../src/lib/external-items-shared.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// =============================================================================
// A context write MERGES interaction_data; it never replaces it
// (MIRROR-AUDIT §3 *Data integrity and ingest*, S17).
//
// Hydration and the four thread/parent fetchers all upsert on
// (protocol, source_item_uri) — the same key real ingest uses — so every one of
// them collides with real rows routinely. All five assigned
// `interaction_data = EXCLUDED.interaction_data`, and the hydrated payload is
// THINNER than the ingested one: atproto ingest stores rootUri/rootCid/
// parentUri/parentCid and hydration stores {uri, cid}; activitypub ingest
// stores poll/audience/activityId/replyTo and hydration stores {id, webUrl}.
// So expanding a thread deleted the strong-ref data outbound-cross-post needs
// and the poll a Mastodon card renders — from REAL rows, silently, and only
// visible later as a cross-post that cannot build its reference.
//
// This has to be DB-backed: `jsonb ||` is Postgres's evaluation, and a mocked
// client dispatching on query text would hand back whatever the fixture says
// the merge produces, which is the thing under test. It drives the real
// `persistHydratedThreadNodes` on a rolled-back transaction.
//
// The last case is the pin for the other four sites: the merge lives in ONE
// exported constant and each of the five interpolates it, so a site that
// spelled its own would be a text difference this test can see. Five copies of
// one rule drift, and this one drifts silently.
//
// Mutation-proved: restoring `interaction_data = EXCLUDED.interaction_data` in
// CONTEXT_INTERACTION_MERGE_SQL fails the first two cases.
//
// Skipped unless a DB URL is supplied — CI supplies one and fails on a skip:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/context-interaction-merge.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("context writes merge interaction_data (S17)", () => {
  let pool: pg.Pool;
  let client: pg.PoolClient;
  let seq = 0;
  const uniq = () => `s17merge-${Date.now().toString(36)}-${seq++}`;

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

  async function createSource(protocol: string): Promise<string> {
    const { rows } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, display_name)
       VALUES ($1, $2, 'a source') RETURNING id`,
      [protocol, `${protocol}://${uniq()}`],
    );
    return rows[0].id;
  }

  /** A REAL ingested row, with the rich interaction_data only ingest sees. */
  async function seedRealRow(
    sourceId: string,
    protocol: string,
    uri: string,
    interactionData: Record<string, unknown>,
  ): Promise<void> {
    const tier = protocol === "nostr_external" ? "tier2" : "tier3";
    await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri,
         author_name, content_text, published_at, interaction_data,
         is_context_only
       ) VALUES ($1, $2, $3, $4, 'Real Author', 'the real body',
                 '2026-01-01T00:00:00Z', $5, FALSE)`,
      [sourceId, protocol, tier, uri, JSON.stringify(interactionData)],
    );
  }

  async function interactionData(uri: string): Promise<Record<string, unknown>> {
    const { rows } = await client.query(
      `SELECT interaction_data FROM external_items WHERE source_item_uri = $1`,
      [uri],
    );
    expect(rows).toHaveLength(1);
    return rows[0].interaction_data;
  }

  const node = (uri: string, data: Record<string, unknown>) => ({
    sourceItemUri: uri,
    sourceReplyUri: null,
    sourceQuoteUri: null,
    authorName: "Hydrated Author",
    authorHandle: null,
    authorAvatarUrl: null,
    authorUri: null,
    contentText: "hydrated body",
    contentHtml: null,
    media: [],
    interactionData: data,
    likeCount: 7,
    replyCount: 1,
    repostCount: 2,
    publishedAt: new Date("2026-01-01T00:00:00Z"),
  });

  it("atproto: hydration keeps the strong-ref keys it never fetched", async () => {
    const sourceId = await createSource("atproto");
    const uri = `at://did:plc:${uniq()}/app.bsky.feed.post/abc`;
    await seedRealRow(sourceId, "atproto", uri, {
      uri,
      cid: "bafyREAL",
      rootUri: "at://did:plc:root/app.bsky.feed.post/root",
      rootCid: "bafyROOT",
      parentUri: "at://did:plc:parent/app.bsky.feed.post/p",
      parentCid: "bafyPARENT",
    });

    // Exactly what collectBlueskyThreadNodes builds: {uri, cid} and no more.
    await persistHydratedThreadNodes(
      sourceId,
      "atproto",
      [node(uri, { uri, cid: "bafyFRESH" })],
      { client },
    );

    const after = await interactionData(uri);
    // What the fetch observed is refreshed…
    expect(after.cid).toBe("bafyFRESH");
    // …and what it never fetched survives. outbound-cross-post reads these.
    expect(after.rootUri).toBe("at://did:plc:root/app.bsky.feed.post/root");
    expect(after.rootCid).toBe("bafyROOT");
    expect(after.parentUri).toBe("at://did:plc:parent/app.bsky.feed.post/p");
    expect(after.parentCid).toBe("bafyPARENT");
  });

  it("activitypub: hydration keeps the poll it never fetched", async () => {
    const sourceId = await createSource("activitypub");
    const uri = `https://example.social/users/x/statuses/${uniq()}`;
    const poll = {
      options: [{ title: "yes", votesCount: 3 }],
      multiple: false,
      expiresAt: null,
      closed: false,
    };
    await seedRealRow(sourceId, "activitypub", uri, {
      id: uri,
      activityId: `${uri}/activity`,
      webUrl: "https://example.social/@x/1",
      audience: "https://example.social/users/x/followers",
      poll,
    });

    await persistHydratedThreadNodes(
      sourceId,
      "activitypub",
      [node(uri, { id: uri, webUrl: "https://example.social/@x/1" })],
      { client },
    );

    const after = await interactionData(uri);
    expect(after.poll).toEqual(poll);
    expect(after.audience).toBe("https://example.social/users/x/followers");
    expect(after.activityId).toBe(`${uri}/activity`);
  });

  it("a first hydrate of an unseen post still stores what it fetched", async () => {
    // The control: the merge must not turn the INSERT arm into a no-op, or
    // hydration would write context rows with an empty interaction_data and the
    // thread projector would lose the at:// uri it re-roots on.
    const sourceId = await createSource("atproto");
    const uri = `at://did:plc:${uniq()}/app.bsky.feed.post/new`;
    await persistHydratedThreadNodes(
      sourceId,
      "atproto",
      [node(uri, { uri, cid: "bafyNEW" })],
      { client },
    );
    expect(await interactionData(uri)).toEqual({ uri, cid: "bafyNEW" });
  });

  it("a NULL interaction_data on either side merges to the other, never to NULL", async () => {
    // jsonb || NULL is NULL. The column is nullable, so without the COALESCEs a
    // pre-Phase-0 row with no interaction_data would erase what hydration just
    // learned — the reassuring-absence trap again.
    const sourceId = await createSource("atproto");
    const uri = `at://did:plc:${uniq()}/app.bsky.feed.post/nul`;
    await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri,
         author_name, content_text, published_at, interaction_data, is_context_only
       ) VALUES ($1, 'atproto', 'tier3', $2, 'Real Author', 'body',
                 '2026-01-01T00:00:00Z', NULL, FALSE)`,
      [sourceId, uri],
    );
    await persistHydratedThreadNodes(
      sourceId,
      "atproto",
      [node(uri, { uri, cid: "bafyNEW" })],
      { client },
    );
    expect(await interactionData(uri)).toEqual({ uri, cid: "bafyNEW" });
  });

  it("all five context writers use the ONE merge, not a copy of it", () => {
    // The four route sites are inline in handlers this suite cannot drive, so
    // what is checked there is that they interpolate the constant the two cases
    // above exercised for real. A site that spelled its own expression — which
    // is how all five came to be wrong together — is a text difference here.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      "../shared/src/lib/context-persist.ts",
      "src/routes/external-items/thread.ts",
      "src/routes/external-items/parent.ts",
    ];
    let interpolations = 0;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(here, "..", rel), "utf8");
      interpolations += [
        ...src.matchAll(/\$\{CONTEXT_INTERACTION_MERGE_SQL\}/g),
      ].length;
      // No site may assign the column directly any more.
      expect(src).not.toMatch(/interaction_data = EXCLUDED\.interaction_data/);
    }
    expect(interpolations).toBe(5);
    // And the constant itself is a merge, not an assignment — a rewrite that
    // "simplified" it back would otherwise pass the count above.
    expect(CONTEXT_INTERACTION_MERGE_SQL).toContain("||");
    expect(CONTEXT_INTERACTION_MERGE_SQL).toContain(
      "COALESCE(external_items.interaction_data",
    );
  });
});
