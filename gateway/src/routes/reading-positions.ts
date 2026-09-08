import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { requireAuth } from '../middleware/auth.js'

// =============================================================================
// Reading-position routes
//
//   PUT /reading-positions/:postId  — upsert scroll position
//   GET /reading-positions/:postId  — fetch scroll position for restore
//   GET /me/reading-preferences     — fetch reading prefs
//   PUT /me/reading-preferences     — update reading prefs
//
// KEYED ON post_id SINCE MIGRATION 189 (READING-LOG-AND-LIBRARY-ADR D8), and
// the change is not a rename. It used to key on a 64-hex `nostrEventId`
// resolved to an `articles` row, which meant an external post could not have a
// position at all — resume worked on native pieces and not external ones, which
// a reader experiences as the feature being broken half the time. post_id is
// the one key that spans both id-spaces, so this table now holds what
// reading_log holds.
//
// THE ROUTE NO LONGER VALIDATES THAT THE PIECE EXISTS, and that is deliberate.
// The old PUT 404'd on an unknown event id because it had to resolve one to get
// an article_id; post_id needs no resolution, and re-introducing the lookup
// would put a join on the beacon path to enforce a foreign key the schema
// cannot have (feed_items.post_id carries no unique constraint). A position for
// a piece that no longer resolves is simply never read, and the retention sweep
// reaps it.
//
// WHICH SWEEP: workers/reading-log-sweep.ts. Dropping article_id dropped an FK
// ON DELETE CASCADE with it, so this table has no other reaper — see D8.
// =============================================================================

const POST_ID_RE = /^[0-9a-f]{64}$/

const UpsertSchema = z.object({
  scrollRatio: z.number().min(0).max(1),
})

const PreferencesSchema = z.object({
  alwaysOpenAtTop: z.boolean(),
  // D1's stop-logging switch, which lives beside the resume toggle because
  // both are facts about the reader rather than about the screen. Optional so
  // a client that knows only about resume can still PUT one without silently
  // switching the other back on.
  readingLogEnabled: z.boolean().optional(),
})

export async function readingPositionRoutes(app: FastifyInstance) {
  app.put<{ Params: { postId: string } }>(
    '/reading-positions/:postId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { postId } = req.params

      if (!POST_ID_RE.test(postId)) {
        return reply.status(400).send({ error: 'Invalid postId (expected a 64-char hex post_id)' })
      }

      const parsed = UpsertSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      await pool.query(
        `INSERT INTO reading_positions (user_id, post_id, scroll_ratio, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id, post_id)
         DO UPDATE SET scroll_ratio = EXCLUDED.scroll_ratio, updated_at = now()`,
        [userId, postId, parsed.data.scrollRatio]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  app.get<{ Params: { postId: string } }>(
    '/reading-positions/:postId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub
      const { postId } = req.params

      if (!POST_ID_RE.test(postId)) {
        return reply.status(400).send({ error: 'Invalid postId (expected a 64-char hex post_id)' })
      }

      const { rows } = await pool.query<{ scroll_ratio: number; updated_at: Date }>(
        `SELECT scroll_ratio, updated_at
         FROM reading_positions
         WHERE user_id = $1 AND post_id = $2`,
        [userId, postId]
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
    const { rows } = await pool.query<{
      always_open_articles_at_top: boolean
      reading_log_enabled: boolean
    }>(
      'SELECT always_open_articles_at_top, reading_log_enabled FROM accounts WHERE id = $1',
      [userId]
    )
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    return reply.send({
      alwaysOpenAtTop: rows[0].always_open_articles_at_top,
      readingLogEnabled: rows[0].reading_log_enabled,
    })
  })

  app.put('/me/reading-preferences', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PreferencesSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const userId = req.session!.sub
    // COALESCE rather than two statements: an omitted `readingLogEnabled` must
    // leave the column alone, and the alternative — defaulting it to true —
    // would switch a member's logging back on every time they touched the
    // resume toggle.
    const { rows } = await pool.query<{
      always_open_articles_at_top: boolean
      reading_log_enabled: boolean
    }>(
      `UPDATE accounts
          SET always_open_articles_at_top = $1,
              reading_log_enabled = COALESCE($2, reading_log_enabled),
              updated_at = now()
        WHERE id = $3
        RETURNING always_open_articles_at_top, reading_log_enabled`,
      [parsed.data.alwaysOpenAtTop, parsed.data.readingLogEnabled ?? null, userId]
    )
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Account not found' })
    }
    return reply.send({
      ok: true,
      alwaysOpenAtTop: rows[0].always_open_articles_at_top,
      readingLogEnabled: rows[0].reading_log_enabled,
    })
  })
}
