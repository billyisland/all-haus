import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { checkArticleAccess } from '../services/article-access/index.js'
import { resolveLockedRoots } from '../lib/root-locked.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Vote Routes
//
// POST   /votes                               — cast a vote (auth required)
// GET    /votes/tally?eventIds=id1,id2,...    — batch fetch tallies (public)
// GET    /votes/mine?eventIds=id1,id2,...     — batch fetch my vote counts (auth)
//
// Audit F9 (2026-07-06): paid voting was removed. Votes are free — no tab
// debit, no vote_charges row, no ledger entry. The `votes`/`vote_charges`
// tables and their historical ledger entries are left inert (append-only); this
// route now only records the vote row (cost 0) and the tally. The former
// GET /votes/price endpoint and the paid-confirm flow were stripped.
// =============================================================================

const VoteSchema = z.object({
  targetEventId: z.string().min(1),
  targetKind: z.number().int(),   // 30023 = article, 1 = note, 1111 = reply
  direction: z.enum(['up', 'down']),
})

export async function voteRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /votes — cast a vote
  // ---------------------------------------------------------------------------

  app.post(
    '/votes',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = VoteSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const { targetEventId, targetKind, direction } = parsed.data
      const voterId = req.session!.sub

      return withTransaction(async (client) => {
        // ------------------------------------------------------------------
        // 1. Resolve the content author
        // ------------------------------------------------------------------
        let authorId: string | null = null
        // The article's paywall ingredients ride the same read (30023), or the
        // comment's root event id does (1111) — for the guard in step 1b.
        let article: {
          id: string
          writer_id: string
          access_mode: string
          publication_id: string | null
        } | null = null
        let commentRootEventId: string | null = null

        if (targetKind === 30023) {
          const { rows } = await client.query<{
            id: string
            writer_id: string
            access_mode: string
            publication_id: string | null
          }>(
            `SELECT id, writer_id, access_mode, publication_id
               FROM articles
              WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
            [targetEventId]
          )
          article = rows[0] ?? null
          authorId = article?.writer_id ?? null
        } else if (targetKind === 1) {
          const { rows } = await client.query<{ author_id: string }>(
            `SELECT author_id FROM notes WHERE nostr_event_id = $1`,
            [targetEventId]
          )
          authorId = rows[0]?.author_id ?? null
        } else if (targetKind === 1111) {
          const { rows } = await client.query<{
            author_id: string
            target_event_id: string
          }>(
            `SELECT author_id, target_event_id
               FROM comments
              WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
            [targetEventId]
          )
          authorId = rows[0]?.author_id ?? null
          commentRootEventId = rows[0]?.target_event_id ?? null
        }

        if (!authorId) {
          return reply.status(404).send({ error: 'Content not found' })
        }

        // ------------------------------------------------------------------
        // 1b. A vote is a WRITE into gated content, so it carries the READ's
        //     guard — the same one POST /replies carries (ARTICLE-HEADED-
        //     CONVERSATIONS-ADR D7). For as long as this route existed nothing
        //     server-side refused a vote on a paywalled article or on a comment
        //     under one; the rule was held up by PostActions declining to draw
        //     the control on `rootLocked`, and a UI rule is not an access
        //     control (CONSOLIDATED-TODO §0w item 1).
        //
        //     GUARD, NOT A BARE CALL. `checkArticleAccess` carries no
        //     access_mode term — for a free article by somebody else it answers
        //     {hasAccess: false} exactly as for an unpaid paywalled one — so
        //     called unconditionally it refuses every vote on every free article
        //     on the site. The `access_mode === 'paywalled'` branch is the gate.
        //     Own content is refused one step later anyway (self-vote).
        //
        //     A COMMENT's root is answered by `resolveLockedRoots`, the one home
        //     for "which of these roots is locked to this viewer": a comment's
        //     `target_event_id` IS the conversation's root (replies-to-replies
        //     share it — POST /replies enforces that), and the resolver already
        //     filters to paywalled article roots, so a note-rooted comment costs
        //     one query that finds nothing and votes through.
        // ------------------------------------------------------------------
        if (article && article.access_mode === 'paywalled') {
          const access = await checkArticleAccess(
            voterId,
            article.id,
            article.writer_id,
            article.publication_id,
          )
          if (!access.hasAccess) {
            return reply.status(403).send({ error: 'Unlock this article to vote' })
          }
        } else if (commentRootEventId) {
          const locked = await resolveLockedRoots(voterId, [commentRootEventId])
          if (locked.has(commentRootEventId)) {
            return reply.status(403).send({ error: 'Unlock this article to vote' })
          }
        }

        // ------------------------------------------------------------------
        // 2. Prevent self-voting
        // ------------------------------------------------------------------
        if (voterId === authorId) {
          return reply.status(400).send({ error: 'Cannot vote on your own content' })
        }

        // ------------------------------------------------------------------
        // 3. Count existing votes in this direction
        //    Advisory lock serialises concurrent votes for the same
        //    voter/target/direction to prevent duplicate sequence numbers.
        // ------------------------------------------------------------------
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1 || $2 || $3))`,
          [voterId, targetEventId, direction]
        )
        const countRow = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM votes
           WHERE voter_id = $1 AND target_nostr_event_id = $2 AND direction = $3`,
          [voterId, targetEventId, direction]
        )
        const existingCount = parseInt(countRow.rows[0].count, 10)
        const sequenceNumber = existingCount + 1

        // ------------------------------------------------------------------
        // 3b. Cap: ONE free vote per (voter, target, direction).
        //
        // Under paid voting the escalating cost was the only brake on repeat
        // votes; F9 removed the cost but shipped no replacement cap, so any
        // account could loop POST /votes and inflate a tally without bound
        // (2026-07-06 audit P1). A repeat in the same direction is an
        // idempotent no-op: return the current tally, counted: false, so the
        // client can tell nothing was recorded. Historical multi-vote rows
        // (sequence_number > 1) stay untouched in the tallies.
        // ------------------------------------------------------------------
        if (existingCount >= 1) {
          const tallyRow = await client.query<{
            upvote_count: number
            downvote_count: number
            net_score: number
          }>(
            `SELECT upvote_count, downvote_count, net_score
             FROM vote_tallies WHERE target_nostr_event_id = $1`,
            [targetEventId]
          )
          const tally = tallyRow.rows[0]
          return reply.status(200).send({
            ok: true,
            counted: false,
            sequenceNumber: existingCount,
            tally: {
              upvoteCount: tally?.upvote_count ?? 0,
              downvoteCount: tally?.downvote_count ?? 0,
              netScore: tally?.net_score ?? 0,
            },
          })
        }

        // ------------------------------------------------------------------
        // 4. Insert vote row (F9: free — no cost, no tab, no charge row)
        // ------------------------------------------------------------------
        await client.query<{ id: string }>(
          `INSERT INTO votes
             (voter_id, target_nostr_event_id, target_author_id,
              direction, sequence_number, cost_pence, tab_id, on_free_allowance)
           VALUES ($1, $2, $3, $4, $5, 0, NULL, FALSE)
           RETURNING id`,
          [voterId, targetEventId, authorId, direction, sequenceNumber]
        )

        // ------------------------------------------------------------------
        // 5. Upsert the tally
        // ------------------------------------------------------------------
        const upDelta = direction === 'up' ? 1 : 0
        const downDelta = direction === 'down' ? 1 : 0
        const scoreDelta = direction === 'up' ? 1 : -1

        await client.query(
          `INSERT INTO vote_tallies
             (target_nostr_event_id, upvote_count, downvote_count, net_score)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (target_nostr_event_id) DO UPDATE SET
             upvote_count  = vote_tallies.upvote_count  + $2,
             downvote_count = vote_tallies.downvote_count + $3,
             net_score     = vote_tallies.net_score     + $4,
             updated_at    = now()`,
          [targetEventId, upDelta, downDelta, scoreDelta]
        )

        // ------------------------------------------------------------------
        // 9. Fetch updated tally to return
        // ------------------------------------------------------------------
        const tallyRow = await client.query<{
          upvote_count: number
          downvote_count: number
          net_score: number
        }>(
          `SELECT upvote_count, downvote_count, net_score
           FROM vote_tallies WHERE target_nostr_event_id = $1`,
          [targetEventId]
        )
        const tally = tallyRow.rows[0]

        logger.info(
          { voterId, targetEventId, direction, sequenceNumber },
          'Vote recorded'
        )

        return reply.status(201).send({
          ok: true,
          counted: true,
          sequenceNumber,
          tally: {
            upvoteCount: tally.upvote_count,
            downvoteCount: tally.downvote_count,
            netScore: tally.net_score,
          },
        })
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /votes/tally?eventIds=id1,id2,... — batch fetch tallies (public)
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { eventIds?: string } }>(
    '/votes/tally',
    async (req, reply) => {
      const raw = req.query.eventIds ?? ''
      const eventIds = raw.split(',').map(s => s.trim()).filter(Boolean)

      if (eventIds.length === 0) {
        return reply.status(200).send({ tallies: {} })
      }

      if (eventIds.length > 200) {
        return reply.status(400).send({ error: 'Too many event IDs (max 200)' })
      }

      const { rows } = await pool.query<{
        target_nostr_event_id: string
        upvote_count: number
        downvote_count: number
        net_score: number
      }>(
        `SELECT target_nostr_event_id, upvote_count, downvote_count, net_score
         FROM vote_tallies
         WHERE target_nostr_event_id = ANY($1)`,
        [eventIds]
      )

      const tallies: Record<string, { upvoteCount: number; downvoteCount: number; netScore: number }> = {}

      // Fill zero-tally for all requested IDs
      for (const id of eventIds) {
        tallies[id] = { upvoteCount: 0, downvoteCount: 0, netScore: 0 }
      }

      for (const row of rows) {
        tallies[row.target_nostr_event_id] = {
          upvoteCount: row.upvote_count,
          downvoteCount: row.downvote_count,
          netScore: row.net_score,
        }
      }

      return reply.status(200).send({ tallies })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /votes/mine?eventIds=id1,id2,... — batch fetch my vote counts (auth)
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { eventIds?: string } }>(
    '/votes/mine',
    { preHandler: requireAuth },
    async (req, reply) => {
      const voterId = req.session!.sub
      const raw = req.query.eventIds ?? ''
      const eventIds = raw.split(',').map(s => s.trim()).filter(Boolean)

      if (eventIds.length === 0) {
        return reply.status(200).send({ voteCounts: {} })
      }

      if (eventIds.length > 200) {
        return reply.status(400).send({ error: 'Too many event IDs (max 200)' })
      }

      const { rows } = await pool.query<{
        target_nostr_event_id: string
        direction: string
        count: string
      }>(
        `SELECT target_nostr_event_id, direction, COUNT(*) AS count
         FROM votes
         WHERE voter_id = $1 AND target_nostr_event_id = ANY($2)
         GROUP BY target_nostr_event_id, direction`,
        [voterId, eventIds]
      )

      const voteCounts: Record<string, { upCount: number; downCount: number }> = {}

      for (const id of eventIds) {
        voteCounts[id] = { upCount: 0, downCount: 0 }
      }

      for (const row of rows) {
        const entry = voteCounts[row.target_nostr_event_id]
        if (entry) {
          if (row.direction === 'up') entry.upCount = parseInt(row.count, 10)
          else entry.downCount = parseInt(row.count, 10)
        }
      }

      return reply.status(200).send({ voteCounts })
    }
  )
}
