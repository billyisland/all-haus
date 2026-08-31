import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { markFollowListDirty } from '../lib/discovery-publish.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Follow Routes
//
// POST   /follows/:writerId    — follow a writer
// DELETE /follows/:writerId    — unfollow a writer
// GET    /follows/pubkeys      — list followed writer pubkeys (for feed filter)
// GET    /follows              — list followed writers with display info
//
// Follow relationships are stored in the platform DB (follows table) and
// also published as kind 3 contact list events to the relay. The DB is the
// source of truth for feed assembly; the relay events enable portability.
// =============================================================================

export async function followRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /follows/:writerId — follow a writer
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string } }>(
    '/follows/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub
      const { writerId } = req.params

      if (followerId === writerId) {
        return reply.status(400).send({ error: 'Cannot follow yourself' })
      }

      // Verify the target account exists and is active
      const writerCheck = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE id = $1 AND status = 'active'`,
        [writerId]
      )

      if (writerCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' })
      }

      // Upsert — idempotent
      await pool.query(
        `INSERT INTO follows (follower_id, followee_id)
         VALUES ($1, $2)
         ON CONFLICT (follower_id, followee_id) DO NOTHING`,
        [followerId, writerId]
      )

      // Notify the writer they have a new follower (fire-and-forget)
      pool.query(
        `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'new_follower')
         ON CONFLICT DO NOTHING`,
        [writerId, followerId]
      ).catch((err) => logger.warn({ err }, 'Failed to insert new_follower notification'))

      // Coalesced kind-3 republish — the scheduler sweep rebuilds from state.
      markFollowListDirty(followerId).catch((err) =>
        logger.warn({ err, followerId }, 'Failed to mark follow list dirty'))

      logger.info({ followerId, writerId }, 'Follow created')

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /follows/:writerId — unfollow a writer
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/follows/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const followerId = req.session!.sub
      const { writerId } = req.params

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

      const pubCheck = await pool.query(
        `SELECT id FROM publications WHERE id = $1 AND status = 'active'`,
        [publicationId]
      )
      if (pubCheck.rows.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
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
