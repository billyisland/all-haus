import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { markFollowListDirty } from '../lib/discovery-publish.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { isUuid } from '../lib/request-inputs.js'

// =============================================================================
// Follow Routes
//
// DELETE /follows/:writerId    — unfollow a writer (the legacy exit for a
//                                pre-convergence row with no source to remove)
// GET    /follows/pubkeys      — list followed writer pubkeys (for feed filter)
// GET    /follows              — list followed writers with display info
//
// Follow relationships are stored in the platform DB (follows table) and
// also published as kind 3 contact list events to the relay. The DB is the
// source of truth for feed assembly; the relay events enable portability.
// A follow is CREATED only by adding an account source to a feed
// (`POST /workspace/feeds/:id/sources`, feeds.md) — never here.
// =============================================================================

export async function followRoutes(app: FastifyInstance) {

  // NO POST (CA-I3, 2026-09-29). `POST /follows/:writerId` wrote a `follows`
  // row and a `new_follower` notification with no `feed_sources` write — the
  // state feeds.md forbids (a follow is a CHOSEN SOURCE, written by
  // `POST /workspace/feeds/:id/sources` beside the source, in one
  // transaction). The web client deliberately had no `follow` (its comment
  // says so, pinned by `follow-feed-frontier.test.ts`) and modernhaus only
  // ever DELETEs here, so the route was dead as a feature and live as a back
  // door. Its guards — self, active, blocks both ways — live in `addSource`'s
  // account arm now, pinned by `follow-is-a-chosen-source.test.ts`.

  // ---------------------------------------------------------------------------
  // DELETE /follows/:writerId — unfollow a writer
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/follows/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub
      const { writerId } = req.params
      if (!isUuid(writerId)) {
        return reply.status(404).send({ error: 'not_found' })
      }

      await pool.query(
        'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2',
        [followerId, writerId]
      )

      markFollowListDirty(followerId).catch((err) =>
        logger.warn({ err, followerId }, 'Failed to mark follow list dirty'))

      logger.info({ followerId, writerId }, 'Follow removed')

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows/pubkeys — list followed writer pubkeys
  //
  // Used by the feed to filter relay queries. Returns just the hex pubkeys
  // for minimal payload size.
  // ---------------------------------------------------------------------------

  app.get(
    '/follows/pubkeys',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub

      const [writerRes, pubRes] = await Promise.all([
        pool.query<{ nostr_pubkey: string }>(
          `SELECT a.nostr_pubkey
           FROM follows f
           JOIN accounts a ON a.id = f.followee_id
           WHERE f.follower_id = $1 AND a.status = 'active'`,
          [followerId]
        ),
        pool.query<{ nostr_pubkey: string }>(
          `SELECT p.nostr_pubkey
           FROM publication_follows pf
           JOIN publications p ON p.id = pf.publication_id
           WHERE pf.follower_id = $1 AND p.status = 'active'`,
          [followerId]
        ),
      ])

      return reply.status(200).send({
        pubkeys: [
          ...writerRes.rows.map(r => r.nostr_pubkey),
          ...pubRes.rows.map(r => r.nostr_pubkey),
        ],
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows — list followed writers with display info
  //
  // Used by the settings/profile page to show who the reader follows.
  // ---------------------------------------------------------------------------

  // NO `GET /follows/followers` either (CA-I3): the followers list the web
  // renders reads `/writers/:username/followers`, and nothing called this.

  // ---------------------------------------------------------------------------
  // GET /follows — list followed writers with display info
  //
  // Used by the settings/profile page to show who the reader follows.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // GET /follows/followers — list accounts who follow you
  // ---------------------------------------------------------------------------

  app.get(
    '/follows/followers',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followeeId = req.session!.sub

      const { rows } = await pool.query<{
        id: string
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
        nostr_pubkey: string
        followed_at: Date
      }>(
        `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                a.nostr_pubkey, f.followed_at
         FROM follows f
         JOIN accounts a ON a.id = f.follower_id
         WHERE f.followee_id = $1 AND a.status = 'active'
         ORDER BY f.followed_at DESC`,
        [followeeId]
      )

      const followers = rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        pubkey: r.nostr_pubkey,
        followedAt: r.followed_at.toISOString(),
      }))

      return reply.status(200).send({ followers })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /follows — list followed writers with display info
  //
  // Used by the settings/profile page to show who the reader follows.
  // ---------------------------------------------------------------------------

  app.get(
    '/follows',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub

      const { rows } = await pool.query<{
        id: string
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
        nostr_pubkey: string
        followed_at: Date
      }>(
        `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                a.nostr_pubkey, f.followed_at
         FROM follows f
         JOIN accounts a ON a.id = f.followee_id
         WHERE f.follower_id = $1 AND a.status = 'active'
         ORDER BY f.followed_at DESC`,
        [followerId]
      )

      const writers = rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        avatar: r.avatar_blossom_url,
        pubkey: r.nostr_pubkey,
        followedAt: r.followed_at.toISOString(),
      }))

      return reply.status(200).send({ writers })
    }
  )

  // ===========================================================================
  // Publication follows
  // ===========================================================================

  // POST /follows/publication/:id — follow a publication
  app.post<{ Params: { id: string } }>(
    '/follows/publication/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub
      const { id: publicationId } = req.params
      if (!isUuid(publicationId)) {
        return reply.status(404).send({ error: 'not_found' })
      }

      const pubCheck = await pool.query(
        `SELECT id FROM publications WHERE id = $1 AND status = 'active'`,
        [publicationId]
      )
      if (pubCheck.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that publication." })
      }

      await pool.query(
        `INSERT INTO publication_follows (follower_id, publication_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, publication_id) DO NOTHING`,
        [followerId, publicationId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // DELETE /follows/publication/:id — unfollow a publication
  app.delete<{ Params: { id: string } }>(
    '/follows/publication/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub
      const { id: publicationId } = req.params
      if (!isUuid(publicationId)) {
        return reply.status(404).send({ error: 'not_found' })
      }

      await pool.query(
        'DELETE FROM publication_follows WHERE follower_id = $1 AND publication_id = $2',
        [followerId, publicationId]
      )

      return reply.status(200).send({ ok: true })
    }
  )

  // Extend /follows/pubkeys to include followed publication pubkeys
  // (Original endpoint above returns writer pubkeys; this is a separate
  //  path that the feed uses. We augment the existing endpoint response.)
}
