import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'

// =============================================================================
// Reading-position routes
//
//   PUT /reading-positions/:nostrEventId  — upsert scroll position
//   GET /reading-positions/:nostrEventId  — fetch scroll position for restore
//   GET /me/reading-preferences           — fetch reading prefs
//   PUT /me/reading-preferences           — update reading prefs
//
// See docs/adr/ALLHAUS-REDESIGN-SPEC.md §4 "Reading history and resumption".
// =============================================================================

const HEX64_RE = /^[0-9a-f]{64}$/

const UpsertSchema = z.object({
  scrollRatio: z.number().min(0).max(1),
})

const PreferencesSchema = z.object({
  alwaysOpenAtTop: z.boolean(),
})

export async function readingPositionRoutes(app: FastifyInstance) {
  app.put<{ Params: { nostrEventId: string } }>(
    '/reading-positions/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { nostrEventId } = req.params

      if (!HEX64_RE.test(nostrEventId)) {
        return reply.status(400).send({ error: 'Invalid event ID' })
      }

      const parsed = UpsertSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const { rows } = await pool.query<{ id: string }>(
        'SELECT id FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL',
        [nostrEventId]
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Article not found' })
      }

      await pool.query(
        `INSERT INTO reading_positions (user_id, article_id, scroll_ratio, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, article_id)
         DO UPDATE SET scroll_ratio = EXCLUDED.scroll_ratio, updated_at = now()`,
        [userId, rows[0].id, parsed.data.scrollRatio]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  app.get<{ Params: { nostrEventId: string } }>(
    '/reading-positions/:nostrEventId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { nostrEventId } = req.params

      if (!HEX64_RE.test(nostrEventId)) {
        return reply.status(400).send({ error: 'Invalid event ID' })
      }

      const { rows } = await pool.query<{ scroll_ratio: number; updated_at: Date }>(
        `SELECT rp.scroll_ratio, rp.updated_at
         FROM reading_positions rp
         JOIN articles a ON a.id = rp.article_id
         WHERE rp.user_id = $1 AND a.nostr_event_id = $2`,
        [userId, nostrEventId]
      )

      if (rows.length === 0) {
        return reply.status(200).send({ position: null })
      }

      return reply.status(200).send({
        position: {
          scrollRatio: rows[0].scroll_ratio,
          updatedAt: rows[0].updated_at.toISOString(),
        },
      })
    }
  )

  app.get('/me/reading-preferences', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.session!.sub
    const { rows } = await pool.query<{ always_open_articles_at_top: boolean }>(
      'SELECT always_open_articles_at_top FROM accounts WHERE id = $1',
      [userId]
    )
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    return reply.send({ alwaysOpenAtTop: rows[0].always_open_articles_at_top })
  })

  app.put('/me/reading-preferences', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PreferencesSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const userId = req.session!.sub
    await pool.query(
      'UPDATE accounts SET always_open_articles_at_top = $1, updated_at = now() WHERE id = $2',
      [parsed.data.alwaysOpenAtTop, userId]
    )
    return reply.send({ ok: true, alwaysOpenAtTop: parsed.data.alwaysOpenAtTop })
  })
}
