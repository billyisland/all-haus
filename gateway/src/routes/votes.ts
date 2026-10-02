import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { checkArticleAccess } from '../services/article-access/index.js'
import { resolveLockedRoots } from '../lib/root-locked.js'
import { resolveEventTarget } from '../lib/event-target.js'
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
// debit, no vote_charges row, no ledger entry. `vote_charges` and its
// historical ledger entries are left inert (append-only); the paid-vote columns
// on `votes` were dropped by migration 265. This route records the vote row and
// the tally. The former
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

      const answer = await withTransaction(async (client): Promise<{ status: number; body: unknown }> => {
        // ------------------------------------------------------------------
        // 1. Resolve the content author
        // ------------------------------------------------------------------
        // WHAT THE ID NAMES DECIDES, NOT WHAT THE REQUEST CLAIMS (MIRROR-AUDIT
        // §2.7). Branching on `targetKind` made the declared kind a way to
        // choose which table gets searched: a note minted under a paywalled
        // article's event id (`POST /notes` takes the id from the client) plus
        // `targetKind: 1` landed in `notes`, left `article` null, and neither
        // arm of the guard below ran — the vote tallied against the article's
        // event id all the same. The resolver searches the squattable table
        // last; see its header.
        //
        // IT ALSO FIXES A LIVE BUG IN THE HONEST DIRECTION. A native reply is
        // projected into a thread as a Post of `type: "note"`, so `PostActions`
        // declares kind 1 for it in good faith; the old branch searched `notes`,
        // found nothing and 404'd every such vote. Resolved by row it finds the
        // comment — and gets the comment's guard with it.
        const target = await resolveEventTarget(client, targetEventId, targetKind)

        if (!target) {
          return { status: 404, body: { error: "We couldn't find that post." } }
        }

        const authorId = target.authorId
        const article = target.kind === 30023 ? target : null
        const commentRootEventId =
          target.kind === 1111 ? target.rootEventId : null

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
        if (article && article.accessMode === 'paywalled') {
          const access = await checkArticleAccess(
            voterId,
            article.articleId,
            article.authorId,
            article.publicationId,
          )
          if (!access.hasAccess) {
            return { status: 403, body: { error: 'Unlock this article to vote' } }
          }
        } else if (commentRootEventId) {
          const locked = await resolveLockedRoots(voterId, [commentRootEventId])
          if (locked.has(commentRootEventId)) {
            return { status: 403, body: { error: 'Unlock this article to vote' } }
          }
        }

        // ------------------------------------------------------------------
        // 2. Prevent self-voting
        // ------------------------------------------------------------------
        if (voterId === authorId) {
          return { status: 400, body: { error: "You can't vote on your own posts." } }
        }

        // ------------------------------------------------------------------
        // 3. Record the vote — ONE free vote per (voter, target, direction).
        //
        // Under paid voting the escalating cost was the only brake on repeat
        // votes; F9 removed the cost but shipped no replacement cap, so any
        // account could loop POST /votes and inflate a tally without bound
        // (2026-07-06 audit P1). The cap is the partial unique index
        // `idx_votes_one_per_direction` (migration 265), so a concurrent pair
        // cannot both land: the loser's INSERT does nothing and returns no row.
        // A repeat in the same direction is an idempotent no-op — the current
        // tally, `counted: false`, so the client can tell nothing was recorded.
        // Historical multi-votes (sequence_number > 1) stay in the tallies and
        // outside the index.
        // ------------------------------------------------------------------
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO votes
             (voter_id, target_nostr_event_id, target_author_id, direction, sequence_number)
           VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (voter_id, target_nostr_event_id, direction)
             WHERE sequence_number = 1 DO NOTHING
           RETURNING id`,
          [voterId, targetEventId, authorId, direction]
        )

        if (inserted.rowCount === 0) {
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
          return { status: 200, body: {
            ok: true,
            counted: false,
            tally: {
              upvoteCount: tally?.upvote_count ?? 0,
              downvoteCount: tally?.downvote_count ?? 0,
              netScore: tally?.net_score ?? 0,
            },
          } }
        }

        // ------------------------------------------------------------------
        // 4. Upsert the tally and return it
        // ------------------------------------------------------------------
        const upDelta = direction === 'up' ? 1 : 0
        const downDelta = direction === 'down' ? 1 : 0
        const scoreDelta = direction === 'up' ? 1 : -1

        const { rows: [tally] } = await client.query<{
          upvote_count: number
          downvote_count: number
          net_score: number
        }>(
          `INSERT INTO vote_tallies
             (target_nostr_event_id, upvote_count, downvote_count, net_score)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (target_nostr_event_id) DO UPDATE SET
             upvote_count  = vote_tallies.upvote_count  + $2,
             downvote_count = vote_tallies.downvote_count + $3,
             net_score     = vote_tallies.net_score     + $4,
             updated_at    = now()
           RETURNING upvote_count, downvote_count, net_score`,
          [targetEventId, upDelta, downDelta, scoreDelta]
        )

        logger.info(
          { voterId, targetEventId, direction },
          'Vote recorded'
        )

        return { status: 201, body: {
          ok: true,
          counted: true,
          tally: {
            upvoteCount: tally.upvote_count,
            downvoteCount: tally.downvote_count,
            netScore: tally.net_score,
          },
        } }
      })

      // Sent AFTER the commit: a reply sent from inside the callback went out
      // before COMMIT, so a 201 could name a vote that then failed to commit.
      return reply.status(answer.status).send(answer.body)
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
