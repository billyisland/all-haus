import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  dedupCtes,
  DEDUP_SUPPRESS_FILTER,
  DEDUP_PROVENANCE_LATERAL,
  dedupApplicableExistsSql,
} from "../src/lib/dedup-sql.js";
import {
  assertIdentityLink,
  unlinkIdentityPair,
} from "../src/lib/identity-link-ops.js";

// =============================================================================
// Slice 8 P1/P2 — cross-source dedup integration test.
//
// Exercises the *real* dedup SQL (lib/dedup-sql.ts — the same constants the live
// feed query in feeds/items.ts splices in) against a live Postgres, seeding
// fixtures inside a transaction that is ALWAYS rolled back, so it never mutates
// the target DB. Covers the matrix the P1/P2 ship notes deferred: winner
// selection across tiers, cross-page (whole-candidate-set) suppression,
// canonical-URL vs text-hash grouping, the zero-link fast path, owner-scoped
// visibility, and the `also_on` provenance lateral.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and FAILS on a skip). Run locally against the dev DB:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/dedup-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// §6.3: the confidence floor is a bound parameter, so every query below states
// the floor it runs under rather than inheriting one. DEFAULT_FLOOR is
// production's seeded value; the floor cases at the foot of the file vary it.
const DEFAULT_FLOOR = 0.9;

// `matched` is the host query's pre-LIMIT candidate set; here we feed it the
// seeded feed_items directly so the dedup CTEs run over exactly our fixtures.
const SUPPRESSED_SQL = `
  WITH RECURSIVE matched AS (
    SELECT id AS fi_id, TRUE AS allow_replies FROM feed_items WHERE id = ANY($2::uuid[])
  ),
  ${dedupCtes(3)}
  SELECT fi_id FROM suppressed
`;

// M11 predicate coverage: same as SUPPRESSED_SQL but with per-row
// allow_replies — $3 lists the fi_ids whose (stub) feed membership disallows
// replies, mirroring the host's `m.allow_replies` join column.
const SUPPRESSED_SQL_REPLY_GATED = `
  WITH RECURSIVE matched AS (
    SELECT id AS fi_id, (id <> ALL($3::uuid[])) AS allow_replies
    FROM feed_items WHERE id = ANY($2::uuid[])
  ),
  ${dedupCtes(4)}
  SELECT fi_id FROM suppressed
`;

// Survivors + their provenance, exercising the real suppress filter + lateral.
const SURVIVORS_SQL = `
  WITH RECURSIVE matched AS (
    SELECT id AS fi_id, TRUE AS allow_replies FROM feed_items WHERE id = ANY($2::uuid[])
  ),
  ${dedupCtes(3)},
  scored AS (
    SELECT fi.id AS fi_id, fi.source_id, ei.dedup_fingerprint AS fp
    FROM feed_items fi
    JOIN matched m ON m.fi_id = fi.id
    JOIN external_items ei ON ei.id = fi.external_item_id
    WHERE TRUE ${DEDUP_SUPPRESS_FILTER}
  )
  SELECT scored.fi_id, prov.also_on
  FROM scored
  ${DEDUP_PROVENANCE_LATERAL}
`;

describe.skipIf(!DB_URL)("dedup integration (Slice 8 P1/P2)", () => {
  let client: pg.Client;
  // Two readers + a pool of fixture ids built per-test, all rolled back.
  let readerA: string;
  let readerB: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    // Owner accounts for owner-scoped link tests. accounts needs only an id +
    // the NOT NULL columns; insert a minimal row and capture the generated id.
    readerA = await insertAccount(client, "dedup-reader-a");
    readerB = await insertAccount(client, "dedup-reader-b");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // --- helpers --------------------------------------------------------------

  /** Insert an external source, returns its id. */
  async function source(protocol: string, uri: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ($1::external_protocol, $2) RETURNING id`,
      [protocol, uri],
    );
    return rows[0].id;
  }

  /**
   * Insert an external_item + its wrapping feed_item. `tier` is the biddability
   * tier (A/B/C/D) that drives the winner rule; `protocol`/`contentTier` satisfy
   * external_items' protocol_tier_consistency CHECK. Supply EITHER canonicalUrl
   * (URL-identity fingerprint) OR contentText (text-hash fingerprint).
   */
  async function item(opts: {
    sourceId: string;
    protocol: string; // external_protocol
    contentTier: string; // content_tier (tier2/tier3/tier4)
    tier: string; // biddability A/B/C/D
    canonicalUrl?: string;
    contentText?: string;
    publishedAt: string; // ISO
    uri: string;
    isContextOnly?: boolean; // M11: hydration context row
    isReply?: boolean; // M11: reply row (visibility rides allow_replies)
  }): Promise<string> {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, canonical_url, content_text, published_at, is_context_only)
       VALUES ($1, $2::external_protocol, $3::content_tier, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        opts.sourceId,
        opts.protocol,
        opts.contentTier,
        opts.uri,
        opts.canonicalUrl ?? null,
        opts.contentText ?? null,
        opts.publishedAt,
        opts.isContextOnly ?? false,
      ],
    );
    const extId = ext.rows[0].id;
    const fi = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at,
          source_protocol, source_id, biddability_tier, post_id, is_reply)
       VALUES ('external', $1, 'fixture', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [extId, opts.publishedAt, opts.protocol, opts.sourceId, opts.tier, opts.uri, opts.isReply ?? false],
    );
    return fi.rows[0].id;
  }

  /** Link two sources; ordering normalised to satisfy the table CHECK. */
  async function link(
    sourceX: string,
    sourceY: string,
    linkType: string,
    ownerId: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, owner_id)
       VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $3, $4)`,
      [sourceX, sourceY, linkType, ownerId],
    );
  }

  async function suppressed(
    reader: string,
    ids: string[],
    floor = DEFAULT_FLOOR,
  ): Promise<Set<string>> {
    const { rows } = await client.query<{ fi_id: string }>(SUPPRESSED_SQL, [
      reader,
      ids,
      floor,
    ]);
    return new Set(rows.map((r) => r.fi_id));
  }

  async function survivors(
    reader: string,
    ids: string[],
  ): Promise<Map<string, string[] | null>> {
    const { rows } = await client.query<{ fi_id: string; also_on: string[] | null }>(
      SURVIVORS_SQL,
      [reader, ids, DEFAULT_FLOOR],
    );
    return new Map(rows.map((r) => [r.fi_id, r.also_on]));
  }

  // --- tests ----------------------------------------------------------------

  it("verifies the fingerprint trigger: canonical URL identity, text-hash floor", async () => {
    const s = await source("rss", "https://fp.example/feed");
    const byUrl = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://fp.example/post/1", uri: "u1",
      publishedAt: "2026-01-01T00:00:00Z",
    });
    const longText = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      contentText: "this is a sufficiently long body to clear the 32 char floor",
      uri: "u2", publishedAt: "2026-01-01T00:00:00Z",
    });
    const shortText = await item({
      sourceId: s, protocol: "rss", contentTier: "tier4", tier: "C",
      contentText: "too short", uri: "u3", publishedAt: "2026-01-01T00:00:00Z",
    });
    const { rows } = await client.query<{ id: string; dedup_fingerprint: string | null }>(
      `SELECT ei.id, ei.dedup_fingerprint
         FROM external_items ei JOIN feed_items fi ON fi.external_item_id = ei.id
        WHERE fi.id = ANY($1::uuid[])`,
      [[byUrl, longText, shortText]],
    );
    const fp = new Map(
      (
        await client.query<{ fi: string; fp: string | null }>(
          `SELECT fi.id AS fi, ei.dedup_fingerprint AS fp
             FROM feed_items fi JOIN external_items ei ON ei.id = fi.external_item_id
            WHERE fi.id = ANY($1::uuid[])`,
          [[byUrl, longText, shortText]],
        )
      ).rows.map((r) => [r.fi, r.fp]),
    );
    expect(fp.get(byUrl)).toBe("https://fp.example/post/1"); // canonical URL wins
    expect(fp.get(longText)?.startsWith("h:")).toBe(true); // text hash
    expect(fp.get(shortText)).toBeNull(); // below the 32-char floor → never deduped
    expect(rows.length).toBe(3);
  });

  it("suppresses the lower biddability tier (A beats C) across linked sources", async () => {
    const sA = await source("atproto", "did:plc:winner");
    const sC = await source("rss", "https://loser.example/feed");
    const url = "https://shared.example/article";
    const winner = await item({
      sourceId: sA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "a1", publishedAt: "2026-02-02T10:00:00Z",
    });
    const loser = await item({
      sourceId: sC, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "c1", publishedAt: "2026-02-01T10:00:00Z",
    });
    await link(sA, sC, "user_asserted", readerA);

    const sup = await suppressed(readerA, [winner, loser]);
    expect(sup.has(loser)).toBe(true);
    expect(sup.has(winner)).toBe(false);

    const surv = await survivors(readerA, [winner, loser]);
    expect(surv.has(winner)).toBe(true);
    expect(surv.has(loser)).toBe(false);
    // Provenance: the survivor advertises the loser's protocol.
    expect(surv.get(winner)).toContain("rss");
  });

  it("M11: a context-only twin never suppresses its visible sibling (double-hide)", async () => {
    // The would-be winner (better tier, earlier) is a hydration context row —
    // the host feed query filters it AFTER dedup, so if it wins here BOTH
    // copies vanish. The candidates predicate (ei.is_context_only IS NOT TRUE)
    // must keep it out of the universe entirely.
    const sA = await source("atproto", "did:plc:ctxwinner");
    const sC = await source("rss", "https://ctxloser.example/feed");
    const url = "https://ctx.example/article";
    const contextTwin = await item({
      sourceId: sA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "ctx-a", publishedAt: "2026-02-01T10:00:00Z",
      isContextOnly: true,
    });
    const visibleTwin = await item({
      sourceId: sC, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ctx-c", publishedAt: "2026-02-02T10:00:00Z",
    });
    await link(sA, sC, "user_asserted", readerA);

    // The context row is not a candidate → nothing suppresses the visible twin.
    const sup = await suppressed(readerA, [contextTwin, visibleTwin]);
    expect(sup.has(visibleTwin)).toBe(false);
    expect(sup.size).toBe(0);

    // Positive control (mutation guard): promote the context row to real and
    // the identical fixture DOES suppress the visible twin — proving the empty
    // set above is the predicate's doing, not a broken fixture.
    await client.query(
      `UPDATE external_items SET is_context_only = FALSE
        WHERE id = (SELECT external_item_id FROM feed_items WHERE id = $1)`,
      [contextTwin],
    );
    const supAfter = await suppressed(readerA, [contextTwin, visibleTwin]);
    expect(supAfter.has(visibleTwin)).toBe(true);
  });

  it("M11: a reply-suppressed twin never suppresses its visible sibling", async () => {
    // Same shape on the other predicate: the would-be winner is a REPLY in a
    // feed whose membership disallows replies (m.allow_replies = FALSE), so the
    // host filters it after dedup. (fi.is_reply IS NOT TRUE OR m.allow_replies)
    // must keep it out of the candidate universe.
    const sA = await source("atproto", "did:plc:replywinner");
    const sC = await source("rss", "https://replyloser.example/feed");
    const url = "https://replygate.example/article";
    const replyTwin = await item({
      sourceId: sA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "rg-a", publishedAt: "2026-02-01T10:00:00Z",
      isReply: true,
    });
    const visibleTwin = await item({
      sourceId: sC, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "rg-c", publishedAt: "2026-02-02T10:00:00Z",
    });
    await link(sA, sC, "user_asserted", readerA);

    const gated = async (disallowed: string[]) => {
      const { rows } = await client.query<{ fi_id: string }>(
        SUPPRESSED_SQL_REPLY_GATED,
        [readerA, [replyTwin, visibleTwin], disallowed, DEFAULT_FLOOR],
      );
      return new Set(rows.map((r) => r.fi_id));
    };

    // Reply twin's feed disallows replies → it is not a candidate → the
    // visible twin survives.
    const sup = await gated([replyTwin]);
    expect(sup.has(visibleTwin)).toBe(false);
    expect(sup.size).toBe(0);

    // Positive control (mutation guard): with replies allowed, the same reply
    // row IS a candidate and suppresses the visible twin.
    const supAllowed = await gated([]);
    expect(supAllowed.has(visibleTwin)).toBe(true);
  });

  it("breaks a same-tier tie by earlier published_at", async () => {
    const s1 = await source("rss", "https://t1.example/feed");
    const s2 = await source("rss", "https://t2.example/feed");
    const url = "https://tie.example/post";
    const earlier = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "e1", publishedAt: "2026-03-01T00:00:00Z",
    });
    const later = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "l1", publishedAt: "2026-03-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [earlier, later]);
    expect(sup.has(later)).toBe(true);
    expect(sup.has(earlier)).toBe(false);
  });

  it("groups by text hash when there is no canonical URL", async () => {
    const s1 = await source("activitypub", "https://m1.example/users/x");
    const s2 = await source("activitypub", "https://m2.example/users/y");
    const body = "a long shared post body that comfortably exceeds the thirty-two character floor";
    const a = await item({
      sourceId: s1, protocol: "activitypub", contentTier: "tier3", tier: "B",
      contentText: body, uri: "h1", publishedAt: "2026-04-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "activitypub", contentTier: "tier3", tier: "B",
      contentText: body, uri: "h2", publishedAt: "2026-04-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(1);
    expect(sup.has(b)).toBe(true); // later published_at loses
  });

  it("does not group distinct content (different fingerprints) even when linked", async () => {
    const s1 = await source("rss", "https://d1.example/feed");
    const s2 = await source("rss", "https://d2.example/feed");
    const a = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://d1.example/post/a", uri: "d1", publishedAt: "2026-05-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: "https://d2.example/post/b", uri: "d2", publishedAt: "2026-05-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);

    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(0); // distinct fingerprints → nothing suppressed
  });

  it("zero-link fast path: identical twins survive when no link joins their sources", async () => {
    const s1 = await source("rss", "https://z1.example/feed");
    const s2 = await source("rss", "https://z2.example/feed");
    const url = "https://nolink.example/post";
    const a = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "z1", publishedAt: "2026-06-01T00:00:00Z",
    });
    const b = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "z2", publishedAt: "2026-06-02T00:00:00Z",
    });
    // No link() call.
    const sup = await suppressed(readerA, [a, b]);
    expect(sup.size).toBe(0);
    const surv = await survivors(readerA, [a, b]);
    expect(surv.size).toBe(2);
    expect(surv.get(a)).toBeNull(); // no also_on without a link
  });

  it("owner-scoped links are private to the asserter; global links apply to all", async () => {
    const s1 = await source("rss", "https://o1.example/feed");
    const s2 = await source("rss", "https://o2.example/feed");
    const url = "https://owned.example/post";
    const early = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "o1", publishedAt: "2026-07-01T00:00:00Z",
    });
    const late = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "o2", publishedAt: "2026-07-02T00:00:00Z",
    });
    // readerA asserts the link; readerB does not.
    await link(s1, s2, "user_asserted", readerA);

    expect((await suppressed(readerA, [early, late])).has(late)).toBe(true);
    // readerB must not inherit readerA's private assertion.
    expect((await suppressed(readerB, [early, late])).size).toBe(0);

    // A global (owner NULL) link applies to readerB too.
    await link(s1, s2, "domain_match", null);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);
  });

  it("P3: a user_unlinked tombstone subtracts a global link for that reader only", async () => {
    const s1 = await source("rss", "https://tomb1.example/feed");
    const s2 = await source("rss", "https://tomb2.example/feed");
    const url = "https://tombstoned.example/post";
    const early = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "tb1", publishedAt: "2026-08-01T00:00:00Z",
    });
    const late = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "tb2", publishedAt: "2026-08-02T00:00:00Z",
    });
    // A global automated link suppresses for everyone.
    await link(s1, s2, "domain_match", null);
    expect((await suppressed(readerA, [early, late])).has(late)).toBe(true);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);

    // readerA tombstones the pair (unlinks the detected link). The override is
    // owner-scoped: readerA stops deduping it, readerB is unaffected.
    await link(s1, s2, "user_unlinked", readerA);
    expect((await suppressed(readerA, [early, late])).size).toBe(0);
    expect((await suppressed(readerA, [early, late])).has(late)).toBe(false);
    expect((await suppressed(readerB, [early, late])).has(late)).toBe(true);

    // And the survivor's also_on drops for readerA too (no applicable link).
    const survA = await survivors(readerA, [early, late]);
    expect(survA.get(early)).toBeNull();
    expect(survA.get(late)).toBeNull();
  });

  it("transitive chain (s1–s2, s2–s3, no s1–s3): collapses to one survivor", async () => {
    // The same article cross-posted to three sources the reader has linked as a
    // CHAIN, not a clique: s1–s2 and s2–s3, but never s1–s3. Pairwise suppression
    // leaks here — if the connecting node s2 is the loser it gets suppressed by
    // both ends, leaving s1 and s3 (same fingerprint, not directly linked) BOTH
    // surviving. Connectivity must be transitive: one component → one survivor.
    const s1 = await source("rss", "https://chain1.example/feed");
    const s2 = await source("rss", "https://chain2.example/feed");
    const s3 = await source("rss", "https://chain3.example/feed");
    const url = "https://chain.example/article";
    // s1 earliest (the rightful winner), s3 middle, s2 latest (the loser that
    // would be suppressed by both — the articulation point of the chain).
    const i1 = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch1", publishedAt: "2026-09-01T00:00:00Z",
    });
    const i2 = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch2", publishedAt: "2026-09-03T00:00:00Z",
    });
    const i3 = await item({
      sourceId: s3, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "ch3", publishedAt: "2026-09-02T00:00:00Z",
    });
    await link(s1, s2, "user_asserted", readerA);
    await link(s2, s3, "user_asserted", readerA);
    // no s1–s3 link

    const sup = await suppressed(readerA, [i1, i2, i3]);
    // Exactly one survivor — the earliest (s1) — and the other two suppressed.
    expect(sup.has(i2)).toBe(true);
    expect(sup.has(i3)).toBe(true);
    expect(sup.has(i1)).toBe(false);

    const surv = await survivors(readerA, [i1, i2, i3]);
    expect(surv.size).toBe(1);
    expect(surv.has(i1)).toBe(true);
  });

  it("star (centre linked to two leaves, leaves not linked): one survivor", async () => {
    // The same content on three sources linked as a STAR: a central source linked
    // to two leaves, but the leaves never linked to each other (the bridge shape —
    // a native mirrored to two bridges, each bridge linked to the native, not to
    // the other bridge). When the CENTRE is the loser it gets suppressed by both
    // leaves, and the two leaves — same fingerprint, not directly linked — both
    // leak under pairwise suppression. So the centre must rank worst: biddability
    // tier is derived from protocol by a trigger (rss→C, atproto/nostr→A), so the
    // rss centre (C) loses to its two tier-A leaves. Transitive connectivity
    // collapses the star to one survivor.
    const centre = await source("rss", "https://star-centre.example/feed");
    const leafA = await source("atproto", "did:plc:starleafa");
    const leafB = await source("nostr_external", "npub1starleafb");
    const url = "https://star.example/post";
    // leafA earliest → the rightful winner among the two tier-A leaves.
    const iLeafA = await item({
      sourceId: leafA, protocol: "atproto", contentTier: "tier3", tier: "A",
      canonicalUrl: url, uri: "st-a", publishedAt: "2026-10-01T00:00:00Z",
    });
    const iLeafB = await item({
      sourceId: leafB, protocol: "nostr_external", contentTier: "tier2", tier: "A",
      canonicalUrl: url, uri: "st-b", publishedAt: "2026-10-02T00:00:00Z",
    });
    const iCentre = await item({
      sourceId: centre, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: "st-c", publishedAt: "2026-10-03T00:00:00Z",
    });
    await link(centre, leafA, "bridge", null);
    await link(centre, leafB, "bridge", null);
    // no leafA–leafB link — under pairwise suppression both leaves leak.

    const sup = await suppressed(readerA, [iLeafA, iLeafB, iCentre]);
    expect(sup.size).toBe(2); // exactly one survives
    expect(sup.has(iCentre)).toBe(true); // worst tier — suppressed
    expect(sup.has(iLeafB)).toBe(true); // the non-winning leaf — would leak under pairwise
    expect(sup.has(iLeafA)).toBe(false); // earliest tier-A leaf wins

    const surv = await survivors(readerA, [iLeafA, iLeafB, iCentre]);
    expect(surv.size).toBe(1);
    expect(surv.has(iLeafA)).toBe(true);
    // The lone survivor advertises both other networks via the component.
    expect(surv.get(iLeafA)).toEqual(
      expect.arrayContaining(["rss", "nostr_external"]),
    );
  });

  // --- unlink / re-link convergence (identity-link-ops) ---------------------
  // Order a pair the way the table stores it (source_a_id < source_b_id) so
  // unlinkIdentityPair's equality lookups hit.
  function orderedPair(x: string, y: string): [string, string] {
    return x < y ? [x, y] : [y, x];
  }

  /** Seed two sources + one duplicate item each (same canonical URL). */
  async function dupPair(prefix: string): Promise<{
    s1: string; s2: string; winner: string; loser: string;
  }> {
    const s1 = await source("rss", `https://${prefix}1.example/feed`);
    const s2 = await source("rss", `https://${prefix}2.example/feed`);
    const url = `https://${prefix}.example/post`;
    const winner = await item({
      sourceId: s1, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: `${prefix}-w`, publishedAt: "2026-11-01T00:00:00Z",
    });
    const loser = await item({
      sourceId: s2, protocol: "rss", contentTier: "tier4", tier: "C",
      canonicalUrl: url, uri: `${prefix}-l`, publishedAt: "2026-11-02T00:00:00Z",
    });
    return { s1, s2, winner, loser };
  }

  it("unlink converges to not-merged even when the viewer ALSO asserted a globally-detected pair", async () => {
    // The confusing no-op: a pair carries BOTH a global detected link and the
    // viewer's own assertion. The surface shows one "own-first" chip, so the old
    // route deleted the assertion (global kept merging) or skipped the tombstone
    // to spare the assertion (assertion kept merging) — "Stop merging" did nothing.
    const { s1, s2, winner, loser } = await dupPair("conflict");
    await link(s1, s2, "domain_match", null); // global detected
    await link(s1, s2, "user_asserted", readerA); // the viewer also asserted it
    const [a, b] = orderedPair(s1, s2);

    // Both ways into applicable_links → the loser is suppressed (merged).
    expect((await suppressed(readerA, [winner, loser])).has(loser)).toBe(true);

    // "Stop merging this source."
    await unlinkIdentityPair(client, a, b, readerA);

    // It actually stops merging now — and only for this viewer.
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);
    expect((await suppressed(readerB, [winner, loser])).has(loser)).toBe(true);
  });

  it("unlink of a purely user-asserted pair hard-deletes the assertion (no global)", async () => {
    const { s1, s2, winner, loser } = await dupPair("ownonly");
    const linkId = await assertIdentityLink(client, s1, s2, readerA);
    expect(linkId).toBeTruthy();
    const [a, b] = orderedPair(s1, s2);
    expect((await suppressed(readerA, [winner, loser])).has(loser)).toBe(true);

    await unlinkIdentityPair(client, a, b, readerA);

    // Not merged, and the row is gone — no stray tombstone left behind.
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);
    const { rows } = await client.query(
      `SELECT 1 FROM external_identity_links
        WHERE source_a_id = $1 AND source_b_id = $2 AND owner_id = $3`,
      [a, b, readerA],
    );
    expect(rows.length).toBe(0);
  });

  // --- §6.6 the applicability probe -----------------------------------------
  //
  // The probe decides whether the live feed query is built WITH the dedup block
  // at all, so its failure mode is not a slow page but a SILENT one: answer
  // false while a link applies and content suppression is switched off for that
  // reader with nothing to say so. These cases pin the one direction that
  // matters — the probe is a SUPERSET of `applicable_links`, never a subset.
  async function probe(reader: string, floor = DEFAULT_FLOOR): Promise<boolean> {
    const { rows } = await client.query<{ has_links: boolean }>(
      `SELECT ${dedupApplicableExistsSql(2)} AS has_links`,
      [reader, floor],
    );
    return rows[0].has_links;
  }

  it("probe: false with no links, true for a global link (every reader)", async () => {
    const s1 = await source("rss", "https://probe1.example/feed");
    const s2 = await source("atproto", "did:plc:probe1");
    expect(await probe(readerA)).toBe(false);

    await link(s1, s2, "domain_match", null);
    // A global link applies to everyone — a probe keyed on `owner_id = $1`
    // alone would answer false here and silently un-dedup the whole platform.
    expect(await probe(readerA)).toBe(true);
    expect(await probe(readerB)).toBe(true);
  });

  it("probe: an assertion is visible to its owner and to nobody else", async () => {
    const s1 = await source("rss", "https://probe2.example/feed");
    const s2 = await source("atproto", "did:plc:probe2");
    await assertIdentityLink(client, s1, s2, readerA);

    expect(await probe(readerA)).toBe(true);
    expect(await probe(readerB)).toBe(false);
  });

  it("probe: a reader holding only a tombstone has nothing to dedup", async () => {
    const s1 = await source("rss", "https://probe3.example/feed");
    const s2 = await source("atproto", "did:plc:probe3");
    const [a, b] = orderedPair(s1, s2);
    // A tombstone is a negative override: it suppresses nothing by itself, so
    // `link_type <> 'user_unlinked'` is load-bearing, not slack.
    await link(a, b, "user_unlinked", readerA);
    expect(await probe(readerA)).toBe(false);
  });

  it("probe: OVER-approximates on a fully tombstoned link, and that is the safe direction", async () => {
    const { s1, s2, winner, loser } = await dupPair("probeover");
    await link(s1, s2, "domain_match", null);
    const [a, b] = orderedPair(s1, s2);
    await unlinkIdentityPair(client, a, b, readerA);

    // `applicable_links` is now empty for readerA — dedup suppresses nothing…
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);
    // …and the probe still says true, so the reader pays for one correct,
    // useless dedup pass. Deliberate: the probe omits the tombstone NOT EXISTS,
    // so it can only ever cost a plan, never hide a merge that should happen.
    expect(await probe(readerA)).toBe(true);
  });

  // --- §6.1 + §6.3 the confidence floor -------------------------------------
  //
  // The floor is the whole of the answer to "domain_match auto-merges distinct
  // people sharing a website". These cases are about SUPPRESSION, not about the
  // detector: a 0.6 link keeps being recorded and keeps being readable, it just
  // stops hiding a post. Every other test in this file runs at DEFAULT_FLOOR
  // with confidence-1.0 fixtures, so they pin the admit side by construction.

  /** Link a pair at a stated confidence (the helper above takes the 1.0 default). */
  async function linkAt(
    sourceX: string,
    sourceY: string,
    linkType: string,
    confidence: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO external_identity_links
         (source_a_id, source_b_id, link_type, confidence, owner_id)
       VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $3, $4, NULL)`,
      [sourceX, sourceY, linkType, confidence],
    );
  }

  it("a 0.6 domain_match hides nothing at the default floor", async () => {
    const { s1, s2, winner, loser } = await dupPair("floor06");
    await linkAt(s1, s2, "domain_match", 0.6);

    // Two accounts posting the same headline is ordinary; a shared web host is
    // not evidence they are the same person. Nothing is suppressed, and the
    // probe agrees so the reader does not even pay for the plan.
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);
    expect(await probe(readerA)).toBe(false);
  });

  it("the same 0.6 link DOES merge once an operator lowers the floor", async () => {
    const { s1, s2, winner, loser } = await dupPair("floor06on");
    await linkAt(s1, s2, "domain_match", 0.6);

    // The detector's output is not discarded — it is held back. Retuning is an
    // UPDATE, per the tuning-dial rule, and this is what that UPDATE buys.
    expect((await suppressed(readerA, [winner, loser], 0.5)).has(loser)).toBe(true);
    expect(await probe(readerA, 0.5)).toBe(true);
  });

  it("a 0.95 bridge link merges at the default floor", async () => {
    const { s1, s2, winner, loser } = await dupPair("floor095");
    await linkAt(s1, s2, "bridge", 0.95);

    // A bridge mirror EMBEDS the original identity, so the link is a decode
    // rather than a guess — the one automated signal the floor admits.
    expect((await suppressed(readerA, [winner, loser])).has(loser)).toBe(true);
  });

  it("the floor is a bound, not a link-type list: a downgraded bridge stops merging", async () => {
    const { s1, s2, winner, loser } = await dupPair("floordown");
    // Confidence is the discriminator, never the type name — so a detector that
    // later emits a less certain bridge is held back without a code change.
    await linkAt(s1, s2, "bridge", 0.7);
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);
  });

  it("re-link after an unlink restores the merge (assert overrides a tombstone)", async () => {
    const { s1, s2, winner, loser } = await dupPair("relink");
    await link(s1, s2, "domain_match", null); // global keeps the pair detectable
    const [a, b] = orderedPair(s1, s2);

    // Unlink the detected pair → tombstone → not merged for the viewer.
    await unlinkIdentityPair(client, a, b, readerA);
    expect((await suppressed(readerA, [winner, loser])).size).toBe(0);

    // "Link to…" again must actually re-link (flip the slot off user_unlinked),
    // not silently stay tombstoned.
    await assertIdentityLink(client, s1, s2, readerA);
    expect((await suppressed(readerA, [winner, loser])).has(loser)).toBe(true);
  });
});

async function insertAccount(client: pg.Client, slug: string): Promise<string> {
  // accounts requires a unique nostr_pubkey; generate a unique-ish placeholder.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
     VALUES ($1, $2) RETURNING id`,
    [`fixture-${slug}-${randHex()}`, "fixture-enc"],
  );
  return rows[0].id;
}

function randHex(): string {
  // Avoid Math.random reliance for determinism concerns; time-based is fine for
  // a rolled-back fixture handle that only needs intra-test uniqueness.
  return process.hrtime.bigint().toString(16);
}
