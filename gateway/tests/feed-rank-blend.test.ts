import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  feedAlphaCte,
  proofBlendScoreSql,
  resonanceRankingEnabled,
} from "../src/lib/feed-rank.js";

// =============================================================================
// D6 read-time proof blend — integration test
// (SOCIAL-PROOF-RESONANCE-ADR D6, sequencing step 5)
//
// Exercises the REAL SQL builders (lib/feed-rank.ts — the same strings
// feeds/items.ts splices into its `scored` CTE) against a live Postgres, with
// every fixture seeded inside a transaction that is ALWAYS rolled back.
//
// Ranking is the thing dedup taught us to be paranoid about: an ordering bug is
// silent — the feed still renders, just wrong — so the assertions here are on
// ORDER and on the boundary cases the expression exists to handle (absence,
// clamping, alpha selection), not on "the query returns rows".
//
// Skipped unless a DB URL is supplied, so the no-Postgres CI `test` job stays
// green. Run locally against the dev DB:
//   TEST_DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/feed-rank-blend.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Params mirror the host query's layout: $1 fi_id[], then the four blend
// params in the order items.ts pushes them. (α became a single constant param
// when the reach source kind — the only explore-surface discriminator — was
// retired, migration 177/§9.16; feedAlphaCte now just binds it.)
const P_ALPHA = 2;
const P_GRAVITY = 3;
const P_FLOOR = 4;
const P_ASOF = 5;

// The host's `scored` CTE, reduced to just the ranking expression. `matched` is
// stubbed with a flat weight of 1 so weight never confounds the proof term;
// there is a dedicated weight test below that varies it.
function rankSql(weight = "1::float8"): string {
  return `
    WITH ${feedAlphaCte(P_ALPHA).trim()},
    matched AS (
      SELECT id AS fi_id, ${weight} AS weight FROM feed_items WHERE id = ANY($1::uuid[])
    )
    SELECT fi.id AS fi_id, ${proofBlendScoreSql(P_GRAVITY, P_FLOOR, P_ASOF)} AS effective_score
    FROM feed_items fi
    JOIN matched m ON m.fi_id = fi.id
    ORDER BY effective_score DESC, fi.id DESC
  `;
}

describe.skipIf(!DB_URL)("D6 read-time proof blend (step 5)", () => {
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
    opts: { alpha?: number; gravity?: number; floor?: number; weight?: string; asOf?: number } = {},
  ): Promise<{ id: string; score: number }[]> {
    const { rows } = await client.query<{ fi_id: string; effective_score: string }>(
      rankSql(opts.weight),
      [
        ids,
        opts.alpha ?? 0.8,
        opts.gravity ?? 1.5,
        opts.floor ?? 0.05,
        opts.asOf ?? testAsOf,
      ],
    );
    return rows.map((r) => ({ id: r.fi_id, score: Number(r.effective_score) }));
  }

  // --- the brake ------------------------------------------------------------

  it("is off unless RESONANCE_RANKING_ENABLED is explicitly truthy", () => {
    const prev = process.env.RESONANCE_RANKING_ENABLED;
    try {
      delete process.env.RESONANCE_RANKING_ENABLED;
      expect(resonanceRankingEnabled()).toBe(false);
      process.env.RESONANCE_RANKING_ENABLED = "0";
      expect(resonanceRankingEnabled()).toBe(false);
      // A common near-miss: "false" must not read as on.
      process.env.RESONANCE_RANKING_ENABLED = "false";
      expect(resonanceRankingEnabled()).toBe(false);
      process.env.RESONANCE_RANKING_ENABLED = "1";
      expect(resonanceRankingEnabled()).toBe(true);
      process.env.RESONANCE_RANKING_ENABLED = "true";
      expect(resonanceRankingEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RESONANCE_RANKING_ENABLED;
      else process.env.RESONANCE_RANKING_ENABLED = prev;
    }
  });

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

  it("ranks fresher above older at equal proof (gravity term is live)", async () => {
    const fresh = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 1 });
    const old = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 72 });
    const order = await rank([fresh, old]);
    expect(order.map((r) => r.id)).toEqual([fresh, old]);
    // And the decay is real, not a rounding artefact.
    expect(order[0].score).toBeGreaterThan(order[1].score * 5);
  });

  // --- absence (the correction to D6-as-drafted) ----------------------------

  it("orders NULL-resonance items by recency instead of collapsing them", async () => {
    // This is the whole reason the floor exists. With proof_term = 0 exactly,
    // every one of these scores 0 and the ORDER BY falls through to the uuid
    // tiebreak — i.e. arbitrary order. Assert real recency ordering.
    const fresh = await item({ resonance: null, ambientPctl: null, ageHours: 1 });
    const mid = await item({ resonance: null, ambientPctl: null, ageHours: 24 });
    const old = await item({ resonance: null, ambientPctl: null, ageHours: 200 });
    const order = await rank([old, fresh, mid]);
    expect(order.map((r) => r.id)).toEqual([fresh, mid, old]);
    // Every score strictly positive and strictly decreasing — no ties to break.
    expect(order[0].score).toBeGreaterThan(order[1].score);
    expect(order[1].score).toBeGreaterThan(order[2].score);
    expect(order[2].score).toBeGreaterThan(0);
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

  // --- pinned as-of (§0i.2 — time-shifted pagination) -----------------------

  it("scores are exact at a pinned asOf, so the page-1 boundary item never re-qualifies", async () => {
    // The keyset filter is a strict (score, id) <. Page 2 re-evaluates every
    // item's score, so exactness at the SAME asOf is what excludes the page-1
    // boundary item. With now() instead, the boundary item's score has decayed
    // below the cursor score by page 2 and re-qualifies — the duplicate bug.
    const a = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 1 });
    const b = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 2 });
    const asOf = Date.now() / 1000;

    const page1 = await rank([a, b], { asOf });
    const boundary = page1[0]; // pretend LIMIT 1: cursor = (boundary.score, boundary.id)

    // Re-evaluated at the pinned asOf, the boundary item reproduces its score
    // EXACTLY — the strict `<` therefore excludes it from page 2.
    const again = await rank([a, b], { asOf });
    const reScore = again.find((r) => r.id === boundary.id)!.score;
    expect(reScore).toBe(boundary.score);

    // The bug class this pins out: an hour later, an UNpinned evaluation gives
    // the boundary item a strictly lower score than the cursor carries — it
    // would re-qualify under `<` and duplicate.
    const shifted = await rank([a, b], { asOf: asOf + 3600 });
    const decayed = shifted.find((r) => r.id === boundary.id)!.score;
    expect(decayed).toBeLessThan(boundary.score);
  });

  // --- weight ---------------------------------------------------------------

  it("still multiplies by the per-item source weight", async () => {
    const a = await item({ resonance: 2, ambientPctl: 0.5, ageHours: 5 });
    const base = (await rank([a]))[0].score;
    const doubled = (await rank([a], { weight: "2::float8" }))[0].score;
    expect(doubled).toBeCloseTo(base * 2, 10);
  });

  it("lets a loud silent source outrank a quiet resonant one (weight is a real dial)", async () => {
    // Guards the composition: proof must not become an override that makes the
    // volume control decorative.
    const silent = await item({ resonance: null, ambientPctl: null, ageHours: 5 });
    const resonant = await item({ resonance: 4, ambientPctl: 1, ageHours: 5 });
    const equal = await rank([silent, resonant]);
    expect(equal.map((r) => r.id)).toEqual([resonant, silent]);
    // With a floor of 0.05 vs proof 1.0, weight 25x flips it.
    const weighted = await rank([silent, resonant], {
      weight: `(CASE WHEN id = '${silent}'::uuid THEN 25 ELSE 1 END)::float8`,
    });
    expect(weighted[0].id).toBe(silent);
  });
});

function randHex(): string {
  return process.hrtime.bigint().toString(16);
}
