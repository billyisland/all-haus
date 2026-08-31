import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { composePipStatus, type PipPolls } from '../lib/trust-pip.js'

// =============================================================================
// trust_layer1_refresh — daily computation of Layer 1 trust signals + pip
//
// Reads from accounts, articles, read_events, subscriptions, and trust_polls
// to produce per-user trust signals + the four-state pip glyph. Writes to
// trust_layer1.
//
// Slice 17 widened the pip from a three-state SQL-CASE on L1 only to a
// four-state composition (`known/partial/unknown/contested`) blending L1
// signals with three-question poll aggregates. The composition logic lives
// in feed-ingest/src/lib/trust-pip.ts as a pure function — this task does
// the I/O (fetch L1, fetch poll aggregates, compose, upsert).
//
// Two-step query: a SQL pass computes L1 signals + carries poll aggregates
// per user (LEFT JOIN to a grouped view of trust_polls), then JS calls
// composePipStatus() per row. The second pass is a single multi-row UPDATE
// via UNNEST so we still write all users in one round-trip.
//
// Slice 18 adds the encounter signal — count of non-withdrawn `vouches` rows
// where `dimension = 'encounter'` and `value = 'affirm'`. Aggregate count
// only (visibility doesn't matter for the pip composition; the panel's
// surface decision about whether to show attestor identity belongs to the
// /trust/:userId route, which already filters on visibility = 'public').
// =============================================================================

interface RefreshRow {
  user_id: string
  account_age_days: number
  paying_reader_count: number
  article_count: number
  payment_verified: boolean
  nip05_verified: boolean
  encounter_count: number
  poll_humanity_yes: number
  poll_humanity_no: number
  poll_authenticity_yes: number
  poll_authenticity_no: number
  poll_good_faith_yes: number
  poll_good_faith_no: number
}

export const trustLayer1Refresh: Task = async () => {
  const { rows } = await pool.query<RefreshRow>(
    `
    WITH writer_stats AS (
      SELECT writer_id, COUNT(*)::int AS article_count
      FROM articles
      WHERE deleted_at IS NULL
      GROUP BY writer_id
    ),
    paying_readers AS (
      SELECT writer_id, COUNT(DISTINCT reader_id)::int AS paying_reader_count
      FROM read_events
      WHERE state IN ('accrued', 'platform_settled', 'writer_paid')
      GROUP BY writer_id
    ),
    poll_aggregates AS (
      -- Aggregate poll responses per (subject, question, answer). Pivot to
      -- six counts per subject so the outer SELECT can carry them in a flat
      -- shape the JS composer consumes.
      SELECT
        subject_id AS user_id,
        SUM(CASE WHEN question = 'humanity'     AND answer = 'yes' THEN 1 ELSE 0 END)::int AS poll_humanity_yes,
        SUM(CASE WHEN question = 'humanity'     AND answer = 'no'  THEN 1 ELSE 0 END)::int AS poll_humanity_no,
        SUM(CASE WHEN question = 'authenticity' AND answer = 'yes' THEN 1 ELSE 0 END)::int AS poll_authenticity_yes,
        SUM(CASE WHEN question = 'authenticity' AND answer = 'no'  THEN 1 ELSE 0 END)::int AS poll_authenticity_no,
        SUM(CASE WHEN question = 'good_faith'   AND answer = 'yes' THEN 1 ELSE 0 END)::int AS poll_good_faith_yes,
        SUM(CASE WHEN question = 'good_faith'   AND answer = 'no'  THEN 1 ELSE 0 END)::int AS poll_good_faith_no
      FROM trust_polls
      GROUP BY subject_id
    ),
    encounter_aggregates AS (
      -- Slice 18: encounter affirms — the "I've met this person" gesture. The
      -- pip composer treats ≥1 as an L1 anchor and ≥2 as strong-on-its-own.
      -- Visibility doesn't matter for the count (panel surface filters on
      -- public separately); contests would be aggregate-only by route rule
      -- and don't unlock anchor — only affirms.
      SELECT subject_id AS user_id, COUNT(*)::int AS encounter_count
      FROM vouches
      WHERE dimension = 'encounter'
        AND value = 'affirm'
        AND withdrawn_at IS NULL
      GROUP BY subject_id
    )
    SELECT
      a.id AS user_id,
      EXTRACT(DAY FROM now() - a.created_at)::int AS account_age_days,
      COALESCE(pr.paying_reader_count, 0)        AS paying_reader_count,
      COALESCE(ws.article_count, 0)              AS article_count,
      (a.stripe_connect_id IS NOT NULL AND a.stripe_connect_kyc_complete) AS payment_verified,
      FALSE                                       AS nip05_verified,
      COALESCE(ea.encounter_count, 0)            AS encounter_count,
      COALESCE(pa.poll_humanity_yes, 0)          AS poll_humanity_yes,
      COALESCE(pa.poll_humanity_no, 0)           AS poll_humanity_no,
      COALESCE(pa.poll_authenticity_yes, 0)      AS poll_authenticity_yes,
      COALESCE(pa.poll_authenticity_no, 0)       AS poll_authenticity_no,
      COALESCE(pa.poll_good_faith_yes, 0)        AS poll_good_faith_yes,
      COALESCE(pa.poll_good_faith_no, 0)         AS poll_good_faith_no
    FROM accounts a
    LEFT JOIN writer_stats ws         ON ws.writer_id = a.id
    LEFT JOIN paying_readers pr       ON pr.writer_id = a.id
    LEFT JOIN poll_aggregates pa      ON pa.user_id   = a.id
    LEFT JOIN encounter_aggregates ea ON ea.user_id   = a.id
    `,
  )

  // Compose pip status per row in JS — keeps the threshold logic in one
  // place (the trust-pip.ts pure function) rather than splitting it between
  // SQL CASE and any future tweaks.
  const composed = rows.map((r) => {
    const polls: PipPolls = {
      humanity:     { yes: r.poll_humanity_yes,     no: r.poll_humanity_no },
      authenticity: { yes: r.poll_authenticity_yes, no: r.poll_authenticity_no },
      good_faith:   { yes: r.poll_good_faith_yes,   no: r.poll_good_faith_no },
    }
    const pipStatus = composePipStatus({
      layer1: {
        accountAgeDays:     r.account_age_days,
        payingReaderCount:  r.paying_reader_count,
        articleCount:       r.article_count,
        paymentVerified:    r.payment_verified,
        nip05Verified:      r.nip05_verified,
        encounterCount:     r.encounter_count,
      },
      polls,
    })
    return { ...r, pip_status: pipStatus }
  })

  if (composed.length === 0) {
    logger.info({ upserted: 0 }, 'trust_layer1 refreshed (no accounts)')
    return
  }

  // Bulk upsert via UNNEST — one round-trip rather than N. Arrays are
  // positionally aligned across columns; pg's typed array params handle the
  // serialisation.
  const result = await pool.query(
    `
    INSERT INTO trust_layer1 (user_id, account_age_days, paying_reader_count,
                              article_count, payment_verified, nip05_verified,
                              pip_status, computed_at)
    SELECT
      user_id::uuid, age::int, paying::int, articles::int,
      payment::boolean, nip05::boolean, pip::text, now()
    FROM unnest(
      $1::uuid[], $2::int[], $3::int[], $4::int[],
      $5::boolean[], $6::boolean[], $7::text[]
    ) AS u(user_id, age, paying, articles, payment, nip05, pip)
    ON CONFLICT (user_id) DO UPDATE SET
      account_age_days     = EXCLUDED.account_age_days,
      paying_reader_count  = EXCLUDED.paying_reader_count,
      article_count        = EXCLUDED.article_count,
      payment_verified     = EXCLUDED.payment_verified,
      nip05_verified       = EXCLUDED.nip05_verified,
      pip_status           = EXCLUDED.pip_status,
      computed_at          = EXCLUDED.computed_at
    `,
    [
      composed.map((r) => r.user_id),
      composed.map((r) => r.account_age_days),
      composed.map((r) => r.paying_reader_count),
      composed.map((r) => r.article_count),
      composed.map((r) => r.payment_verified),
      composed.map((r) => r.nip05_verified),
      composed.map((r) => r.pip_status),
    ],
  )

  logger.info({ upserted: result.rowCount }, 'trust_layer1 refreshed')
}
