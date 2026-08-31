import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// The default seed — what a brand-new account receives (FEED-FORMULAS-ADR D6/
// D11, Phase 2), and the admin act that decides it.
//
// DB-BACKED, and not by preference. What must hold spans feed_formulas →
// feeds → feed_sources → external_subscriptions, and three of the guarantees
// are Postgres's own: the partial unique index that caps designation at one,
// the CHECK that forbids revoking a designated row, and the BEFORE DELETE
// trigger that turns the author-account CASCADE into a refused delete. A
// mocked pool.query would answer "is exactly one row designated?" from the
// mock's idea of a unique index.
//
// THIS FILE MUTATES GLOBAL STATE — designation is a single platform-wide slot,
// so the suite parks any incumbent in beforeAll and puts it back in afterAll.
// Cleanup order matters: undesignate BEFORE deleting the fixture accounts, or
// the D11 trigger refuses the CASCADE and the fixtures survive the run.
//
// Run locally (both vars: the fixtures use their own client, the code under
// test uses the shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/feed-seed-formula.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

// Who requireAdmin says is calling. A fixture account minted at run time, so
// the mock reads it rather than closing over a literal.
let adminId = "unset";
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: adminId };
    done();
  },
  getAdminIds: () => Promise.resolve([adminId]),
}));

const { seedStarterFeeds } = await import("../src/routes/feeds/crud.js");
const { listFeedsForOwner } = await import("../src/routes/feeds/crud.js");
const { redeemFormulaForOwner } = await import(
  "../src/routes/feeds/formulas.js"
);
const { adminDashboardRoutes } = await import(
  "../src/routes/admin-dashboard.js"
);

describe.skipIf(!DB_URL)("the default seed", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  const cleanupSources: string[] = [];
  /** The incumbent designation, parked for the length of the run. */
  let parked: string | null = null;

  async function build() {
    const a = Fastify({ logger: false });
    await a.register(adminDashboardRoutes);
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `UPDATE feed_formulas SET is_default_seed = FALSE
        WHERE is_default_seed RETURNING id`,
    );
    parked = rows[0]?.id ?? null;
    const admin = await account("seed-admin");
    adminId = admin.id;
    app = await build();
  });

  afterAll(async () => {
    // Undesignate FIRST — a designated formula cannot be deleted, and it
    // cascades from its author, so leaving one designated turns the account
    // cleanup below into a refused delete.
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(
        `DELETE FROM external_sources WHERE id = ANY($1::uuid[])`,
        [cleanupSources],
      );
    if (parked)
      await client.query(
        `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
        [parked],
      );
    await app?.close();
    await client.end();
  });

  async function account(slug: string): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', $2) RETURNING id`,
      [pubkey, `Fixture ${slug}`],
    );
    cleanupAccounts.push(rows[0].id);
    return { id: rows[0].id, pubkey };
  }

  /** A source addSource's known-healthy short-circuit will not probe. */
  async function healthyRssSource(): Promise<{ id: string; uri: string }> {
    const uri = `https://fixture.example/${uniq()}.xml`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources
         (protocol, source_uri, display_name, is_active, error_count, last_fetched_at)
       VALUES ('rss', $1, 'Fixture RSS', TRUE, 0, now()) RETURNING id`,
      [uri],
    );
    cleanupSources.push(rows[0].id);
    return { id: rows[0].id, uri };
  }

  /** A formula holding one account source and one healthy RSS source. */
  async function formula(
    authorId: string,
    opts: { designate?: boolean; name?: string } = {},
  ): Promise<{ id: string; followeeId: string; sourceId: string }> {
    const followee = await account(`seed-followee-${uniq()}`);
    const rss = await healthyRssSource();
    // kind = 'seed' explicitly: feed_formulas_snapshot_iff_seed refuses a row
    // carrying a name and counts on the 'link' default, which is the whole
    // point of the discriminator (FEED-SHARE-LIVE-LINKS-ADR L4).
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, 'seed', $2, '{"scheme":"autumn"}'::jsonb, $3, 2, 0) RETURNING id`,
      [authorId, opts.name ?? "House Starter", `tok-${uniq()}`],
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account')`,
      [id, followee.pubkey],
    );
    await client.query(
      `INSERT INTO feed_formula_sources
         (formula_id, position, tag_kind, tag_value, source_type, protocol)
       VALUES ($1, 1, 'r', $2, 'external_source', 'rss')`,
      [id, rss.uri],
    );
    if (opts.designate)
      await client.query(
        `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
        [id],
      );
    return { id, followeeId: followee.id, sourceId: rss.id };
  }

  /**
   * A legacy clone: the shape `cloneFeedForOwner` used to mint, built by hand
   * because the function retired with `feeds.is_starter_template` in migration
   * 179. Nothing writes `cloned_from_feed_id` any more — but the rows already
   * carrying it are the only provenance members seeded before the cutover have,
   * so the arm of feedProvenanceSql that reads it is still live and still needs
   * holding. Returns [templateId, cloneId].
   */
  async function legacyClone(ownerId: string, memberId: string) {
    const { rows: tmpl } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank)
       VALUES ($1, 'Legacy Template', 1) RETURNING id`,
      [ownerId],
    );
    const { rows: clone } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, cloned_from_feed_id)
       VALUES ($1, 'Legacy Template', 1, $2) RETURNING id`,
      [memberId, tmpl[0].id],
    );
    return { templateId: tmpl[0].id, cloneId: clone[0].id };
  }

  async function undesignateAll() {
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = FALSE WHERE is_default_seed`,
    );
  }

  // ---------------------------------------------------------------------------
  // Seeding
  // ---------------------------------------------------------------------------

  it("seeds a new account from the designated formula, with the brake OFF", async () => {
    // The brake is the point of this assertion, not scenery (§6). The seed
    // path and the share path share a mechanism and must NOT share a flag:
    // gating this on FEED_FORMULAS_ENABLED would mean turning the flag off
    // silently ends new-account seeding — the §0l outage from the other side.
    const previousFlag = process.env.FEED_FORMULAS_ENABLED;
    delete process.env.FEED_FORMULAS_ENABLED;
    try {
      await undesignateAll();
      const author = await account("seed-author");
      const seed = await formula(author.id, { designate: true });
      const member = await account("seed-member");

      expect(await seedStarterFeeds(member.id)).toBe(1);

      const { rows: feeds } = await client.query<{
        id: string;
        from_formula_id: string | null;
        appearance: Record<string, unknown>;
      }>(`SELECT id, from_formula_id, appearance FROM feeds WHERE owner_id = $1`, [
        member.id,
      ]);
      expect(feeds).toHaveLength(1);
      expect(feeds[0].from_formula_id).toBe(seed.id);
      // The composition arrives styled (§5) and whole.
      expect(feeds[0].appearance).toEqual({ scheme: "autumn" });
      const { rows: sources } = await client.query(
        `SELECT source_type FROM feed_sources WHERE feed_id = $1 ORDER BY source_type`,
        [feeds[0].id],
      );
      expect(sources.map((r: any) => r.source_type)).toEqual([
        "account",
        "external_source",
      ]);
      // THE property redemption exists to keep: the member holds their own
      // subscription, so the GC's global orphan test cannot cull the source
      // out from under them the day the author lets go of it.
      const { rows: subs } = await client.query(
        `SELECT 1 FROM external_subscriptions WHERE subscriber_id = $1 AND source_id = $2`,
        [member.id, seed.sourceId],
      );
      expect(subs).toHaveLength(1);
    } finally {
      if (previousFlag === undefined) delete process.env.FEED_FORMULAS_ENABLED;
      else process.env.FEED_FORMULAS_ENABLED = previousFlag;
    }
  });

  it("seeds nothing at all when nothing is designated", async () => {
    // With the flagged-template fallback dropped (migration 179) the designated
    // formula is the ONLY seed path, so this is the whole of what an
    // undesignated database does. It is a legal state, not a fault — a fresh
    // database sits here until the operator designates one — and the member
    // lands on the client's empty-default-feed mint. The assertion that matters
    // is that it stays silent and writes nothing, rather than half-seeding.
    await undesignateAll();
    const member = await account("undesignated-member");

    expect(await seedStarterFeeds(member.id)).toBe(0);
    const { rows } = await client.query(
      `SELECT id FROM feeds WHERE owner_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("is a no-op for an owner who already has a feed", async () => {
    await undesignateAll();
    const author = await account("idem-author");
    await formula(author.id, { designate: true });
    const member = await account("idem-member");

    expect(await seedStarterFeeds(member.id)).toBe(1);
    expect(await seedStarterFeeds(member.id)).toBe(0);
    const { rows } = await client.query(
      `SELECT id FROM feeds WHERE owner_id = $1`,
      [member.id],
    );
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Provenance — from_starter and origin are now DIFFERENT questions
  // ---------------------------------------------------------------------------

  it("reads a seeded feed as from_starter, with no origin attribution", async () => {
    await undesignateAll();
    const author = await account("prov-author");
    await formula(author.id, { designate: true });
    const member = await account("prov-member");
    await seedStarterFeeds(member.id);

    const feeds = await listFeedsForOwner(member.id);
    expect(feeds).toHaveLength(1);
    expect(feeds[0].from_starter).toBe(true);
    // NOT "from Fixture prov-author's House Starter". The seed is the
    // platform's, and answering both questions would put an author's name on
    // every new member's first feed as though they had chosen it.
    expect(feeds[0].origin_formula_name).toBeNull();
    expect(feeds[0].origin_author_name).toBeNull();
  });

  it("reads a redeemed share LINK as origin, and NOT as from_starter", async () => {
    // The two provenance questions stay disjoint, and both now key on `kind`
    // rather than on the designation flag (L9): "the platform set this up for
    // you" and "you added somebody's link" are different facts about the
    // member's own feed.
    await undesignateAll();
    const author = await account("share-author");
    const followee = await account("share-followee");
    const { rows: srcFeed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'Long Reads', 1) RETURNING id`,
      [author.id],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
      [srcFeed[0].id, followee.id],
    );
    const { rows: link } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas (author_id, source_feed_id, token) VALUES ($1, $2, $3) RETURNING id`,
      [author.id, srcFeed[0].id, `tok-${uniq()}`],
    );

    const member = await account("share-member");
    await redeemFormulaForOwner(link[0].id, member.id);

    const feeds = await listFeedsForOwner(member.id);
    const redeemed = feeds.find((f) => f.origin_formula_name !== null);
    expect(redeemed?.origin_formula_name).toBe("Long Reads");
    expect(redeemed?.origin_author_name).toContain("share-author");
    expect(redeemed?.from_starter).toBe(false);
  });

  it("still reads a pre-cutover clone as from_starter, with the flag gone", async () => {
    // The legacy arm outlives the flag ON PURPOSE. `from_starter` was
    // re-derived off `cloned_from_feed_id` in Phase 2 step 1 precisely so that
    // dropping `is_starter_template` needed no further edit — the old spelling
    // was EXISTS(… AND t.is_starter_template), under which the drop would have
    // silently unmade the provenance of every member seeded before the cutover.
    // What a member's feed came from is a fact about their feed.
    await undesignateAll();
    const operator = await account("legacy-operator");
    const member = await account("legacy-member");
    const { templateId } = await legacyClone(operator.id, member.id);

    expect((await listFeedsForOwner(member.id))[0].from_starter).toBe(true);

    // DELETING the template is a different matter, and no SQL spelling can save
    // it: feeds_cloned_from_feed_id_fkey is ON DELETE SET NULL, so the column
    // that holds the provenance is cleared by the delete itself. Pinned as the
    // known limit of the legacy arm — and as the sharpest argument for D6,
    // since a formula has no `feeds` row for anyone to delete.
    await client.query(`DELETE FROM feeds WHERE id = $1`, [templateId]);
    expect((await listFeedsForOwner(member.id))[0].from_starter).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Designation — the admin surface that replaced the hand-run UPDATE
  // ---------------------------------------------------------------------------

  async function designatedId(): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_formulas WHERE is_default_seed`,
    );
    // Length is asserted, not assumed: "exactly one" is the guarantee.
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0]?.id ?? null;
  }

  /** One of the admin's own feeds, holding one account source. */
  async function adminFeed(name: string): Promise<string> {
    const followee = await account(`cut-followee-${uniq()}`);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, $2, 9, '{"scheme":"winter"}'::jsonb) RETURNING id`,
      [adminId, name],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
      [rows[0].id, followee.id],
    );
    return rows[0].id;
  }

  it("swaps the designation rather than adding a second one, and revokes the outgoing seed", async () => {
    // L5 — the outgoing row is revoked in the same transaction, legal the
    // instant it is undesignated. It is NOT deleted: the row is the record of
    // what a cohort of members was actually seeded from.
    await undesignateAll();
    const firstFeed = await adminFeed("First Seed");
    const secondFeed = await adminFeed("Second Seed");

    const first = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: firstFeed },
    });
    expect(first.statusCode).toBe(200);
    const firstId = first.json().designated.id;

    const second = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: secondFeed },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().replaced.id).toBe(firstId);
    expect(await designatedId()).toBe(second.json().designated.id);

    const { rows } = await client.query<{ revoked_at: Date | null; kind: string }>(
      `SELECT revoked_at, kind FROM feed_formulas WHERE id = $1`,
      [firstId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    // A retired seed keeps its kind and its snapshot — that is what stops L9's
    // cohort case from moving under it.
    expect(rows[0].kind).toBe("seed");
  });

  it("keeps a cohort's provenance when the seed it came from is retired", async () => {
    // L9, and the case that fails against the old feedProvenanceSql. Provenance
    // keys on `kind`, which is written once and never moves; keyed on
    // `is_default_seed`'s CURRENT value, retiring a seed retroactively unmade
    // `fromStarter` for everyone it seeded AND handed them "from the operator's
    // Starter" as though they had chosen it. §14 of the parent fixed exactly
    // that one object down, and the formula rebuilt it.
    await undesignateAll();
    const oldFeed = await adminFeed("Cohort Seed");
    const designation = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: oldFeed },
    });
    expect(designation.statusCode).toBe(200);

    const member = await account("cohort-member");
    await seedStarterFeeds(member.id);
    const before = await listFeedsForOwner(member.id);
    expect(before[0].from_starter).toBe(true);

    // Retire it by designating a replacement — the only way to undesignate.
    const newFeed = await adminFeed("Replacement Seed");
    const swap = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: newFeed },
    });
    expect(swap.statusCode).toBe(200);

    const after = await listFeedsForOwner(member.id);
    expect(after[0].from_starter).toBe(true);
    expect(after[0].origin_formula_name).toBeNull();
    expect(after[0].origin_author_name).toBeNull();
  });

  it("refuses to cut a sourceless feed — a seeded empty feed shows the platform stream", async () => {
    // The refusal belongs HERE, at designation, where an operator is present to
    // be told. That is the whole argument for the seed staying frozen while
    // share links went live (L3): at signup there is nobody to tell, and an
    // un-seeded account never retries.
    await undesignateAll();
    const { rows: hollow } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'Hollow', 9) RETURNING id`,
      [adminId],
    );
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: hollow[0].id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("formula_empty");
    expect(await designatedId()).toBeNull();
  });

  it("has no branch that designates a row that already exists", async () => {
    // L5 — a seed is CUT, never adopted. With one live link per feed,
    // designating an existing row would let an operator designate a MEMBER's
    // share link, which feed_formulas_seed_never_revoked would then make
    // unwithdrawable: seizing somebody's link and removing their ability to
    // stop it. The schema is strict(), so the old body is a 400.
    await undesignateAll();
    const existing = await formula(adminId, { name: "Already Cut" });
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { formulaId: existing.id },
    });
    expect(res.statusCode).toBe(400);
    expect(await designatedId()).toBeNull();
  });

  it("cuts one of the admin's own feeds into a new designated formula", async () => {
    await undesignateAll();
    const followee = await account("cut-followee");
    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, 'House Feed', 9, '{"scheme":"winter"}'::jsonb) RETURNING id`,
      [adminId],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id)
       VALUES ($1, 'account', $2)`,
      [feed[0].id, followee.id],
    );

    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed[0].id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().minted).toBe(true);
    const nowSeed = await designatedId();
    expect(nowSeed).toBe(res.json().designated.id);
    // Frozen by portable identity, not by row id (D4).
    const { rows: frozen } = await client.query<{
      tag_value: string;
      source_type: string;
    }>(
      `SELECT tag_value, source_type FROM feed_formula_sources WHERE formula_id = $1`,
      [nowSeed],
    );
    expect(frozen).toHaveLength(1);
    expect(frozen[0].source_type).toBe("account");
    expect(frozen[0].tag_value).toBe(
      (
        await client.query<{ nostr_pubkey: string }>(
          `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
          [followee.id],
        )
      ).rows[0].nostr_pubkey,
    );
  });

  it("refuses to cut a feed the admin does not own", async () => {
    // Freezing writes author_id from the caller, and a designated formula's
    // author cannot delete their account (D11 through the CASCADE). Making
    // somebody else's account undeletable must not be reachable by typing a
    // uuid.
    await undesignateAll();
    const stranger = await account("stranger");
    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'Theirs', 1) RETURNING id`,
      [stranger.id],
    );
    const res = await app.inject({
      method: "POST",
      url: "/admin/dashboard/seed-formula",
      payload: { feedId: feed[0].id },
    });
    expect(res.statusCode).toBe(404);
    expect(await designatedId()).toBeNull();
  });

  it("names the designated formula, so what is load-bearing is visible", async () => {
    await undesignateAll();
    const seed = await formula(adminId, { name: "Reported Seed" });
    await client.query(
      `UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`,
      [seed.id],
    );

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/seed-formula",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.designated.id).toBe(seed.id);
    expect(body.designated.authorIsSelf).toBe(true);
    // No `/f/` URL: a seed has no address (L10). Offering one would hand the
    // operator a link the public routes 404, and under a live-link scheme it
    // would have meant one URL standing for two compositions.
    expect(body.designated.url).toBeUndefined();
    // `candidates` went with the branch that consumed it.
    expect(body.candidates).toBeUndefined();
  });

  it("reports the undesignated state as such, rather than as an empty panel", async () => {
    // The state the panel exists for. Nothing designated means nothing seeds a
    // new account, and the operator's only warning is this response — the flag
    // it replaced was destroyed twice precisely because nothing ever said which
    // object was load-bearing.
    await undesignateAll();

    const res = await app.inject({
      method: "GET",
      url: "/admin/dashboard/seed-formula",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().designated).toBeNull();
  });
});
