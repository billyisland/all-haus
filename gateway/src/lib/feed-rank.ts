import { getPlatformConfig } from "./platform-config.js";

// =============================================================================
// D6 — read-time proof blend for scored feed ranking
// (SOCIAL-PROOF-RESONANCE-ADR D6, sequencing step 5)
//
// Steps 3/4 stored `resonance` / `resonance_band` / `ambient_pctl` on
// feed_items and rendered the band. Nothing RANKED on them. This module is the
// read-time expression that does, replacing the cron-baked `fi.score`
// numerator in the `scored` sampling mode:
//
//   proof_term      = α · resonance_norm + (1 − α) · ambient_pctl
//   resonance_norm  = clamp(resonance, 0, 4) / 4
//   effective_score = proof_term / power(age_hours + 2, gravity) · weight
//
// WHY READ TIME (D6): α is a per-feed-surface product decision, but `fi.score`
// is computed surface-agnostically at cron time — a cron-baked blend could only
// bake one α. And ranking native items on cron gravity scores while external
// items ranked on read-time proof terms would put the two in incommensurable
// units, which is precisely the disease this ADR exists to cure. So when the
// flag is on, EVERY item in scored mode ranks by this one expression.
//
// `fi.score` and feed-scores-refresh's gravity write are untouched — they stay
// the flag-off fallback, so the brake is instantly reversible with no backfill.
// =============================================================================

// Operator brake for the D6 read-time blend (step 5). Default OFF, gating the
// one place the blend is spliced in (the `scored` CTE in feeds/items.ts) — the
// same narrowest-choke-point discipline as RESONANCE_GLYPH_ENABLED. Ranking is
// wholly server-side, so there is no web twin to keep in sync.
//
// The two brakes are INDEPENDENT on purpose: ranking on resonance and showing
// the band are separate claims with separate evidence bars, so an A/B of the
// explore feed can run with the glyph still dark.
export function resonanceRankingEnabled(): boolean {
  const v = process.env.RESONANCE_RANKING_ENABLED;
  return v === "1" || v === "true";
}

export interface ProofBlendParams {
  /** The α every composed feed ranks with — "a moment for this writer". */
  alphaFollowing: number;
  /** DORMANT since the reach retirement (see feedAlphaCte): the "big on the
   *  network" α, waiting on a new explore-surface discriminator (§9.12). */
  alphaExplore: number;
  /** HN-style time-decay exponent. Shared with feed-scores-refresh (same family). */
  gravity: number;
  /** Floor under proof_term so zero-proof items still order by recency (see below). */
  floor: number;
}

// Defaults mirror shared/src/db/config-defaults.sql — the canonical home of
// dial defaults, applied by migrate.ts on every run — NOT the migrations
// (whose config INSERTs never run on a schema.sql boot; that was the
// 2026-07-20 orphan-dials bug). A fresh DB therefore carries every row and
// these fallbacks are belt-and-braces for a never-migrated DB only; keep
// them byte-equal with the defaults file (parity tripwire queued,
// CONSOLIDATED-TODO §0h.7).
const DEFAULTS: ProofBlendParams = {
  alphaFollowing: 0.8,
  alphaExplore: 0.4,
  gravity: 1.5,
  floor: 0.05,
};

export async function loadProofBlendParams(): Promise<ProofBlendParams> {
  const config = await getPlatformConfig();
  const num = (key: string, fallback: number) => {
    const v = parseFloat(config.get(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    alphaFollowing: num("feed_alpha_following", DEFAULTS.alphaFollowing),
    alphaExplore: num("feed_alpha_explore", DEFAULTS.alphaExplore),
    // Deliberately the SAME key feed-scores-refresh uses: both are feed-ranking
    // time decay, one family, one dial. (Contrast the resonance_* weights,
    // which are namespaced away from feed_weight_* precisely so tuning hotness
    // never moves every author's baseline.)
    gravity: num("feed_gravity", DEFAULTS.gravity),
    floor: num("feed_proof_floor", DEFAULTS.floor),
  };
}

/**
 * The α, as a scalar CTE. Splice into the host query's WITH list.
 *
 * Once per-feed, now a constant: α used to be chosen from the feed's own
 * composition (a feed carrying a non-muted `reach:explore` source was the
 * explore surface), but the reach source kind was retired (migration 177,
 * CONSOLIDATED-TODO §9.16) and with it the only explore-surface discriminator.
 * Every composed feed is a following-shaped surface, so the caller binds the
 * `feed_alpha_following` value alone. `alphaExplore` stays loaded and its dial
 * stays seeded (a historically-seeded dial cannot be un-seeded — drift-guard
 * Check 4c) but is DORMANT: the §9.12 explore A/B behind
 * RESONANCE_RANKING_ENABLED needs a new discriminator before it can run.
 * The CTE shape is kept (rather than binding α inline in proofBlendScoreSql)
 * so a future discriminator slots back in without touching the score SQL.
 */
export function feedAlphaCte(alphaParam: number): string {
  return `
    feed_alpha AS (
      SELECT $${alphaParam}::float8 AS alpha
    )`;
}

/**
 * The D6 effective_score expression, for splicing into the `scored` CTE in
 * place of `COALESCE(fi.score, 0) * m.weight`. Requires `feed_alpha` (above) in
 * the host query's WITH list, `fi` bound to feed_items, and `m.weight`.
 *
 * ABSENCE HANDLING — a correction to D6 as drafted. The ADR says NULL-band
 * items (rss/email, dark nostr) "take proof_term = 0 and rank on recency alone
 * within the gravity expression". They cannot: 0 / (age+2)^g is 0 for every
 * age, so a proof_term of exactly 0 collapses every silent item to one constant
 * score and the ORDER BY falls through to the uuid tiebreak — arbitrary order,
 * not recency. A silent protocol would rank by random uuid, which is worse than
 * the chronology it replaced. So proof_term carries a small FLOOR: silent items
 * keep a positive numerator, order among themselves by age exactly as intended,
 * and still sit below any item with real proof. The floor is a config dial
 * (`feed_proof_floor`, migration 161), not a constant — it trades off how far a
 * silent-but-fresh item can outrank a resonant-but-older one.
 *
 * Both stored inputs are clamped here rather than trusted: `resonance` is
 * unbounded above (log2 of an arbitrary ratio) and negative below (E under
 * baseline), and `ambient_pctl` should be in [0,1] but is a plain NUMERIC. A
 * bad row must not be able to dominate the ordering of a whole feed.
 *
 * AGE IS PINNED TO A CALLER-SUPPLIED "AS OF" INSTANT (fractional epoch
 * seconds), never now(): with now(), every item's effective_score strictly
 * decreases between page fetches (~37%/h relative decay at 2h age, g=1.5), so
 * a page-1 boundary item re-qualifies under the strict keyset `<` on page 2 —
 * duplicates for any plain consumer, silently short pages under key-dedup.
 * Page 1 mints asOf and the cursor carries it, so every later page scores the
 * corpus at the same instant and the keyset stays exact (§0i.2).
 */
export function proofBlendScoreSql(
  gravityParam: number,
  floorParam: number,
  asOfParam: number,
): string {
  return `(
    GREATEST(
        (SELECT alpha FROM feed_alpha)
          * LEAST(GREATEST(COALESCE(fi.resonance, 0)::float8, 0), 4) / 4
      + (1 - (SELECT alpha FROM feed_alpha))
          * LEAST(GREATEST(COALESCE(fi.ambient_pctl, 0)::float8, 0), 1),
      $${floorParam}::float8
    )
    / POWER(
        GREATEST(EXTRACT(EPOCH FROM (to_timestamp($${asOfParam}::float8) - fi.published_at)) / 3600, 0) + 2,
        $${gravityParam}::float8
      )
  )::float8 * m.weight`;
}
