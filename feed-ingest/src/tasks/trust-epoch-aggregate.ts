import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { attestorWeight } from "../lib/trust-weighting.js";
import {
  computeDimensionScore,
  type VouchForScoring,
} from "../lib/trust-aggregation.js";

// =============================================================================
// trust_epoch_aggregate — turns raw vouches into trust_profiles dimension scores
//
// Two schedules:
//   Full epoch:  quarterly (1 Jan, 1 Apr, 1 Jul, 1 Oct) at 02:00 UTC
//   Mop-up:      Mon/Thu at 02:00 UTC
//
// Full epochs increment decay counters and score all subjects.
// Mop-ups score subjects with <10 attestations (always) plus subjects
// with >=5 changes since last run (threshold gate).
//
// Dry-run: TRUST_DRY_RUN=1 or payload { dryRun: true } — logs diffs, no writes.
// See docs/adr/ALLHAUS-OMNIBUS.md §II.8 + §IV.7 Build Phase 4.
// =============================================================================

const DIMENSIONS = ["humanity", "encounter", "identity", "integrity"] as const;
const MOPUP_THRESHOLD = 5; // out-of-cycle changes needed to trigger re-score for mature subjects

function currentEpochId(): string {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}-Q${q}`;
}

function isQuarterlyBoundary(): boolean {
  const now = new Date();
  return now.getDate() === 1 && [0, 3, 6, 9].includes(now.getMonth());
}

export const trustEpochAggregate: Task = async (_payload, _helpers) => {
  const payload = (_payload ?? {}) as {
    dryRun?: boolean;
    forceType?: "full" | "mopup";
  };
  const dryRun = payload.dryRun || process.env.TRUST_DRY_RUN === "1";
  const runType =
    payload.forceType ?? (isQuarterlyBoundary() ? "full" : "mopup");
  const epochId =
    runType === "full"
      ? currentEpochId()
      : `mopup-${new Date().toISOString().slice(0, 10)}`;

  logger.info({ runType, epochId, dryRun }, "trust_epoch_aggregate starting");

  // -------------------------------------------------------------------------
  // Step 1: For full epochs, increment decay counters
  // -------------------------------------------------------------------------
  if (runType === "full" && !dryRun) {
    const { rowCount } = await pool.query(
      `UPDATE vouches
       SET epochs_since_reaffirm = epochs_since_reaffirm + 1
       WHERE withdrawn_at IS NULL`,
    );
    logger.info(
      { decayed: rowCount },
      "Incremented epochs_since_reaffirm for full epoch",
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: Identify subjects to score
  // -------------------------------------------------------------------------
  let subjectIds: string[];

  if (runType === "full") {
    // Full epoch: all subjects with any active vouches
    const { rows } = await pool.query(
      `SELECT DISTINCT subject_id FROM vouches WHERE withdrawn_at IS NULL`,
    );
    subjectIds = rows.map((r: { subject_id: string }) => r.subject_id);
  } else {
    // Mop-up: subjects with <10 attestations (always) + subjects with
    // >=MOPUP_THRESHOLD changes since last mop-up run
    const lastRun = await pool.query(
      `SELECT started_at FROM trust_epochs
       WHERE type IN ('full', 'mopup')
       ORDER BY started_at DESC LIMIT 1`,
    );
    const since = lastRun.rows[0]?.started_at ?? new Date(0);

    const { rows } = await pool.query(
      `SELECT subject_id, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE created_at > $1 OR last_reaffirmed_at > $1) AS recent_changes
       FROM vouches
       WHERE withdrawn_at IS NULL
       GROUP BY subject_id
       HAVING COUNT(*) < 10
          OR COUNT(*) FILTER (WHERE created_at > $1 OR last_reaffirmed_at > $1) >= $2`,
      [since, MOPUP_THRESHOLD],
    );
    subjectIds = rows.map((r: { subject_id: string }) => r.subject_id);
  }

  if (subjectIds.length === 0) {
    logger.info({ runType, epochId }, "No subjects to score");
    if (!dryRun) {
      await pool.query(
        `INSERT INTO trust_epochs (epoch_id, started_at, type) VALUES ($1, now(), $2)
         ON CONFLICT (epoch_id) DO UPDATE SET started_at = now(), type = $2`,
        [epochId, runType],
      );
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Step 3: Fetch all vouches + attestor Layer 1 data for identified subjects
  // -------------------------------------------------------------------------
  const { rows: vouchRows } = await pool.query(
    `SELECT v.subject_id, v.dimension, v.value, v.epochs_since_reaffirm,
            t.account_age_days, t.paying_reader_count, t.article_count, t.payment_verified
     FROM vouches v
     JOIN trust_layer1 t ON t.user_id = v.attestor_id
     WHERE v.withdrawn_at IS NULL
       AND v.subject_id = ANY($1)
     ORDER BY v.subject_id, v.dimension`,
    [subjectIds],
  );

  // Also need total active vouch count per subject for decay protection
  const { rows: countRows } = await pool.query(
    `SELECT subject_id, COUNT(*)::int AS total
     FROM vouches
     WHERE withdrawn_at IS NULL AND subject_id = ANY($1)
     GROUP BY subject_id`,
    [subjectIds],
  );
  const totalBySubject = new Map<string, number>(
    countRows.map((r: { subject_id: string; total: number }) => [
      r.subject_id,
      r.total,
    ]),
  );

  // -------------------------------------------------------------------------
  // Step 4: Compute scores per subject/dimension
  // -------------------------------------------------------------------------
  interface ScoreResult {
    userId: string;
    dimension: string;
    score: number;
    attestationCount: number;
  }

  const results: ScoreResult[] = [];

  interface VouchRow {
    subject_id: string;
    dimension: string;
    value: string;
    epochs_since_reaffirm: number;
    account_age_days: number;
    paying_reader_count: number;
    article_count: number;
    payment_verified: boolean;
  }

  // Group vouches by subject_id + dimension
  const grouped = new Map<string, VouchRow[]>();
  for (const row of vouchRows as VouchRow[]) {
    const key = `${row.subject_id}:${row.dimension}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  for (const subjectId of subjectIds) {
    const activeTotal = totalBySubject.get(subjectId) ?? 0;

    for (const dim of DIMENSIONS) {
      const key = `${subjectId}:${dim}`;
      const dimVouches = grouped.get(key) ?? [];

      const forScoring: VouchForScoring[] = dimVouches.map((v) => ({
        value: v.value as "affirm" | "contest",
        attestorWeight: attestorWeight({
          accountAgeDays: v.account_age_days,
          paymentVerified: v.payment_verified,
          payingReaderCount: v.paying_reader_count,
          articleCount: v.article_count,
        }),
        epochsSinceReaffirm: v.epochs_since_reaffirm,
      }));

      const score = computeDimensionScore(forScoring, activeTotal);

      results.push({
        userId: subjectId,
        dimension: dim,
        score,
        attestationCount: dimVouches.length,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Compute monitoring stats
  // -------------------------------------------------------------------------
  // Fetch current scores for delta comparison
  const { rows: currentScores } = await pool.query(
    `SELECT user_id, dimension, score FROM trust_profiles WHERE user_id = ANY($1)`,
    [subjectIds],
  );
  const currentMap = new Map<string, number>(
    currentScores.map(
      (r: { user_id: string; dimension: string; score: string }) => [
        `${r.user_id}:${r.dimension}`,
        parseFloat(r.score),
      ],
    ),
  );

  let largestDelta = 0;
  let anomalyCount = 0;
  for (const r of results) {
    const prev = currentMap.get(`${r.userId}:${r.dimension}`) ?? 0;
    const delta = Math.abs(r.score - prev);
    if (delta > largestDelta) largestDelta = delta;
    if (delta > 0.2) anomalyCount++;
  }

  logger.info(
    {
      runType,
      epochId,
      dryRun,
      subjectsScored: subjectIds.length,
      profilesComputed: results.length,
      largestDelta: Math.round(largestDelta * 1000) / 1000,
      anomalyCount,
    },
    "trust_epoch_aggregate scoring complete",
  );

  if (dryRun) {
    // Log the top diffs
    const diffs = results
      .map((r) => ({
        ...r,
        prevScore: currentMap.get(`${r.userId}:${r.dimension}`) ?? 0,
        delta: Math.abs(
          r.score - (currentMap.get(`${r.userId}:${r.dimension}`) ?? 0),
        ),
      }))
      .filter((d) => d.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 20);

    if (diffs.length > 0) {
      logger.info({ diffs }, "trust_epoch_aggregate dry-run diffs (top 20)");
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Step 6: Write results
  // -------------------------------------------------------------------------
  // Batch upsert trust_profiles
  if (results.length > 0) {
    const values: any[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const r of results) {
      placeholders.push(
        `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, now())`,
      );
      values.push(r.userId, r.dimension, r.score, r.attestationCount, epochId);
      idx += 5;
    }

    await pool.query(
      `INSERT INTO trust_profiles (user_id, dimension, score, attestation_count, epoch, updated_at)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (user_id, dimension) DO UPDATE SET
         score = EXCLUDED.score,
         attestation_count = EXCLUDED.attestation_count,
         epoch = EXCLUDED.epoch,
         updated_at = EXCLUDED.updated_at`,
      values,
    );
  }

  // Record epoch run
  await pool.query(
    `INSERT INTO trust_epochs (epoch_id, started_at, type) VALUES ($1, now(), $2)
     ON CONFLICT (epoch_id) DO UPDATE SET started_at = now(), type = $2`,
    [epochId, runType],
  );

  logger.info(
    { runType, epochId, upserted: results.length },
    "trust_epoch_aggregate complete",
  );
};
