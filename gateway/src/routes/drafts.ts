import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import {
  requireWriter,
  WriterAccessRequiredError,
  writerAccessRefusal,
} from '../lib/writer-gate.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { isUuid } from '../lib/request-inputs.js'
import {
  splitContent,
  publishPersonalArticle,
  publishRefusal,
} from '../services/article-publisher.js'
import { generateDTag } from '@platform-pub/shared/lib/slug.js'
import {
  writerTermsOutstanding,
  WriterTermsRequiredError,
  WRITER_TERMS_REQUIRED,
} from '../lib/terms-gate.js'

// =============================================================================
// Draft Routes
//
// POST   /drafts              — Save or update a draft
// GET    /drafts              — List writer's drafts
// GET    /drafts/:id          — Load a single draft
// DELETE /drafts/:id          — Delete a draft
// POST   /drafts/:id/schedule — Schedule a draft for future publication
// DELETE /drafts/:id/schedule — Unschedule a draft
// POST   /drafts/:id/publish  — Publish a draft NOW, on the server
//
// Drafts are stored in the article_drafts table. Row targeting, in priority
// order: an explicit draftId (the editor echoes back the id it was given, so
// saves always land on the row being edited), else the (writer, dTag) upsert
// (edits of published articles), else the writer's most recent untagged draft
// — that guess exists only for the very first save of a new article, and runs
// under a per-writer advisory lock so two concurrent first saves (debounced
// autosave racing the explicit Save click) can't both INSERT. The duplicate
// row that race minted was the "draft + published, both in the dashboard" bug.
//
// Every `:id` route guards the param with `isUuid` before it reaches SQL:
// Postgres answers a malformed uuid with `invalid input syntax for type uuid`,
// which the error funnel turns into `internal_error` 500 (measured — met by
// sending `undefined` while driving the editor). The answer is whatever the
// route already gives a WELL-FORMED id naming no row, because those two are
// the same answer to the caller and splitting them makes the route an oracle
// for which drafts exist: 404 for the three that report absence, and 200 for
// DELETE, which is idempotent by design and reports nothing.
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
  // "This is a piece nobody has saved before": INSERT, never the guess below.
  // The plain-HTML register sends it on a new piece's first save, because the
  // guess updates the writer's most recent untagged draft — an unrelated piece
  // if they have one — and a form that reloads on every save has no autosave
  // race for the guess to be protecting against. Ignored beside a draftId or dTag.
  newDraft: z.literal(true).optional(),
})

export async function draftRoutes(app: FastifyInstance) {

  // POST /drafts — upsert a draft
  app.post('/drafts', { preHandler: [requireAuth, requireWriter] }, async (req, reply) => {
    const parsed = SaveDraftSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
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
      } else if (data.newDraft && !data.draftId) {
        const result = await pool.query<{ id: string; auto_saved_at: string }>(
          `INSERT INTO article_drafts (writer_id, title, content_raw, gate_position_pct, price_pence, publication_id, cover_image_url, dek, comments_enabled, auto_saved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           RETURNING id, auto_saved_at`,
          [writerId, data.title ?? null, data.content ?? null, data.gatePositionPct ?? null, data.pricePence ?? null, data.publicationId ?? null, data.coverImageUrl ?? null, data.dek ?? null, data.commentsEnabled ?? null]
        )
        return reply.status(201).send({
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
      return reply.status(500).send({ error: "Couldn't save your draft. Please try again." })
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
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }

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
        return reply.status(404).send({ error: "We couldn't find that draft." })
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
      // 200, not 404: this route already answers 200 for a well-formed id that
      // names no row, and the two must not be told apart.
      if (!isUuid(req.params.id)) {
        return reply.status(200).send({ ok: true })
      }

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
    { preHandler: [requireAuth, requireWriter] },
    async (req, reply) => {
      const writerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }
      const body = z.object({
        scheduledAt: z.string().refine(s => !isNaN(Date.parse(s)), 'Invalid date'),
      }).safeParse(req.body)

      if (!body.success) {
        return reply.status(400).send(zodValidationError(body.error))
      }

      const scheduledAt = new Date(body.data.scheduledAt)
      if (scheduledAt <= new Date()) {
        return reply.status(400).send({ error: 'Scheduled time must be in the future.' })
      }

      // THE GESTURE IS HERE, so every refusal is here too. The publisher
      // refuses a piece it cannot publish and a paywalled publish without a
      // current Writer Agreement (A3), but it does so minutes or days after
      // the writer pressed Schedule and with nobody watching — the draft would
      // simply not appear. Asked at the press, the writer can fix the piece,
      // or accept the agreement, and schedule in one sitting.
      //
      // `publishRefusal` FIRST (CA-A1): this door asked only the agreement, and
      // a gate marker over a price of zero — which the editor refuses before
      // signing and publish-now refuses at its press — went through here to
      // be published FREE, the paid half in public. The dashboard schedules an
      // autosaved draft with no client check, so this route is the only guard
      // that press has.
      //
      // The paywalled predicate is READ FROM THE PUBLISHER'S OWN `splitContent`
      // and its `price_pence > 0` test, not re-derived here: two spellings of
      // "is this draft paywalled" would let a draft pass this gate and then be
      // refused by the one that decides.
      const draftRow = await pool.query<{
        title: string | null
        content_raw: string | null
        price_pence: number | null
        gate_position_pct: number | null
      }>(
        `SELECT title, content_raw, price_pence, gate_position_pct FROM article_drafts
         WHERE id = $1 AND writer_id = $2`,
        [req.params.id, writerId]
      )
      if (draftRow.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }
      const refusal = publishRefusal(draftRow.rows[0])
      if (refusal) {
        return reply.status(400).send(refusal)
      }
      const { paywallContent } = splitContent(draftRow.rows[0].content_raw ?? '')
      const draftIsPaywalled =
        !!paywallContent && (draftRow.rows[0].price_pence ?? 0) > 0
      if (draftIsPaywalled && (await writerTermsOutstanding(writerId))) {
        return reply.status(403).send({
          error: WRITER_TERMS_REQUIRED,
          message:
            'Before scheduling paid access, please accept the all.haus Writer Agreement.',
        })
      }

      const result = await pool.query<{ id: string; scheduled_at: string }>(
        `UPDATE article_drafts
         SET scheduled_at = $1
         WHERE id = $2 AND writer_id = $3
         RETURNING id, scheduled_at`,
        [scheduledAt.toISOString(), req.params.id, writerId]
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
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
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }

      const result = await pool.query(
        `UPDATE article_drafts
         SET scheduled_at = NULL
         WHERE id = $1 AND writer_id = $2
         RETURNING id`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }

      return reply.status(200).send({ ok: true })
    }
  )
  // POST /drafts/:id/publish — publish a draft NOW, on the server
  //
  // The door the plain-HTML register publishes through (MODERNHAUS-ADR
  // Decision 3, §D1.8.2): the full site orchestrates publish-now in the
  // browser, which a page with no script cannot. It is NOT a second publisher.
  // It hands the draft to `publishPersonalArticle`, the one server-side path,
  // exactly as the scheduler does — "publish now" is "schedule for now", run
  // while the writer waits.
  //
  // EVERY PRECONDITION THE OTHER DOORS HOLD, HOLDS HERE (posts.md: a publish-
  // side precondition is enforced at every door). `publishRefusal` keeps
  // the paywall lockstep; the Writer Agreement is asked at the gesture, as the
  // index and schedule routes ask it, and the publisher's typed throw is the
  // backstop; a publication draft is refused (the publications system is
  // suspended, and a publication paywall has no vault step — money.md).
  //
  // THE DRAFT IS CLAIMED THE WAY THE SCHEDULER CLAIMS ONE, so the two can
  // never publish it twice: `scheduled_at` is pushed five minutes out, in the
  // same statement that checks it was empty. A draft already scheduled — by
  // the writer, or claimed by the scheduler mid-publish — is refused rather
  // than raced, and so is a second press while the first is running. The
  // claim also STAMPS the d-tag a first publish would mint, so anything that
  // publishes this draft again (a retry, the scheduler after a crash) is an
  // edit of the same piece and never a second copy. A failure releases the
  // claim and keeps the draft; a crash leaves it to the scheduler, which
  // finishes what the writer asked for.
  app.post<{ Params: { id: string } }>(
    '/drafts/:id/publish',
    { preHandler: [requireAuth, requireWriter] },
    async (req, reply) => {
      const writerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }
      const body = z.object({ sendEmail: z.boolean().optional() }).safeParse(req.body ?? {})
      if (!body.success) {
        return reply.status(400).send(zodValidationError(body.error))
      }

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
        scheduled_at: string | null
      }>(
        `SELECT id, title, dek, content_raw, nostr_d_tag, gate_position_pct, price_pence,
                publication_id, cover_image_url, comments_enabled, scheduled_at
         FROM article_drafts
         WHERE id = $1 AND writer_id = $2`,
        [req.params.id, writerId]
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that draft." })
      }
      const draft = rows[0]

      if (draft.publication_id) {
        return reply.status(409).send({
          error: 'publication_draft',
          message: 'This draft belongs to a publication, and cannot be published from here.',
        })
      }
      if (draft.scheduled_at !== null) {
        return reply.status(409).send({
          error: 'draft_scheduled',
          message: 'This draft is scheduled. Unschedule it first to publish it now.',
        })
      }
      const refusal = publishRefusal(draft)
      if (refusal) {
        return reply.status(400).send(refusal)
      }
      const { paywallContent } = splitContent(draft.content_raw ?? '')
      const isPaywalled = !!paywallContent && (draft.price_pence ?? 0) > 0
      if (isPaywalled && (await writerTermsOutstanding(writerId))) {
        return reply.status(403).send({
          error: WRITER_TERMS_REQUIRED,
          message:
            'Before publishing paid access, please accept the all.haus Writer Agreement.',
        })
      }

      const dTag = draft.nostr_d_tag ?? generateDTag(draft.title || 'untitled')
      const claim = await pool.query(
        `UPDATE article_drafts
         SET scheduled_at = now() + interval '5 minutes', nostr_d_tag = $3
         WHERE id = $1 AND writer_id = $2 AND scheduled_at IS NULL
         RETURNING id`,
        [draft.id, writerId, dTag]
      )
      if (claim.rowCount === 0) {
        return reply.status(409).send({
          error: 'draft_scheduled',
          message: 'This draft is scheduled. Unschedule it first to publish it now.',
        })
      }

      // An EDIT emails nobody (the editor's rule: `sendEmail` is false when
      // editing), so the question is whether a live piece already holds this
      // d-tag — asked before the publish, which is what makes it one.
      const prior = await pool.query(
        `SELECT 1 FROM articles WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL`,
        [writerId, dTag]
      )
      const isEdit = (prior.rowCount ?? 0) > 0

      let result
      try {
        result = await publishPersonalArticle(
          {
            writerId,
            title: draft.title ?? '',
            dek: draft.dek,
            contentRaw: draft.content_raw ?? '',
            nostrDTag: dTag,
            gatePositionPct: draft.gate_position_pct,
            pricePence: draft.price_pence,
            coverImageUrl: draft.cover_image_url,
            commentsEnabled: draft.comments_enabled,
          },
          { draftId: draft.id, sendEmail: !isEdit && body.data.sendEmail !== false }
        )
      } catch (err) {
        // Release the claim and keep the draft. A failed release must not
        // REPLACE the failure it is cleaning up after (root CLAUDE.md): it is
        // logged with the original attached, and the original is what answers.
        await pool
          .query(
            'UPDATE article_drafts SET scheduled_at = NULL WHERE id = $1 AND writer_id = $2',
            [draft.id, writerId]
          )
          .catch((releaseErr) =>
            logger.error({ err: releaseErr, cause: err, draftId: draft.id }, 'Publish-now: claim not released')
          )
        if (err instanceof WriterAccessRequiredError) {
          return reply.status(403).send(writerAccessRefusal())
        }
        if (err instanceof WriterTermsRequiredError) {
          return reply.status(403).send({
            error: WRITER_TERMS_REQUIRED,
            message:
              'Before publishing paid access, please accept the all.haus Writer Agreement.',
          })
        }
        throw err
      }

      // Publishing an article deletes its working draft (posts.md). The piece
      // is live whatever happens here, so a failure is logged and never
      // answered as one — a writer told "failed" publishes again. A draft that
      // survives must not keep the claim either, or the scheduler publishes it
      // a second time in five minutes and emails the subscribers again; left
      // unclaimed it is only a stale draft beside a live piece.
      await pool
        .query('DELETE FROM article_drafts WHERE id = $1 AND writer_id = $2', [draft.id, writerId])
        .catch(async (err) => {
          logger.error({ err, draftId: draft.id, articleId: result.articleId }, 'Publish-now: draft not deleted after publish')
          await pool
            .query('UPDATE article_drafts SET scheduled_at = NULL WHERE id = $1 AND writer_id = $2', [draft.id, writerId])
            .catch((releaseErr) =>
              logger.error({ err: releaseErr, cause: err, draftId: draft.id }, 'Publish-now: claim not released after publish')
            )
        })

      logger.info({ draftId: draft.id, writerId, articleId: result.articleId, isEdit }, 'Draft published now')
      return reply.status(201).send({
        articleId: result.articleId,
        dTag: result.dTag,
        eventId: result.eventId,
      })
    }
  )
}
