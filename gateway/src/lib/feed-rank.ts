import { getPlatformConfig } from "./platform-config.js";

// =============================================================================
// D6 — the proof term, and the α it blends with
// (SOCIAL-PROOF-RESONANCE-ADR D6, sequencing step 5)
//
// Steps 3/4 stored `resonance` / `resonance_band` / `ambient_pctl` on
// feed_items and rendered the band. Nothing RANKED on them. This module holds
// the read-time pieces that do:
//
//   proof_term      = max(α · resonance_norm + (1 − α) · ambient_pctl, floor)
//   resonance_norm  = clamp(resonance, 0, 4) / 4
//
// WHY READ TIME (D6): α is a per-surface product decision, but `fi.score` is
// computed surface-agnostically at cron time — a cron-baked blend could only
// bake one α. And ranking native items on cron gravity scores while external
// items ranked on read-time proof terms would put the two in incommensurable
// units, which is precisely the disease this ADR exists to cure.
//
// WHERE IT IS NOW SPENT, and what went with it (migration 202). The term used
// to be a whole feed's ORDER BY, divided by an age decay and multiplied by the
// source's weight, behind the `RESONANCE_RANKING_ENABLED` brake. The feed is
// now a timeline and the proof term is the **TOP criterion inside a single
// source's own posts** (`lib/source-selection.ts::proofTermSql`). Three
// consequences, all deliberate:
//
//   - the AGE DECAY is gone. It earned its place when this ordered a whole
//     feed; inside a window already bounded by recency it would only re-select
//     recent posts, which is what the 100% setting already gives the reader.
//     With it went the `asOf` cursor pinning that existed solely to stop a
//     decaying score re-qualifying boundary items between pages.
//   - the WEIGHT multiplier is gone with the column (`weight` → `throughput`);
//     nothing multiplies a sort key any more.
//   - the BRAKE is gone. It existed because ranking a feed on engagement is a
//     claim the platform makes unasked. Ranking a source's posts on engagement
//     is now a thing the READER asks for, per source, by pressing TOP — which
//     is a better answer to the same question than a global flag, and is what
//     CARDS-AND-PIP-PANEL-HANDOFF §48 always said the control was for.
//
// `fi.score` and feed-scores-refresh's gravity write are untouched; they are
// simply no longer read by the feed query.
// =============================================================================

export interface ProofBlendParams {
  /** The α every composed feed ranks with — "a moment for this writer". */
  alphaFollowing: number;
  /** DORMANT since the reach retirement (see feedAlphaCte): the "big on the
   *  network" α, waiting on a new explore-surface discriminator (§9.12). */
  alphaExplore: number;
  /** Floor under proof_term, which is what makes a silent source order by
   *  recency — see proofTermSql in lib/source-selection.ts. */
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
    // `feed_gravity` is NOT read here any more — the age decay went with the
    // feed-level ranking (see the header). The dial is alive and its fallback
    // is parity-tested where its one remaining reader lives,
    // feed-ingest's loadFeedWeights.
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
 * Check 4c) but is DORMANT: the §9.12 explore A/B needs a new discriminator
 * before it can run.
 * The CTE shape is kept (rather than binding α inline in proofTermSql) so a
 * future discriminator slots back in without touching the criterion SQL.
 */
export function feedAlphaCte(alphaParam: number): string {
  return `
    feed_alpha AS (
      SELECT $${alphaParam}::float8 AS alpha
    )`;
}
