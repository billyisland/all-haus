import { pool } from "@platform-pub/shared/db/client.js";
import { getPlatformConfig } from "./platform-config.js";

// =============================================================================
// resonance — per-item response-vs-expectation scoring
// (SOCIAL-PROOF-RESONANCE-ADR D4/D5, sequencing step 3)
//
// Writes the three derived feed_items columns from stored counts + the daily
// baselines (migration 158):
//
//   E              = weighted engagement, within-origin (D2/D2a)
//   baseline       = (n·median_e + k·ambient_p50) / (n + k)          (D3 shrinkage)
//   resonance      = log2((1 + E) / (1 + baseline))                  (D4)
//   resonance_band = 0..3, ambient percentile as a VETO not a boost  (D4)
//   ambient_pctl   = E's percentile within its network               (D5, for D6)
//
// Called from the two refresh crons rather than at read time: the cost is one
// extra UPDATE per batch, and the read path stays a plain column select.
//
// ABSENCE, NOT ZERO. A row only gets values when its protocol has an ambient
// row — hence the INNER JOIN on protocol_engagement_ambient. rss/email never
// produce one (structurally silent), and nostr_external produces one only when
// NOSTR_ENGAGEMENT_COUNTS_ENABLED let the baseline task sample it. Those rows
// stay NULL, which the card renders as no glyph — never band-0 styling. Do not
// "fix" this with COALESCE.
//
// The author baseline is a LEFT JOIN on purpose: an author with no baseline row
// (new, pruned after 30 silent days, or a tier-C/D item with no author ref)
// scores n=0, i.e. purely against network ambient. That is the D3 cold-start
// answer, not a missing-data case.
//
// Known staleness, accepted (D5): the external cron skips rows whose counts
// didn't move, so a static item's band is not recomputed when its author's
// baseline or the network ambient shifts underneath it. It re-aligns the next
// time its counts change.
// =============================================================================

/** How far back the native pass recomputes. Mirrors the external cron's window. */
const NATIVE_WINDOW_DAYS = 7;

export interface ResonanceParams {
  like: number;
  reply: number;
  repost: number;
  nativeUp: number;
  nativeGate: number;
  k: number;
  band1: number;
  band2: number;
  band3: number;
}

export async function loadResonanceParams(): Promise<ResonanceParams> {
  const config = await getPlatformConfig();
  const num = (key: string, fallback: number) => {
    const v = parseFloat(config.get(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    like: num("resonance_weight_like", 1),
    reply: num("resonance_weight_reply", 3),
    repost: num("resonance_weight_repost", 2),
    nativeUp: num("resonance_weight_native_up", 5),
    nativeGate: num("resonance_weight_native_gate", 5),
    // k=3: ambient is ~13% of the baseline at n=20 (migration 158 header).
    k: num("resonance_shrink_k", 3),
    // Band gates, re-measured at step 3 — the ADR draft's 1/2/3 ran 2-3x hot
    // against its own targets. Config, not constants: tuning a band must never
    // need a deploy (migration 160 header carries the measured distributions).
    band1: num("resonance_band1_min", 2.5),
    band2: num("resonance_band2_min", 4),
    band3: num("resonance_band3_min", 6),
  };
}

// ---------------------------------------------------------------------------
// Shared SQL. Both passes end in the same shape — a CTE `j` carrying
// (feed_item_id, e, baseline, p50_e, p90_e) — so the band/percentile
// expressions below are written once.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E — the raw engagement scalar (§0h.6).
//
// E is computed in TWO modules that must agree exactly: the baseline cron
// (engagement-baseline-refresh.ts) builds the reference distribution that this
// module's scorer then divides by. They are numerator and denominator of one
// ratio. A term added, dropped or reweighted on one side does not error — it
// silently scores every post against a distribution built from a different
// formula, and the only visible symptom is bands that look mis-tuned, sending
// the next person off to retune the gates, which are not the problem.
//
// So the expression lives here once, parameterised by placeholder, in the same
// shape as bandExpr/PCTL_EXPR above. Callers supply their own $n numbering.
// Guarded by resonance-e-parity.test.ts.
// ---------------------------------------------------------------------------

/** External E: like/reaction + reply + repost/boost, weighted. */
export function externalEExpr(like: string, reply: string, repost: string): string {
  return `(ei.like_count * ${like} + ei.reply_count * ${reply} + ei.repost_count * ${repost})::numeric`;
}

/**
 * Native E: upvotes + gate passes + replies, weighted.
 *
 * `replyAlias` exists because the two call sites join the reply LATERAL under
 * different names (`r` in the baseline, `rp` in the scorer, which already uses
 * `r` for its own results CTE). Threading the alias keeps one expression rather
 * than forking it over a naming collision.
 */
export function nativeEExpr(
  up: string,
  gate: string,
  reply: string,
  replyAlias: string,
): string {
  return `(COALESCE(v.up, 0) * ${up} + COALESCE(g.passes, 0) * ${gate} + COALESCE(${replyAlias}.replies, 0) * ${reply})::numeric`;
}

/**
 * The three LATERAL joins native E reads. Kept with the expression because the
 * expression is meaningless without exactly these joins in scope — splitting
 * them is how the two drift apart while both still compile.
 */
export function nativeEngagementJoins(replyAlias: string): string {
  return `
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS up FROM votes
        WHERE target_nostr_event_id = p.nostr_event_id AND direction = 'up'
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS passes FROM read_events
        WHERE article_id = p.article_id AND state <> 'charged_back'
      ) g ON p.article_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS replies FROM feed_engagement
        WHERE target_nostr_event_id = p.nostr_event_id AND engagement_type = 'reply'
      ) ${replyAlias} ON true`;
}

/**
 * D4. The ambient clause is a veto, never a boost: a high ratio against a
 * shrunk-to-nothing baseline (3 replies vs. 0.4) must not read as "surging",
 * so every band above 0 also requires clearing the network's own p50/p90.
 */
function bandExpr(b1: string, b2: string, b3: string): string {
  return `
  CASE
    WHEN r.resonance >= ${b3} AND r.e >= r.p90_e THEN 3
    WHEN r.resonance >= ${b2} AND r.e >= r.p50_e THEN 2
    WHEN r.resonance >= ${b1} AND r.e >= r.p50_e THEN 1
    ELSE 0
  END::smallint`;
}

/**
 * D5. E's position in its network's distribution, interpolated piecewise from
 * the two stored percentiles: 0→p50 maps to 0.0–0.5, p50→p90 to 0.5–0.9, and
 * the tail above p90 compresses into 0.9–1.0.
 *
 * The degenerate branches matter: on a quiet network p50_e is commonly 0 (most
 * external posts get nothing), which would divide by zero in the first segment.
 * A post with any engagement at all is then already above the median, so it
 * starts at 0.5 and interpolates over 0→p90 instead.
 */
const PCTL_EXPR = `
  CASE
    WHEN r.e <= 0 THEN 0
    WHEN r.p90_e <= 0 THEN 1.0
    WHEN r.p50_e <= 0 THEN
      CASE
        WHEN r.e >= r.p90_e
          THEN LEAST(1.0, 0.9 + 0.1 * (r.e - r.p90_e) / GREATEST(r.p90_e, 1))
        ELSE 0.5 + 0.4 * r.e / r.p90_e
      END
    WHEN r.e < r.p50_e THEN 0.5 * r.e / r.p50_e
    WHEN r.e < r.p90_e THEN 0.5 + 0.4 * (r.e - r.p50_e) / (r.p90_e - r.p50_e)
    ELSE LEAST(1.0, 0.9 + 0.1 * (r.e - r.p90_e) / GREATEST(r.p90_e, 1))
  END`;

/** D3 shrinkage + D4 ratio, over a CTE `e` carrying (feed_item_id, e, author_ref, protocol, post_type). */
function scoreTail(
  kParam: string,
  b1: string,
  b2: string,
  b3: string,
): string {
  return `
    j AS (
      SELECT e.feed_item_id, e.e, amb.p50_e, amb.p90_e,
             (COALESCE(b.n, 0)::numeric * COALESCE(b.median_e, 0) + ${kParam} * amb.p50_e)
               / NULLIF(COALESCE(b.n, 0)::numeric + ${kParam}, 0) AS baseline
      FROM e
      JOIN protocol_engagement_ambient amb
        ON amb.protocol = e.protocol AND amb.post_type = e.post_type
      LEFT JOIN author_engagement_baseline b
        ON b.author_ref = e.author_ref
       AND b.protocol = e.protocol
       AND b.post_type = e.post_type
    ),
    r AS (
      SELECT j.*, log(2.0, (1 + j.e) / (1 + COALESCE(j.baseline, 0))) AS resonance
      FROM j
    )
    UPDATE feed_items fi
    SET resonance = r.resonance,
        resonance_band = ${bandExpr(b1, b2, b3)},
        ambient_pctl = ${PCTL_EXPR}
    FROM r
    WHERE fi.id = r.feed_item_id`;
}

// ---------------------------------------------------------------------------
// External pass — driven by the ids the engagement cron actually wrote.
// ---------------------------------------------------------------------------

/**
 * Recompute resonance for the feed_items backing the given external_items ids.
 * Counts come from the denormalised external_items columns the caller just
 * updated; the author ref and protocol come from feed_items (external_items
 * carries no author id). External rows have no note/article axis, so they key
 * on post_type 'all'.
 */
/**
 * Exported so the test battery drives the cron's OWN SQL rather than a copy
 * that can drift out from under it (the publication-split lesson). Params:
 * $1 external_item_id[], $2 w_like, $3 w_reply, $4 w_repost, $5 k, $6..$8 bands.
 */
export const EXTERNAL_RESONANCE_SQL = `
    WITH e AS (
      SELECT fi.id AS feed_item_id,
             fi.external_author_id::text AS author_ref,
             fi.source_protocol AS protocol,
             'all'::text AS post_type,
             ${externalEExpr("$2", "$3", "$4")} AS e
      FROM feed_items fi
      JOIN external_items ei ON ei.id = fi.external_item_id
      WHERE fi.external_item_id = ANY($1::uuid[])
        AND fi.item_type = 'external'
        AND fi.deleted_at IS NULL
    ),
    ${scoreTail("$5::numeric", "$6::numeric", "$7::numeric", "$8::numeric")}
    `;

export async function updateExternalResonance(
  externalItemIds: string[],
  params: ResonanceParams,
): Promise<number> {
  if (externalItemIds.length === 0) return 0;
  const result = await pool.query(EXTERNAL_RESONANCE_SQL, [
      externalItemIds,
      params.like,
      params.reply,
      params.repost,
      params.k,
      params.band1,
      params.band2,
      params.band3,
    ],
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Native pass — D2a union over the source-of-truth tables.
// ---------------------------------------------------------------------------

/**
 * Recompute resonance for native feed_items published in the last
 * NATIVE_WINDOW_DAYS.
 *
 * Unlike the external pass there is no "did the count move" signal to filter
 * on — native E is derived live from votes / read_events / feed_engagement
 * (D2a: read truth, never a mirror row that can drift), so the whole recent
 * window is recomputed each run. That is cheap at native volume; if it stops
 * being cheap, narrow the window before reintroducing a mirror table.
 *
 * E = up-votes·w_up + gate passes·w_gate + replies·w_reply. Down-votes never
 * subtract (D2 — valence is a separate axis) and charged-back reads don't
 * count, but free-allowance reads do: a gate pass is an attention signal here,
 * money is D8's axis. Native reposts aren't recorded for native targets yet, so
 * that seeded weight has no term.
 */
/**
 * Exported for the same reason as EXTERNAL_RESONANCE_SQL. Params:
 * $1 window days, $2 w_native_up, $3 w_native_gate, $4 w_reply, $5 k, $6..$8 bands.
 */
export const NATIVE_RESONANCE_SQL = `
    WITH p AS (
      SELECT fi.id AS feed_item_id,
             fi.author_id::text AS author_ref,
             'native'::text AS protocol,
             fi.item_type AS post_type,
             fi.nostr_event_id,
             fi.article_id
      FROM feed_items fi
      WHERE fi.item_type IN ('article', 'note')
        AND fi.deleted_at IS NULL
        AND fi.author_id IS NOT NULL
        AND fi.published_at > now() - make_interval(days => $1::int)
    ),
    e AS (
      SELECT p.feed_item_id, p.author_ref, p.protocol, p.post_type,
             ${nativeEExpr("$2", "$3", "$4", "rp")} AS e
      FROM p${nativeEngagementJoins("rp")}
    ),
    ${scoreTail("$5::numeric", "$6::numeric", "$7::numeric", "$8::numeric")}
    `;

export async function updateNativeResonance(
  params: ResonanceParams,
): Promise<number> {
  const result = await pool.query(NATIVE_RESONANCE_SQL, [
      NATIVE_WINDOW_DAYS,
      params.nativeUp,
      params.nativeGate,
      params.reply,
      params.k,
      params.band1,
      params.band2,
      params.band3,
    ],
  );
  return result.rowCount ?? 0;
}
