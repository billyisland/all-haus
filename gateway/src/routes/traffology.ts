import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/auth.js'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Traffology routes — writer analytics API
//
// All routes are authenticated: only writers can see their own data.
//
// Concurrent reader counts:
//   GET /traffology/concurrent/:pieceId
//   GET /traffology/concurrent
//
// Feed & piece detail:
//   GET /traffology/feed         — paginated observations for the writer
//   GET /traffology/piece/:pieceId — piece stats + sources + observations
//   GET /traffology/overview     — publication-level summary
// =============================================================================

const INGEST_URL = process.env.TRAFFOLOGY_INGEST_URL ?? 'http://localhost:3005'

export async function traffologyRoutes(app: FastifyInstance) {
  // GET /traffology/concurrent/:pieceId — live reader count for a single piece
  app.get<{ Params: { pieceId: string } }>(
    '/traffology/concurrent/:pieceId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { pieceId } = req.params
      const writerId = req.session!.sub

      const { rows } = await pool.query(
        'SELECT 1 FROM traffology.pieces WHERE id = $1 AND writer_id = $2',
        [pieceId, writerId],
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Piece not found' })
      }

      try {
        const res = await fetch(`${INGEST_URL}/concurrent/${pieceId}`)
        if (!res.ok) {
          return reply.status(502).send({ error: 'Ingest service unavailable' })
        }
        return reply.send(await res.json())
      } catch (err) {
        logger.error({ err }, 'Failed to query traffology-ingest')
        return reply.status(502).send({ error: 'Ingest service unavailable' })
      }
    },
  )

  // GET /traffology/concurrent — live counts for all pieces by the authenticated writer
  app.get(
    '/traffology/concurrent',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      try {
        const res = await fetch(`${INGEST_URL}/concurrent/writer/${writerId}`)
        if (!res.ok) {
          return reply.status(502).send({ error: 'Ingest service unavailable' })
        }
        return reply.send(await res.json())
      } catch (err) {
        logger.error({ err }, 'Failed to query traffology-ingest')
        return reply.status(502).send({ error: 'Ingest service unavailable' })
      }
    },
  )

  // ===========================================================================
  // GET /traffology/feed — paginated observation stream
  // ===========================================================================
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    '/traffology/feed',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50)
      const cursor = req.query.cursor // ISO timestamp

      const { rows: observations } = await pool.query(
        `SELECT
           o.id, o.piece_id, o.observation_type, o.priority,
           o.values, o.created_at,
           p.title AS piece_title, p.article_id
         FROM traffology.observations o
         LEFT JOIN traffology.pieces p ON p.id = o.piece_id
         WHERE o.writer_id = $1
           AND o.suppressed = FALSE
           ${cursor ? 'AND o.created_at < $3' : ''}
         ORDER BY o.created_at DESC
         LIMIT $2`,
        cursor ? [writerId, limit, cursor] : [writerId, limit],
      )

      const nextCursor = observations.length === limit
        ? observations[observations.length - 1].created_at
        : null

      return reply.send({ observations, nextCursor })
    },
  )

  // ===========================================================================
  // GET /traffology/piece/:pieceId — piece detail
  // ===========================================================================
  app.get<{ Params: { pieceId: string } }>(
    '/traffology/piece/:pieceId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { pieceId } = req.params
      const writerId = req.session!.sub

      // Piece info + stats
      const { rows: [piece] } = await pool.query(
        `SELECT
           p.id, p.title, p.article_id, p.published_at, p.word_count, p.tags,
           ps.total_readers, ps.readers_today, ps.first_day_readers,
           ps.unique_countries, ps.avg_reading_time_seconds, ps.avg_scroll_depth,
           ps.rank_this_year, ps.rank_all_time,
           ps.top_source_pct, ps.free_conversions, ps.paid_conversions,
           ps.last_reader_at,
           src.display_name AS top_source_name
         FROM traffology.pieces p
         LEFT JOIN traffology.piece_stats ps ON ps.piece_id = p.id
         LEFT JOIN traffology.sources src ON src.id = ps.top_source_id
         WHERE p.id = $1 AND p.writer_id = $2`,
        [pieceId, writerId],
      )
      if (!piece) {
        return reply.status(404).send({ error: 'Piece not found' })
      }

      // Source stats with half-day buckets
      const { rows: sources } = await pool.query(
        `SELECT
           ss.source_id, src.display_name, src.source_type, src.is_new_for_writer,
           ss.reader_count, ss.pct_of_total, ss.first_reader_at, ss.last_reader_at,
           ss.avg_reading_time_seconds, ss.avg_scroll_depth, ss.bounce_rate
         FROM traffology.source_stats ss
         JOIN traffology.sources src ON src.id = ss.source_id
         WHERE ss.piece_id = $1
         ORDER BY ss.reader_count DESC`,
        [pieceId],
      )

      // Half-day buckets for provenance bars
      const { rows: buckets } = await pool.query(
        `SELECT source_id, bucket_start, is_day, reader_count
         FROM traffology.half_day_buckets
         WHERE piece_id = $1
         ORDER BY bucket_start DESC`,
        [pieceId],
      )

      // Group buckets by source
      const bucketsBySource: Record<string, typeof buckets> = {}
      for (const b of buckets) {
        const sid = b.source_id
        if (!bucketsBySource[sid]) bucketsBySource[sid] = []
        bucketsBySource[sid].push(b)
      }

      // Observations for this piece
      const { rows: observations } = await pool.query(
        `SELECT id, observation_type, priority, values, created_at
         FROM traffology.observations
         WHERE piece_id = $1 AND writer_id = $2 AND suppressed = FALSE
         ORDER BY created_at DESC
         LIMIT 30`,
        [pieceId, writerId],
      )

      return reply.send({
        piece,
        sources: sources.map(s => ({
          ...s,
          buckets: bucketsBySource[s.source_id] ?? [],
        })),
        observations,
      })
    },
  )

  // ===========================================================================
  // GET /traffology/overview — publication-level summary
  // ===========================================================================
  app.get(
    '/traffology/overview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      // Writer baseline
      const { rows: [baseline] } = await pool.query(
        `SELECT * FROM traffology.writer_baselines WHERE writer_id = $1`,
        [writerId],
      )

      // All pieces with stats, sorted by published_at desc
      const { rows: pieces } = await pool.query(
        `SELECT
           p.id, p.title, p.article_id, p.published_at, p.tags,
           ps.total_readers, ps.first_day_readers,
           ps.avg_reading_time_seconds, ps.avg_scroll_depth,
           ps.rank_this_year, ps.rank_all_time,
           ps.top_source_pct, ps.free_conversions, ps.paid_conversions,
           src.display_name AS top_source_name
         FROM traffology.pieces p
         LEFT JOIN traffology.piece_stats ps ON ps.piece_id = p.id
         LEFT JOIN traffology.sources src ON src.id = ps.top_source_id
         WHERE p.writer_id = $1
         ORDER BY p.published_at DESC NULLS LAST`,
        [writerId],
      )

      // Miniature half-day buckets for each piece (for overview grid)
      const pieceIds = pieces.map(p => p.id)
      const bucketsByPiece: Record<string, any[]> = {}
      if (pieceIds.length > 0) {
        const { rows: allBuckets } = await pool.query(
          `SELECT piece_id, source_id, bucket_start, is_day, reader_count
           FROM traffology.half_day_buckets
           WHERE piece_id = ANY($1)
           ORDER BY bucket_start DESC`,
          [pieceIds],
        )
        for (const b of allBuckets) {
          if (!bucketsByPiece[b.piece_id]) bucketsByPiece[b.piece_id] = []
          bucketsByPiece[b.piece_id].push(b)
        }
      }

      // Topic performance
      const { rows: topics } = await pool.query(
        `SELECT * FROM traffology.topic_performance
         WHERE writer_id = $1
         ORDER BY mean_readers DESC`,
        [writerId],
      )

      return reply.send({
        baseline: baseline ?? null,
        pieces: pieces.map(p => ({
          ...p,
          buckets: bucketsByPiece[p.id] ?? [],
        })),
        topics,
      })
    },
  )
}
