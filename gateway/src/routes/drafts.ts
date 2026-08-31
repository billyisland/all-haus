import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Draft Routes
//
// POST   /drafts              — Save or update a draft
// GET    /drafts              — List writer's drafts
// GET    /drafts/:id          — Load a single draft
// DELETE /drafts/:id          — Delete a draft
// POST   /drafts/:id/schedule — Schedule a draft for future publication
// DELETE /drafts/:id/schedule — Unschedule a draft
//
// Drafts are stored in the article_drafts table. Row targeting, in priority
// order: an explicit draftId (the editor echoes back the id it was given, so
// saves always land on the row being edited), else the (writer, dTag) upsert
// (edits of published articles), else the writer's most recent untagged draft
// — that guess exists only for the very first save of a new article, and runs
// under a per-writer advisory lock so two concurrent first saves (debounced
// autosave racing the explicit Save click) can't both INSERT. The duplicate
// row that race minted was the "draft + published, both in the dashboard" bug.
// =============================================================================

const SaveDraftSchema = z.object({
  title: z.string().max(500).optional(),
  dek: z.string().max(1000).optional(),   // standfirst/summary — was silently dropped (M20)
  content: z.string().optional(),
  gatePositionPct: z.number().int().min(0).max(100).optional(),
  pricePence: z.number().int().min(0).optional(),
  draftId: z.string().uuid().optional(),  // echo of a previous save's draftId — targets that exact row
  dTag: z.string().optional(),   // set when editing an existing published article
  publicationId: z.string().uuid().optional(),  // set when writing in publication context
  coverImageUrl: z.string().url().nullable().optional(),
  commentsEnabled: z.boolean().optional(),  // "allow replies" toggle (M19 scheduled path)
})

export async function draftRoutes(app: FastifyInstance) {

  // POST /drafts — upsert a draft
  app.post('/drafts', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SaveDraftSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const writerId = req.session!.sub
    const data = parsed.data

    try {
      // Explicit draftId: update that exact row (writer-scoped). If the row is
      // gone (published & cleaned up, or deleted in another tab) fall through
      // to the create paths below so no content is lost.
      if (data.draftId) {
        const result = await pool.query<{ id: string; auto_saved_at: string }>(
          `UPDATE article_drafts
           SET title = COALESCE($1, title),
               content_raw = COALESCE($2, content_raw),
               gate_position_pct = COALESCE($3, gate_position_pct),
               price_pence = COALESCE($4, price_pence),
               publication_id = COALESCE($5, publication_id),
               cover_image_url = COALESCE($6, cover_image_url),
               dek = COALESCE($7, dek),
               comments_enabled = COALESCE($8, comments_enabled),
               auto_saved_at = now()
           WHERE id = $9 AND writer_id = $10
           RETURNING id, auto_saved_at`,
          [data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, data.publicationId ?? null, data.coverImageUrl ?? null, data.dek ?? null, data.commentsEnabled ?? null, data.draftId, writerId]
        )

        if (result.rows.length > 0) {
          return reply.status(200).send({
            draftId: result.rows[0].id,
            autoSavedAt: result.rows[0].auto_saved_at,
          })
        }
      }

      // If we have a dTag, upsert by (writer_id, nostr_d_tag)
      // Otherwise create a new draft row
      if (data.dTag) {
        const result = await pool.query<{ id: string; auto_saved_at: string }>(
          `INSERT INTO article_drafts (writer_id, nostr_d_tag, title, content_raw, gate_position_pct, price_pence, publication_id, cover_image_url, dek, comments_enabled, auto_saved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           ON CONFLICT (writer_id, nostr_d_tag) WHERE nostr_d_tag IS NOT NULL
           DO UPDATE SET
             title = COALESCE(EXCLUDED.title, article_drafts.title),
             content_raw = COALESCE(EXCLUDED.content_raw, article_drafts.content_raw),
             gate_position_pct = COALESCE(EXCLUDED.gate_position_pct, article_drafts.gate_position_pct),
             price_pence = COALESCE(EXCLUDED.price_pence, article_drafts.price_pence),
             publication_id = COALESCE(EXCLUDED.publication_id, article_drafts.publication_id),
             cover_image_url = COALESCE(EXCLUDED.cover_image_url, article_drafts.cover_image_url),
             dek = COALESCE(EXCLUDED.dek, article_drafts.dek),
             comments_enabled = COALESCE(EXCLUDED.comments_enabled, article_drafts.comments_enabled),
             auto_saved_at = now()
           RETURNING id, auto_saved_at`,
          [writerId, data.dTag, data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, data.publicationId ?? null, data.coverImageUrl ?? null, data.dek ?? null, data.commentsEnabled ?? null]
        )

        return reply.status(200).send({
          draftId: result.rows[0].id,
          autoSavedAt: result.rows[0].auto_saved_at,
        })
      } else {
        // First save of a new article (no draftId learned yet, no dTag).
        // Serialise per writer: without the lock, a debounced autosave racing
        // the explicit Save both read "no draft" and both INSERT — the
        // duplicate-draft bug. Under the lock the loser sees the winner's row.
        const { row, created } = await withTransaction(async (client) => {
          await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
            `draft_new:${writerId}`,
          ])

          // scheduled_at IS NULL: a scheduled draft is a waiting publication,
          // never a guess target — without the filter, scheduling article A
          // then starting article B let B's first autosave overwrite A's
          // waiting draft (the scheduler would then publish B in A's slot).
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM article_drafts
             WHERE writer_id = $1 AND nostr_d_tag IS NULL AND scheduled_at IS NULL
             ORDER BY auto_saved_at DESC LIMIT 1`,
            [writerId]
          )

          if (existing.rows.length > 0) {
            const result = await client.query<{ id: string; auto_saved_at: string }>(
              `UPDATE article_drafts
               SET title = COALESCE($1, title),
                   content_raw = COALESCE($2, content_raw),
                   gate_position_pct = COALESCE($3, gate_position_pct),
                   price_pence = COALESCE($4, price_pence),
                   cover_image_url = COALESCE($5, cover_image_url),
                   dek = COALESCE($6, dek),
                   comments_enabled = COALESCE($7, comments_enabled),
                   auto_saved_at = now()
               WHERE id = $8
               RETURNING id, auto_saved_at`,
              [data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, data.coverImageUrl ?? null, data.dek ?? null, data.commentsEnabled ?? null, existing.rows[0].id]
            )
            return { row: result.rows[0], created: false }
          }

          const result = await client.query<{ id: string; auto_saved_at: string }>(
            `INSERT INTO article_drafts (writer_id, title, content_raw, gate_position_pct, price_pence, publication_id, cover_image_url, dek, comments_enabled, auto_saved_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
             RETURNING id, auto_saved_at`,
            [writerId, data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, data.publicationId ?? null, data.coverImageUrl ?? null, data.dek ?? null, data.commentsEnabled ?? null]
          )
          return { row: result.rows[0], created: true }
        })

        return reply.status(created ? 201 : 200).send({
          draftId: row.id,
          autoSavedAt: row.auto_saved_at,
        })
      }
    } catch (err) {
      logger.error({ err, writerId }, 'Draft save failed')
      return reply.status(500).send({ error: 'Draft save failed' })
    }
  })

  // GET /drafts — list writer's drafts
  app.get('/drafts', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub

    const { rows } = await pool.query<{
      id: string
      title: string | null
      nostr_d_tag: string | null
      publication_id: string | null
      auto_saved_at: string
      scheduled_at: string | null
    }>(
      `SELECT id, title, nostr_d_tag, publication_id, auto_saved_at, scheduled_at
       FROM article_drafts
       WHERE writer_id = $1
       ORDER BY auto_saved_at DESC
       LIMIT 50`,
      [writerId]
    )

    return reply.status(200).send({
      drafts: rows.map(r => ({
        draftId: r.id,
        title: r.title,
        dTag: r.nostr_d_tag,
        publicationId: r.publication_id,
        autoSavedAt: r.auto_saved_at,
        scheduledAt: r.scheduled_at,
      })),
    })
  })

  // GET /drafts/:id — load a single draft
  app.get<{ Params: { id: string } }>(
    '/drafts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      const { rows } = await pool.query<{
        id: string
        title: string | null
        dek: string | null
        content_raw: string | null
        nostr_d_tag: string | null
        gate_position_pct: number | null
        price_pence: number | null
        publication_id: string | null
        cover_image_url: string | null
        comments_enabled: boolean | null
        auto_saved_at: string
        scheduled_at: string | null
      }>(
        `SELECT id, title, dek, content_raw, nostr_d_tag, gate_position_pct, price_pence, publication_id, cover_image_url, comments_enabled, auto_saved_at, scheduled_at
         FROM article_drafts
         WHERE id = $1 AND writer_id = $2`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Draft not found' })
      }

      const r = rows[0]
      return reply.status(200).send({
        draftId: r.id,
        title: r.title,
        dek: r.dek,
        content: r.content_raw,
        dTag: r.nostr_d_tag,
        gatePositionPct: r.gate_position_pct,
        pricePence: r.price_pence,
        publicationId: r.publication_id,
        coverImageUrl: r.cover_image_url,
        commentsEnabled: r.comments_enabled ?? true,
        autoSavedAt: r.auto_saved_at,
        scheduledAt: r.scheduled_at,
      })
    }
  )

  // DELETE /drafts/:id
  app.delete<{ Params: { id: string } }>(
    '/drafts/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      await pool.query(
        'DELETE FROM article_drafts WHERE id = $1 AND writer_id = $2',
        [req.params.id, writerId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // POST /drafts/:id/schedule — schedule a draft for future publication
  app.post<{ Params: { id: string } }>(
    '/drafts/:id/schedule',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub
      const body = z.object({
        scheduledAt: z.string().refine(s => !isNaN(Date.parse(s)), 'Invalid date'),
      }).safeParse(req.body)

      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() })
      }

      const scheduledAt = new Date(body.data.scheduledAt)
      if (scheduledAt <= new Date()) {
        return reply.status(400).send({ error: 'Scheduled time must be in the future.' })
      }

      const result = await pool.query<{ id: string; scheduled_at: string }>(
        `UPDATE article_drafts
         SET scheduled_at = $1
         WHERE id = $2 AND writer_id = $3
         RETURNING id, scheduled_at`,
        [scheduledAt.toISOString(), req.params.id, writerId]
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Draft not found' })
      }

      return reply.status(200).send({
        ok: true,
        scheduledAt: result.rows[0].scheduled_at,
      })
    }
  )

  // DELETE /drafts/:id/schedule — unschedule a draft
  app.delete<{ Params: { id: string } }>(
    '/drafts/:id/schedule',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub

      const result = await pool.query(
        `UPDATE article_drafts
         SET scheduled_at = NULL
         WHERE id = $1 AND writer_id = $2
         RETURNING id`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Draft not found' })
      }

      return reply.status(200).send({ ok: true })
    }
  )
}
