import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { loadResonanceParams, updateNativeResonance } from '../lib/resonance.js'

// =============================================================================
// feed_scores_refresh — HN-style gravity scoring for feed_items
//
// Reads engagement from feed_engagement (last 48 hours), computes a
// time-decayed score per content item, and writes to feed_items.score.
// Also maintains the legacy feed_scores table for backwards compatibility.
// =============================================================================

interface FeedWeights {
  gravity: number
  reaction: number
  reply: number
  quoteComment: number
  gatePass: number
}

async function loadFeedWeights(): Promise<FeedWeights> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_config WHERE key LIKE 'feed_%'`
  )
  const map = new Map(rows.map(r => [r.key, r.value]))
  return {
    gravity: parseFloat(map.get('feed_gravity') ?? '1.5'),
    reaction: parseFloat(map.get('feed_weight_reaction') ?? '1'),
    reply: parseFloat(map.get('feed_weight_reply') ?? '2'),
    quoteComment: parseFloat(map.get('feed_weight_quote_comment') ?? '3'),
    gatePass: parseFloat(map.get('feed_weight_gate_pass') ?? '5'),
  }
}

export const feedScoresRefresh: Task = async () => {
  const weights = await loadFeedWeights()

  const result = await pool.query(
    `
    WITH engagement_counts AS (
      SELECT
        target_nostr_event_id,
        COUNT(*) FILTER (WHERE engagement_type = 'reaction')      AS reactions,
        COUNT(*) FILTER (WHERE engagement_type = 'reply')          AS replies,
        COUNT(*) FILTER (WHERE engagement_type = 'quote_comment')  AS quotes,
        COUNT(*) FILTER (WHERE engagement_type = 'gate_pass')      AS gate_passes
      FROM feed_engagement
      WHERE engaged_at > now() - interval '48 hours'
      GROUP BY target_nostr_event_id
    ),
    scored AS (
      SELECT
        fi.id AS feed_item_id,
        (ec.reactions * $1 + ec.replies * $2 + ec.quotes * $3 + ec.gate_passes * $4)
          / POWER(GREATEST(EXTRACT(EPOCH FROM (now() - fi.published_at)) / 3600, 0) + 2, $5)
          AS score
      FROM engagement_counts ec
      JOIN feed_items fi ON fi.nostr_event_id = ec.target_nostr_event_id
        AND fi.deleted_at IS NULL
    )
    UPDATE feed_items fi SET score = scored.score
    FROM scored WHERE fi.id = scored.feed_item_id
    `,
    [weights.reaction, weights.reply, weights.quoteComment, weights.gatePass, weights.gravity]
  )

  await pool.query(
    `
    WITH engagement_counts AS (
      SELECT
        target_nostr_event_id,
        target_author_id,
        COUNT(*) FILTER (WHERE engagement_type = 'reaction')      AS reactions,
        COUNT(*) FILTER (WHERE engagement_type = 'reply')          AS replies,
        COUNT(*) FILTER (WHERE engagement_type = 'quote_comment')  AS quotes,
        COUNT(*) FILTER (WHERE engagement_type = 'gate_pass')      AS gate_passes
      FROM feed_engagement
      WHERE engaged_at > now() - interval '48 hours'
      GROUP BY target_nostr_event_id, target_author_id
    ),
    scored AS (
      SELECT
        ec.target_nostr_event_id AS nostr_event_id,
        ec.target_author_id AS author_id,
        COALESCE(a.published_at, n.published_at) AS published_at,
        CASE WHEN a.id IS NOT NULL THEN 'article'::content_type ELSE 'note'::content_type END AS content_type,
        a.publication_id,
        (ec.reactions * $1 + ec.replies * $2 + ec.quotes * $3 + ec.gate_passes * $4)
          / POWER(GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(a.published_at, n.published_at))) / 3600, 0) + 2, $5)
          AS score,
        (ec.reactions + ec.replies + ec.quotes + ec.gate_passes)::int AS engagement_count,
        ec.gate_passes::int AS gate_pass_count
      FROM engagement_counts ec
      LEFT JOIN articles a ON a.nostr_event_id = ec.target_nostr_event_id AND a.deleted_at IS NULL
      LEFT JOIN notes n ON n.nostr_event_id = ec.target_nostr_event_id
      WHERE COALESCE(a.published_at, n.published_at) IS NOT NULL
    )
    INSERT INTO feed_scores (nostr_event_id, author_id, content_type, publication_id, score, engagement_count, gate_pass_count, published_at, scored_at)
    SELECT nostr_event_id, author_id, content_type, publication_id, score, engagement_count, gate_pass_count, published_at, now()
    FROM scored
    ON CONFLICT (nostr_event_id) DO UPDATE SET
      score = EXCLUDED.score,
      engagement_count = EXCLUDED.engagement_count,
      gate_pass_count = EXCLUDED.gate_pass_count,
      publication_id = EXCLUDED.publication_id,
      scored_at = EXCLUDED.scored_at
    `,
    [weights.reaction, weights.reply, weights.quoteComment, weights.gatePass, weights.gravity]
  )

  await pool.query(
    `DELETE FROM feed_scores WHERE published_at < now() - interval '7 days' AND score < 0.1`
  )

  await pool.query(
    `UPDATE feed_items SET score = 0
     WHERE score > 0
       AND published_at < now() - interval '7 days'
       AND nostr_event_id NOT IN (
         SELECT target_nostr_event_id FROM feed_engagement
         WHERE engaged_at > now() - interval '48 hours'
       )`
  )

  // Native resonance (SOCIAL-PROOF-RESONANCE-ADR D5). Distinct from the score
  // above in every respect — lifetime not 48h, D2a source tables not the
  // reply-only feed_engagement mirror, resonance_* weights not feed_weight_* —
  // so it is a separate pass that happens to share this cron's cadence, not an
  // extension of the gravity query. Non-fatal: hotness must still refresh if
  // the resonance pass trips.
  let resonanceRows = 0
  try {
    resonanceRows = await updateNativeResonance(await loadResonanceParams())
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'native resonance recompute failed'
    )
  }

  logger.info({ updated: result.rowCount, resonanceRows }, 'Feed scores refreshed')
}
