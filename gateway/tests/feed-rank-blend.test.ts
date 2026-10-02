import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { feedAlphaCte } from "../src/lib/feed-rank.js";
import { proofTermSql } from "../src/lib/source-selection.js";

// =============================================================================
// The TOP criterion — integration test
// (SOCIAL-PROOF-RESONANCE-ADR D6, as spent since migration 202)
//
// Exercises the REAL SQL builder (`proofTermSql` — the same string
// lib/source-selection.ts orders each source's window by) against a live
// Postgres, with every fixture seeded inside a transaction that is ALWAYS
// rolled back.
//
// WHAT CHANGED, because this file used to test something larger. The proof term
// was a whole feed's ORDER BY, divided by an age decay and multiplied by the
// source's weight, behind RESONANCE_RANKING_ENABLED. It is now the ordering
// INSIDE one source's own posts, from which the top `throughput` fraction is
// kept — so the decay, the weight multiplier, the `asOf` pinning and the brake
// are all gone (see the module header). What remains is the part that decides
// which of a source's posts are its best, and the boundary cases the expression
// exists to handle: absence and clamping.
//
// Ranking is the thing dedup taught us to be paranoid about: an ordering bug is
// silent — the feed still renders, just wrong — so the assertions are on ORDER,
// not on "the query returns rows". Selection itself is tested next door in
// source-selection.test.ts.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and FAILS on a skip). Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/feed-rank-blend.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Params mirror the host's layout: $1 fi_id[], then α and the floor. (α became
// a single constant param when the reach source kind — the only explore-surface
// discriminator — was retired, migration 177/§9.16; feedAlphaCte now just binds
// it.)
const P_ALPHA = 2;
const P_FLOOR = 3;

// The ordering source-selection.ts takes inside one source's window, isolated.
// The tiebreak is the real one: published_at DESC, which is what turns a tie at
// the floor into recency order rather than an arbitrary uuid sort.
function rankSql(): string {
  return `
    WITH ${feedAlphaCte(P_ALPHA).trim()}
    SELECT fi.id AS fi_id, ${proofTermSql(P_FLOOR)} AS criterion
    FROM feed_items fi
    WHERE fi.id = ANY($1::uuid[])
    ORDER BY criterion DESC, fi.published_at DESC, fi.id DESC
  `;
}

describe.skipIf(!DB_URL)("the TOP criterion (D6 proof term)", () => {
  let client: pg.Client;
  // One pinned asOf per test: cross-call score comparisons (alpha/weight)
  // rely on both evaluations seeing identical ages, which SQL now() used to
  // give for free (transaction-stable) and a per-call Date.now() does not.
  let testAsOf: number;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    testAsOf = Date.now() / 1000;
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  // --- helpers --------------------------------------------------------------

  /**
   * A feed_item with explicit resonance columns and age. `ageHours` is turned
   * into published_at relative to now() so the gravity term is exercised for
   * real rather than mocked.
   */
  async function item(opts: {
    resonance: number | null;
    ambientPctl: number | null;
    ageHours: number;
    protocol?: string;
  }): Promise<string> {
    const src = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ($1::external_protocol, $2) RETURNING id`,
      [opts.protocol ?? "atproto", `https://fixture.test/${randHex()}`],
    );
    const ext = await client.query<{ id: string }>(
      // tier3 is the atproto/activitypub tier — external_items'
      // protocol_tier_consistency CHECK pins the pair.
      `INSERT INTO external_items
         (source_id, protocol, tier, source_item_uri, published_at)
       VALUES ($1, $2::external_protocol, 'tier3'::content_tier, $3,
               now() - make_interval(hours => $4))
       RETURNING id`,
      [src.rows[0].id, opts.protocol ?? "atproto", `uri:${randHex()}`, opts.ageHours],
    );
    const fi = await client.query<{ id: string }>(
      `INSERT INTO feed_items
         (item_type, external_item_id, author_name, published_at, source_protocol,
          source_id, biddability_tier, post_id, resonance, ambient_pctl)
       VALUES ('external', $1, 'fixture', now() - make_interval(hours => $2), $3,
               $4, 'B', $5, $6, $7)
       RETURNING id`,
      [
        ext.rows[0].id,
        opts.ageHours,
        opts.protocol ?? "atproto",
        src.rows[0].id,
        `post:${randHex()}`,
        opts.resonance,
        opts.ambientPctl,
      ],
    );
    return fi.rows[0].id;
  }

  async function rank(
    ids: string[],
    opts: { alpha?: number; floor?: number } = {},
  ): Promise<{ id: string; score: number }[]> {
    const { rows } = await client.query<{ fi_id: string; criterion: string }>(
      rankSql(),
      [ids, opts.alpha ?? 0.8, opts.floor ?? 0.05],
    );
    return rows.map((r) => ({ id: r.fi_id, score: Number(r.criterion) }));
  }

  // --- the dials -----------------------------------------------------------

  it("has every dial it reads seeded in platform_config, not hard-coded", async () => {
    // The blend must be tunable by UPDATE, never by deploy (CLAUDE.md tuning-dial
    // rule). Assert the four keys loadProofBlendParams() reads actually exist and
    // parse — migrations 158 (alphas) + 161 (floor) + the pre-existing gravity.
    //
    // feed_gravity is deliberately NOT asserted present: it was seeded by
    // migration 035, which predates the schema.sql genesis base, and schema.sql
    // carries structure only — so migrate.ts skips 035 as already-applied on any
    // fresh DB and the row never lands. That gap is real but pre-existing and
    // wider than this step (it hits every pre-genesis config seed); the loader's
    // fallback matches the seeded value, so the blend behaves identically. See
    // CONSOLIDATED-TODO.
    const { rows } = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_config
        WHERE key IN ('feed_alpha_following','feed_alpha_explore','feed_proof_floor')`,
    );
    const map = new Map(rows.map((r) => [r.key, parseFloat(r.value)]));
    expect([...map.keys()].sort()).toEqual([
      "feed_alpha_explore",
      "feed_alpha_following",
      "feed_proof_floor",
    ]);
    for (const v of map.values()) expect(Number.isFinite(v)).toBe(true);
    // "A moment for this writer" outweighs ambient on a following surface, and
    // less so on explore — the D6 semantic, asserted as an ordering not a value.
    expect(map.get("feed_alpha_following")!).toBeGreaterThan(map.get("feed_alpha_explore")!);
    expect(map.get("feed_proof_floor")!).toBeGreaterThan(0);
    expect(map.get("feed_proof_floor")!).toBeLessThan(1);
  });

  // --- ordering -------------------------------------------------------------

  it("ranks higher proof above lower proof at equal age", async () => {
    const strong = await item({ resonance: 4, ambientPctl: 0.9, ageHours: 6 });
    const weak = await item({ resonance: 0.5, ambientPctl: 0.2, ageHours: 6 });
    const order = await rank([strong, weak]);
    expect(order.map((r) => r.id)).toEqual([strong, weak]);
  });

  it("breaks an equal-proof tie on recency, not on the uuid", async () => {
    // There is no age decay in the criterion any more, so two equally resonant
    // posts score IDENTICALLY — and inside a window bounded by recency that is
    // right. What orders them is the tiebreak, and without it the ORDER BY
    // falls through to the uuid: a source's cut would then include an arbitrary
    // half of its tied posts and reshuffle between pages.
    const fresh = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 1 });
    const old = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 72 });
    const order = await rank([fresh, old]);
    expect(order.map((r) => r.id)).toEqual([fresh, old]);
    expect(order[0].score).toBe(order[1].score);
  });

  // --- absence (the correction to D6-as-drafted) ----------------------------

  it("orders NULL-resonance items by recency instead of collapsing them", async () => {
    // This is the whole reason the floor exists, and it is what makes a source
    // with NO engagement signal — rss, email, external nostr while its counts
    // flag is dark — behave: every item ties at the floor and the recency
    // tiebreak orders them, so "the top 60%" of such a source is its most
    // recent 60%, in order. Without the floor the tie is at 0 and the sort
    // falls through to the uuid: an arbitrary 60%, reshuffling between pages.
    const fresh = await item({ resonance: null, ambientPctl: null, ageHours: 1 });
    const mid = await item({ resonance: null, ambientPctl: null, ageHours: 24 });
    const old = await item({ resonance: null, ambientPctl: null, ageHours: 200 });
    const order = await rank([old, fresh, mid]);
    expect(order.map((r) => r.id)).toEqual([fresh, mid, old]);
    // They all sit ON the floor — positive, and equal — so it is the recency
    // tiebreak doing the ordering. A floor of 0 would make them equal too, and
    // equally ordered by the uuid; positive-and-equal is what says the floor is
    // carrying them rather than nothing being there.
    expect(order[0].score).toBe(order[1].score);
    expect(order[1].score).toBe(order[2].score);
    expect(order[2].score).toBeGreaterThan(0);
  });

  it("treats proof BELOW the floor as indistinguishable from silence", async () => {
    // What the floor actually decides, now that an explicit published_at
    // tiebreak (not the floor) is what stops silent items falling through to a
    // uuid sort. Below it we do not claim to be able to tell posts apart, so
    // recency does — which is the difference between "a post with one stray
    // like outranks everything silent forever" and "it takes its place in
    // time". Removing the GREATEST makes this red and nothing else: the
    // trivial-proof item then outranks both silent ones regardless of age.
    const trivial = await item({ resonance: 0, ambientPctl: 0.01, ageHours: 40 });
    const silentFresh = await item({ resonance: null, ambientPctl: null, ageHours: 1 });
    const silentOld = await item({ resonance: null, ambientPctl: null, ageHours: 90 });

    const order = await rank([trivial, silentFresh, silentOld]);
    expect(order.map((r) => r.id)).toEqual([silentFresh, trivial, silentOld]);
    // All three sit ON the floor — equal, and positive.
    expect(order[0].score).toBe(order[1].score);
    expect(order[1].score).toBe(order[2].score);
  });

  it("keeps a silent item below a resonant item of the same age", async () => {
    const silent = await item({ resonance: null, ambientPctl: null, ageHours: 12 });
    const resonant = await item({ resonance: 1, ambientPctl: 0.3, ageHours: 12 });
    const order = await rank([silent, resonant]);
    expect(order.map((r) => r.id)).toEqual([resonant, silent]);
  });

  // --- clamping -------------------------------------------------------------

  it("clamps resonance to [0,4] so an outlier row cannot dominate a feed", async () => {
    const huge = await item({ resonance: 40, ambientPctl: 1, ageHours: 5 });
    const capped = await item({ resonance: 4, ambientPctl: 1, ageHours: 5 });
    const order = await rank([huge, capped]);
    expect(order[0].score).toBeCloseTo(order[1].score, 10);
  });

  it("clamps negative resonance to 0 instead of letting it cancel real ambient proof", async () => {
    // resonance < 0 means E came in under this author's baseline. It must
    // subtract NOTHING — a below-baseline post that is nonetheless in the top
    // decile for its network still carries ambient proof, and a negative term
    // would eat it. Asserted against an ambient-matched item with resonance 0,
    // rather than merely "score > 0": the floor alone would satisfy the latter,
    // so that weaker assertion cannot tell a working clamp from a missing one.
    const under = await item({ resonance: -3, ambientPctl: 1, ageHours: 5 });
    const flat = await item({ resonance: 0, ambientPctl: 1, ageHours: 5 });
    const order = await rank([under, flat]);
    const byId = new Map(order.map((r) => [r.id, r.score]));
    expect(byId.get(under)).toBeCloseTo(byId.get(flat)!, 10);
    // And well clear of the floor — i.e. the ambient term genuinely survived.
    const silent = await item({ resonance: null, ambientPctl: null, ageHours: 5 });
    const withSilent = await rank([under, silent]);
    expect(withSilent[0].id).toBe(under);
  });

  it("clamps ambient_pctl to [0,1]", async () => {
    const bad = await item({ resonance: 0, ambientPctl: 7, ageHours: 5 });
    const good = await item({ resonance: 0, ambientPctl: 1, ageHours: 5 });
    const order = await rank([bad, good]);
    expect(order[0].score).toBeCloseTo(order[1].score, 10);
  });

  // --- alpha (a bound constant since the reach retirement, §9.16) -----------

  it("binds the caller's α — the ambient share moves with (1−α) exactly", async () => {
    // One item with all its proof in ambient_pctl and none in resonance: a
    // LOWER alpha must score it HIGHER, since (1-alpha) multiplies the ambient
    // term. alpha 0.4 vs 0.8 ⇒ ambient weighted 0.6 vs 0.2 ⇒ 3x — which pins
    // that the α the caller binds is the α the SQL actually ranks with (the
    // CTE is a constant now; a hard-coded α would pass every ordering test
    // above while making the dial decorative).
    const ambientOnly = await item({ resonance: 0, ambientPctl: 1, ageHours: 5 });

    const at08 = (await rank([ambientOnly], { alpha: 0.8 }))[0].score;
    const at04 = (await rank([ambientOnly], { alpha: 0.4 }))[0].score;

    expect(at04).toBeCloseTo(at08 * 3, 10);
  });

});

function randHex(): string {
  return process.hrtime.bigint().toString(16);
}
