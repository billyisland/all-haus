import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool } from '@platform-pub/shared/db/client.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { requireAuth } from '../middleware/auth.js'
import { readingLogRetentionDays } from '../workers/reading-log-sweep.js'

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
  // OPTIONAL, symmetrically with the switch below, and for the same reason.
  // It was required, so the settings screen's logging toggle had to resend a
  // local copy of it — and sent `?? false` when it had none, which turned "the
  // preferences fetch has not returned yet" into a positive write of OFF.
  // A dial a caller does not mention is a dial it must not be able to move.
  alwaysOpenAtTop: z.boolean().optional(),
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

      // A path id answers 404, never 400 (security.md).
      if (!POST_ID_RE.test(postId)) {
        return reply.status(404).send({ error: "We couldn't find that post." })
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

      // The answer a well-formed post_id with no stored position gets.
      if (!POST_ID_RE.test(postId)) {
        return reply.status(200).send({ position: null })
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
      return reply.status(404).send({ error: "We couldn't find that account." })
    }
    // `retentionDays` rides here for Settings' sentence about the log ("lists
    // everything you open … for N days"), which was a literal week (walkthrough
    // A11) — the same reader the sweep and `GET /reading-log` use, so the
    // number the copy names is the number the sweep enforces.
    return reply.send({
      alwaysOpenAtTop: rows[0].always_open_articles_at_top,
      readingLogEnabled: rows[0].reading_log_enabled,
      retentionDays: await readingLogRetentionDays(),
    })
  })

  app.put('/me/reading-preferences', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = PreferencesSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }
    const userId = req.session!.sub
    // COALESCE rather than two statements: an omitted field must leave its
    // column alone, in BOTH directions — defaulting either one would move a
    // dial the caller never mentioned every time they touched the other.
    const { rows } = await pool.query<{
      always_open_articles_at_top: boolean
      reading_log_enabled: boolean
    }>(
      `UPDATE accounts
          SET always_open_articles_at_top = COALESCE($1, always_open_articles_at_top),
              reading_log_enabled = COALESCE($2, reading_log_enabled),
              updated_at = now()
        WHERE id = $3
        RETURNING always_open_articles_at_top, reading_log_enabled`,
      [
        parsed.data.alwaysOpenAtTop ?? null,
        parsed.data.readingLogEnabled ?? null,
        userId,
      ]
    )
    if (rows.length === 0) {
      return reply.status(404).send({ error: "We couldn't find that account." })
    }
    return reply.send({
      ok: true,
      alwaysOpenAtTop: rows[0].always_open_articles_at_top,
      readingLogEnabled: rows[0].reading_log_enabled,
    })
  })
}
