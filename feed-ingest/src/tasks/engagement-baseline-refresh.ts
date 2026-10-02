import type { Task } from "graphile-worker";
import type { ClientBase } from "pg";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { nostrEngagementCountsEnabled } from "@platform-pub/shared/lib/env.js";
import {
  loadResonanceParams,
  externalEExpr,
  nativeEExpr,
  nativeEngagementJoins,
  type ResonanceParams,
} from "../lib/resonance.js";

// =============================================================================
// engagement_baseline_refresh — daily author baselines + network ambient
// (SOCIAL-PROOF-RESONANCE-ADR D3, revised: recompute, don't fold)
//
// Rebuilds author_engagement_baseline and protocol_engagement_ambient from
// scratch each run. Deliberately NOT incremental: a true median can't be
// updated from (median, n) alone, and the <7d daily engagement sweep touches
// each item ~6 times, so fold-on-write would multiple-count posts into the
// baseline. Recompute is idempotent, self-healing after any refresh outage,
// and gives the D5 lag guarantee structurally — only posts >48h old (near-final
// E) enter a baseline, so a surging post is always measured against the
// author's PRIOR expectation, never against itself.
//
// Per-post E (weights from platform_config, resonance_* keys — see 158):
//   external: like·w_like + reply·w_reply + repost·w_repost
//             from external_items' denormalised counts (lifetime, monotonic
//             for nostr). nostr_external only when
//             NOSTR_ENGAGEMENT_COUNTS_ENABLED — dark rows would poison
//             baselines with zeros.
//   native:   up_votes·w_up + gate_passes·w_gate + replies·w_reply
//             from votes / read_events / feed_engagement (lifetime).
//             Down-votes never subtract (D2: valence is a separate axis).
//             Native reposts: not yet recorded for native targets
//             (repost-edge.ts "bind lazily") — weight seeded, term absent.
//
// Baseline = median E over the author's last ≤20 qualifying posts. Shrinkage
// toward ambient happens at SCORE time in the refresh crons
// ((n·median + k·p50)/(n + k)), not here — the table stores the raw estimate.
//
// Bounds: 180-day sample window (external_items are pruned anyway; native is
// bounded for the same reason — ancient posts shouldn't drag a baseline), one
// connection, temp tables, ~6 statements. Runs after the 04:00 UTC daily
// engagement sweep so it sees that run's counts.
// =============================================================================

const SAMPLE_WINDOW_DAYS = 180;
const BASELINE_MIN_AGE_HOURS = 48; // posts younger than this have partial E
const BASELINE_LAST_N = 20;
const STALE_BASELINE_DAYS = 30; // authors gone from the window age out

// The five E weights this task needs are a strict subset of ResonanceParams,
// so it reads the scorer's OWN loader rather than re-declaring them. They used
// to be declared twice, with independently written fallbacks — the baseline is
// the denominator of the very ratio the scorer computes, so a weight that
// disagreed between the two would not error, it would quietly score every post
// against a distribution built from a different formula.
export type ResonanceWeights = Pick<
  ResonanceParams,
  "like" | "reply" | "repost" | "nativeUp" | "nativeGate"
>;

export const engagementBaselineRefresh: Task = async () => {
  const w: ResonanceWeights = await loadResonanceParams();
  const client = await pool.connect();
  try {
    // One transaction: the temp table is ON COMMIT DROP, and under autocommit
    // it would vanish after its own CREATE statement.
    await client.query("BEGIN");
    await refresh(client, w);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Exported for the test battery: the caller supplies the client, so a test can
 * drive the real refresh inside a transaction it rolls back. Typed ClientBase
 * rather than PoolClient because all this needs is query() — which lets a test
 * hand it a standalone Client. Note the temp table is ON COMMIT DROP, so a
 * single transaction can run this exactly once.
 */
export async function refresh(
  client: ClientBase,
  w: ResonanceWeights,
): Promise<void> {
  const externalProtocols = nostrEngagementCountsEnabled()
    ? ["atproto", "activitypub", "nostr_external"]
    : ["atproto", "activitypub"];

  // ── per-post E, external ──────────────────────────────────────────────────
  // Driven from feed_items (which carries external_author_id — external_items
  // doesn't); context-only rows are thread scaffolding, not the author's output.
  await client.query(
    `
    CREATE TEMP TABLE tmp_e ON COMMIT DROP AS
    SELECT
      fi.external_author_id::text AS author_ref,
      fi.source_protocol          AS protocol,
      'all'::text                 AS post_type,
      ei.published_at,
      ei.id                       AS item_ref,
      ${externalEExpr("$1", "$2", "$3")} AS e
    FROM feed_items fi
    JOIN external_items ei ON ei.id = fi.external_item_id
    WHERE fi.item_type = 'external'
      AND fi.external_author_id IS NOT NULL
      AND fi.deleted_at IS NULL
      AND ei.deleted_at IS NULL
      AND ei.is_context_only = false
      AND ei.protocol::text = ANY($4)
      AND ei.published_at < now() - make_interval(hours => $5)
      AND ei.published_at > now() - make_interval(days => $6)
    `,
    [
      w.like,
      w.reply,
      w.repost,
      externalProtocols,
      BASELINE_MIN_AGE_HOURS,
      SAMPLE_WINDOW_DAYS,
    ],
  );

  // ── per-post E, native ────────────────────────────────────────────────────
  // Lifetime counts per post (matching external semantics — the 48h window
  // belongs to hotness, not resonance). Gate passes exclude charged_back but
  // include free-allowance reads: a gate pass is an attention signal here,
  // money is a separate future axis (D8).
  await client.query(
    `
    INSERT INTO tmp_e (author_ref, protocol, post_type, published_at, item_ref, e)
    SELECT
      p.author_id::text, 'native', p.post_type, p.published_at, p.item_id,
      ${nativeEExpr("$1", "$2", "$3", "r")}
    FROM (
      SELECT a.writer_id AS author_id, 'article'::text AS post_type, a.published_at,
             a.nostr_event_id, a.id AS article_id, a.id AS item_id
      FROM articles a
      WHERE a.deleted_at IS NULL AND a.published_at IS NOT NULL
      UNION ALL
      SELECT n.author_id, 'note', n.published_at, n.nostr_event_id, NULL, n.id
      FROM notes n
      WHERE n.published_at IS NOT NULL
    ) p
    ${nativeEngagementJoins("r")}
    WHERE p.published_at < now() - make_interval(hours => $4)
      AND p.published_at > now() - make_interval(days => $5)
    `,
    [w.nativeUp, w.nativeGate, w.reply, BASELINE_MIN_AGE_HOURS, SAMPLE_WINDOW_DAYS],
  );

  // ── network ambient (D4 veto + D3 shrinkage prior) ────────────────────────
  const ambient = await client.query(
    `
    INSERT INTO protocol_engagement_ambient (protocol, post_type, p50_e, p90_e, sample_n, updated_at)
    SELECT protocol, post_type,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e),
           percentile_cont(0.9) WITHIN GROUP (ORDER BY e),
           COUNT(*), now()
    FROM tmp_e
    GROUP BY protocol, post_type
    ON CONFLICT (protocol, post_type) DO UPDATE SET
      p50_e = EXCLUDED.p50_e,
      p90_e = EXCLUDED.p90_e,
      sample_n = EXCLUDED.sample_n,
      updated_at = EXCLUDED.updated_at
    `,
  );

  // Pairs absent from this rebuild are DELETED, not left behind (§0i.9): a
  // protocol whose counts flag was toggled off otherwise keeps its last
  // percentiles forever, and the moment any count write recurs, scoring
  // re-arms against months-old medians. Absence is the honest signal the
  // scorer already understands (no ambient row ⇒ no ambient evidence ⇒ no
  // band), and a pair with live counts rebuilds on the next daily run.
  const ambientPruned = await client.query(
    `
    DELETE FROM protocol_engagement_ambient pea
    WHERE NOT EXISTS (
      SELECT 1 FROM tmp_e t
      WHERE t.protocol = pea.protocol AND t.post_type = pea.post_type
    )
    `,
  );

  // ── author baselines: median over last ≤20 qualifying posts ───────────────
  //
  // The ORDER BY must be TOTAL. `published_at` is not unique — two posts can
  // share a timestamp to the microsecond — so ranking on it alone leaves which
  // of a tied pair lands inside `rn <= 20` up to the plan, and an author with a
  // tie AT THE CUT gets a median that can differ between two runs over an
  // identical corpus. That is real non-determinism in the denominator every
  // resonance ratio is computed against, not a test artefact (§9.12).
  //
  // The tiebreak is the row's own id, and it is arbitrary ON PURPOSE.
  //   · `author_ref` is not a tiebreak at all — it is the partition key, so it
  //     is constant within every partition this ORDER BY runs in.
  //   · `e` is a tiebreak with a DIRECTION: preferring the higher-E post at a
  //     tie systematically lifts the sampled set, and this median is the
  //     expectation a surge is measured against — biasing it upward makes
  //     surges harder to register, quietly and everywhere.
  //   · No available column encodes ingest order. `external_items.id`,
  //     `articles.id` and `notes.id` are all uuid v4, so "the one we learned of
  //     later" is not a rule this data can express. They ARE all uuid, which is
  //     why `item_ref` is carried as uuid rather than text: uuid comparison is
  //     bytewise and collation-free, so the order does not shift with the
  //     database's locale.
  // What is left is the only property actually required: an order that is
  // total, stable across runs, and neutral in E.
  const baselines = await client.query(
    `
    WITH ranked AS (
      SELECT author_ref, protocol, post_type, e,
             row_number() OVER (
               PARTITION BY author_ref, protocol, post_type
               ORDER BY published_at DESC, item_ref DESC
             ) AS rn
      FROM tmp_e
    )
    INSERT INTO author_engagement_baseline (author_ref, protocol, post_type, median_e, n, updated_at)
    SELECT author_ref, protocol, post_type,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e),
           COUNT(*), now()
    FROM ranked
    WHERE rn <= $1
    GROUP BY author_ref, protocol, post_type
    ON CONFLICT (author_ref, protocol, post_type) DO UPDATE SET
      median_e = EXCLUDED.median_e,
      n = EXCLUDED.n,
      updated_at = EXCLUDED.updated_at
    `,
    [BASELINE_LAST_N],
  );

  // Authors with no qualifying posts in the window age out rather than pinning
  // a stale expectation forever. (Their items fall back to pure-ambient
  // scoring via n=0 shrinkage — same as a new author, which is what they are
  // again after 6 silent months.)
  const pruned = await client.query(
    `DELETE FROM author_engagement_baseline
     WHERE updated_at < now() - make_interval(days => $1)`,
    [STALE_BASELINE_DAYS],
  );

  logger.info(
    {
      ambientRows: ambient.rowCount,
      ambientPruned: ambientPruned.rowCount,
      authorBaselines: baselines.rowCount,
      prunedBaselines: pruned.rowCount,
      nostrIncluded: nostrEngagementCountsEnabled(),
    },
    "engagement baseline refresh complete",
  );
}
