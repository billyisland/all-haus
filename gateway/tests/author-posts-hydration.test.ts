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
import { ensureShadowSource } from "../src/lib/author-timeline-hydration.js";
import { persistHydratedThreadNodes } from "../src/lib/external-hydration.js";
import { AUTHOR_POSTS_CONTEXT_FILTER } from "../src/routes/author.js";

// =============================================================================
// EXTERNAL-AUTHOR-HISTORY-ADR §3.2/§3.3/§3.4 — the DB half of profile-view
// hydration, against a live Postgres with rolled-back fixtures (the
// dedup-integration pattern; skipped without a DB URL):
//
//   • the /posts filter matrix over the four (is_context_only,
//     is_profile_hydrated) combinations;
//   • the shadow-source two-step upsert (fresh insert / existing active
//     source untouched / existing shadow reused);
//   • persistHydratedThreadNodes' OR-fold (thread hydration never flips the
//     flag; profile hydration graduates an existing context row; hydration
//     never demotes a real row);
//   • §6.2 — hydrated rows keyed to one external_authors row don't leak into
//     a linked twin's /posts (the query doesn't dedup).
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/author-posts-hydration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const POSTS_SQL = `
  SELECT fi.id
    FROM feed_items fi
    JOIN external_items ei ON ei.id = fi.external_item_id
   WHERE fi.deleted_at IS NULL
     AND fi.external_author_id = $1
     AND ${AUTHOR_POSTS_CONTEXT_FILTER}
`;

describe.skipIf(!DB_URL)("author /posts hydration substrate", () => {
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
    sourceUri: string,
    opts: { active?: boolean } = {},
  ): Promise<string> {
    const { rows } = await client.query(
      `INSERT INTO external_sources (protocol, source_uri, is_active)
       VALUES ('nostr_external', $1, $2) RETURNING id`,
      [sourceUri, opts.active ?? true],
    );
    return rows[0].id;
  }

  // Insert a nostr item pair; the feed_items identity trigger mints the
  // external_authors row (keyed on the pubkey) and stamps external_author_id.
  let uriSeq = 0;
  async function insertItem(opts: {
    sourceId: string;
    pubkey: string;
    contextOnly: boolean;
    profileHydrated: boolean;
  }): Promise<{ feedItemId: string; externalAuthorId: string }> {
    uriSeq++;
    const uri = `nevent1test${uriSeq.toString().padStart(6, "0")}`;
    const ins = await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, author_name,
         content_text, published_at, interaction_data,
         is_context_only, is_profile_hydrated
       ) VALUES ($1, 'nostr_external', 'tier2', $2, 'Author', 'body',
                 now() - ($3 || ' minutes')::interval, $4, $5, $6)
       RETURNING id`,
      [
        opts.sourceId,
        uri,
        String(uriSeq),
        JSON.stringify({ id: "e".repeat(64), pubkey: opts.pubkey, relays: [] }),
        opts.contextOnly,
        opts.profileHydrated,
      ],
    );
    const fi = await client.query(
      `INSERT INTO feed_items (
         item_type, external_item_id, author_name, content_preview,
         published_at, source_protocol, source_item_uri, source_id, media, is_reply
       ) VALUES ('external', $1, 'Author', 'body',
                 now(), 'nostr_external', $2, $3, '[]'::jsonb, FALSE)
       RETURNING id, external_author_id`,
      [ins.rows[0].id, uri, opts.sourceId],
    );
    return {
      feedItemId: fi.rows[0].id,
      externalAuthorId: fi.rows[0].external_author_id,
    };
  }

  it("filter matrix: real + profile-hydrated + promoted rows in, pure context rows out", async () => {
    const pubkey = "1".repeat(64);
    const sourceId = await createSource(pubkey);

    // (F,F) real / promoted; (T,F) pure thread context; (T,T) profile-hydrated;
    // (F,T) real row that picked up the flag.
    const real = await insertItem({ sourceId, pubkey, contextOnly: false, profileHydrated: false });
    const context = await insertItem({ sourceId, pubkey, contextOnly: true, profileHydrated: false });
    const profileHydrated = await insertItem({ sourceId, pubkey, contextOnly: true, profileHydrated: true });
    const realFlagged = await insertItem({ sourceId, pubkey, contextOnly: false, profileHydrated: true });

    expect(real.externalAuthorId).toBe(context.externalAuthorId); // same author

    const { rows } = await client.query(POSTS_SQL, [real.externalAuthorId]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(real.feedItemId);
    expect(ids).toContain(profileHydrated.feedItemId);
    expect(ids).toContain(realFlagged.feedItemId);
    expect(ids).not.toContain(context.feedItemId);
    expect(ids).toHaveLength(3);
  });

  it("shadow source: fresh insert is inactive; existing rows are reused untouched", async () => {
    const pubkey = "2".repeat(64);

    // Fresh insert → is_active FALSE, no external_subscriptions row.
    const shadow = await ensureShadowSource("nostr_external", pubkey, client);
    expect(shadow).not.toBeNull();
    const { rows: fresh } = await client.query(
      `SELECT is_active FROM external_sources WHERE id = $1`,
      [shadow!.id],
    );
    expect(fresh[0].is_active).toBe(false);
    const { rows: subs } = await client.query(
      `SELECT 1 FROM external_subscriptions WHERE source_id = $1`,
      [shadow!.id],
    );
    expect(subs).toHaveLength(0);

    // Existing shadow → same row reused, still inactive.
    const again = await ensureShadowSource("nostr_external", pubkey, client);
    expect(again!.id).toBe(shadow!.id);

    // Existing ACTIVE (really subscribed) source → reused and NOT flipped.
    const activePubkey = "3".repeat(64);
    const activeId = await createSource(activePubkey, { active: true });
    const reused = await ensureShadowSource("nostr_external", activePubkey, client);
    expect(reused!.id).toBe(activeId);
    const { rows: still } = await client.query(
      `SELECT is_active FROM external_sources WHERE id = $1`,
      [activeId],
    );
    expect(still[0].is_active).toBe(true);
  });

  const node = (uri: string, pubkey: string) => ({
    sourceItemUri: uri,
    sourceReplyUri: null,
    sourceQuoteUri: null,
    authorName: "Author",
    authorHandle: null,
    authorAvatarUrl: null,
    authorUri: null,
    contentText: "hydrated body",
    contentHtml: null,
    media: [],
    interactionData: { id: "e".repeat(64), pubkey, relays: [] },
    likeCount: 0,
    replyCount: 0,
    repostCount: 0,
    publishedAt: new Date("2026-06-01T00:00:00Z"),
  });

  async function flagsOf(uri: string) {
    const { rows } = await client.query(
      `SELECT is_context_only, is_profile_hydrated
         FROM external_items WHERE source_item_uri = $1`,
      [uri],
    );
    return rows[0];
  }

  it("OR-fold: profile write graduates a context row; thread write never flips the flag; no demotion of real rows", async () => {
    const pubkey = "4".repeat(64);
    const sourceId = await createSource(pubkey);

    // Thread hydration first (profileHydrated absent) → flag FALSE.
    const uri = "nevent1orfold000001";
    await persistHydratedThreadNodes(sourceId, "nostr_external", [node(uri, pubkey)], {
      client,
    });
    expect(await flagsOf(uri)).toEqual({
      is_context_only: true,
      is_profile_hydrated: false,
    });

    // Profile hydration onto the SAME row → graduates into the profile view.
    await persistHydratedThreadNodes(sourceId, "nostr_external", [node(uri, pubkey)], {
      client,
      profileHydrated: true,
    });
    expect(await flagsOf(uri)).toEqual({
      is_context_only: true,
      is_profile_hydrated: true,
    });

    // A later thread hydration (EXCLUDED = FALSE) never un-graduates it.
    await persistHydratedThreadNodes(sourceId, "nostr_external", [node(uri, pubkey)], {
      client,
    });
    expect(await flagsOf(uri)).toEqual({
      is_context_only: true,
      is_profile_hydrated: true,
    });

    // Hydration onto a REAL row never demotes it to context.
    const realUri = "nevent1orfold000002";
    await client.query(
      `INSERT INTO external_items (
         source_id, protocol, tier, source_item_uri, author_name, content_text,
         published_at, interaction_data, is_context_only, is_profile_hydrated
       ) VALUES ($1, 'nostr_external', 'tier2', $2, 'Author', 'real body',
                 now(), $3, FALSE, FALSE)`,
      [sourceId, realUri, JSON.stringify({ id: "f".repeat(64), pubkey, relays: [] })],
    );
    await persistHydratedThreadNodes(sourceId, "nostr_external", [node(realUri, pubkey)], {
      client,
      profileHydrated: true,
    });
    const real = await flagsOf(realUri);
    expect(real.is_context_only).toBe(false); // never demoted
  });

  it("§6.2 bridged authors: hydrated rows keyed to one external_authors row don't leak into a linked twin's /posts", async () => {
    const pubkeyA = "5".repeat(64);
    const pubkeyB = "6".repeat(64);
    const sourceA = await createSource(pubkeyA);
    const sourceB = await createSource(pubkeyB);

    const a = await insertItem({ sourceId: sourceA, pubkey: pubkeyA, contextOnly: true, profileHydrated: true });
    const b = await insertItem({ sourceId: sourceB, pubkey: pubkeyB, contextOnly: false, profileHydrated: false });
    expect(a.externalAuthorId).not.toBe(b.externalAuthorId);

    // Cross-source identity link between the two sources (Slice 8) — /posts
    // must ignore it entirely (dedup is feed-read-time only).
    await client.query(
      `INSERT INTO external_identity_links (source_a_id, source_b_id, link_type)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'user_asserted')`,
      [sourceA, sourceB],
    );

    const forA = await client.query(POSTS_SQL, [a.externalAuthorId]);
    const forB = await client.query(POSTS_SQL, [b.externalAuthorId]);
    expect(forA.rows.map((r) => r.id)).toEqual([a.feedItemId]);
    expect(forB.rows.map((r) => r.id)).toEqual([b.feedItemId]);
  });
});
