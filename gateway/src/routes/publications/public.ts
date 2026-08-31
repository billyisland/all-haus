import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { optionalAuth } from '../../middleware/auth.js'

// =============================================================================
// Reader-facing publication routes
//
// GET /publications/:slug/public           — Full public profile (for homepage)
// GET /publications/by-slug/:slug/articles — Published articles (paginated)
// GET /publications/:slug/masthead         — Public member list with roles
// =============================================================================

export async function publicationPublicRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /publications/:slug/public — Full public profile (for homepage)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    '/publications/:slug/public',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { slug } = req.params

      const { rows } = await pool.query(
        `SELECT p.id, p.slug, p.name, p.tagline, p.about, p.logo_blossom_url, p.cover_blossom_url,
                p.nostr_pubkey, p.subscription_price_pence, p.annual_discount_pct,
                p.default_article_price_pence, p.homepage_layout, p.status, p.founded_at,
                (SELECT COUNT(*) FROM publication_follows WHERE publication_id = p.id) AS follower_count,
                (SELECT COUNT(*) FROM publication_members WHERE publication_id = p.id AND removed_at IS NULL) AS member_count,
                (SELECT COUNT(*) FROM articles WHERE publication_id = p.id AND published_at IS NOT NULL AND deleted_at IS NULL) AS article_count
         FROM publications p
         WHERE p.slug = $1 AND p.status = 'active'`,
        [slug]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const pub = rows[0]

      // Check if the reader follows this publication
      let isFollowing = false
      let isSubscribed = false
      const readerId = req.session?.sub
      if (readerId) {
        const [followRes, subRes] = await Promise.all([
          pool.query(
            'SELECT 1 FROM publication_follows WHERE follower_id = $1 AND publication_id = $2',
            [readerId, pub.id]
          ),
          pool.query(
            `SELECT 1 FROM subscriptions WHERE reader_id = $1 AND publication_id = $2
               AND status IN ('active', 'cancelled') AND current_period_end > now()`,
            [readerId, pub.id]
          ),
        ])
        isFollowing = followRes.rows.length > 0
        isSubscribed = subRes.rows.length > 0
      }

      return reply.send({ ...pub, isFollowing, isSubscribed })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/by-slug/:slug/articles — Published articles (paginated)
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string }; Querystring: { limit?: string; offset?: string } }>(
    '/publications/by-slug/:slug/articles',
    async (req, reply) => {
      const { slug } = req.params
      const limit = Math.min(parseInt((req.query as any).limit ?? '20', 10), 50)
      const offset = parseInt((req.query as any).offset ?? '0', 10)

      const { rows: pubs } = await pool.query<{ id: string }>(
        `SELECT id FROM publications WHERE slug = $1 AND status = 'active'`,
        [slug]
      )
      if (pubs.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      const { rows } = await pool.query(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.title, a.slug, a.summary,
                a.content_free, a.word_count, a.access_mode, a.price_pence,
                a.cover_image_url, a.published_at,
                acc.username AS author_username, acc.display_name AS author_display_name,
                acc.avatar_blossom_url AS author_avatar
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.publication_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL
           AND a.publication_article_status = 'published'
         ORDER BY a.published_at DESC
         LIMIT $2 OFFSET $3`,
        [pubs[0].id, limit, offset]
      )

      return reply.send({ articles: rows })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /publications/:slug/masthead — Public member list with roles/titles
  // ---------------------------------------------------------------------------

  app.get<{ Params: { slug: string } }>(
    '/publications/:slug/masthead',
    async (req, reply) => {
      const { slug } = req.params

      const { rows: pubs } = await pool.query<{ id: string }>(
        `SELECT id FROM publications WHERE slug = $1 AND status = 'active'`,
        [slug]
      )
      if (pubs.length === 0) {
        return reply.status(404).send({ error: 'Publication not found' })
      }

      // `contributor_type` is selected because both masthead surfaces render a
      // suffix from it ("· one-off"). It was NOT selected before, so the
      // overlay's unguarded read printed the literal "· undefined" after every
      // member's role (§0q.2). Fixing that by guarding alone would have left
      // dead markup on both surfaces; the field is real (`publication_members`,
      // NOT NULL DEFAULT 'permanent'), so it is served instead.
      //
      // `account_id` is deliberately NOT selected: this endpoint is public and
      // unauthenticated, and the only thing the id was wanted for was a React
      // key, which `username` (already public, already unique) serves.
      const { rows } = await pool.query(
        `SELECT pm.role, pm.title, pm.is_owner, pm.contributor_type,
                a.username, a.display_name, a.avatar_blossom_url, a.bio
         FROM publication_members pm
         JOIN accounts a ON a.id = pm.account_id
         WHERE pm.publication_id = $1 AND pm.removed_at IS NULL AND a.status = 'active'
         ORDER BY pm.is_owner DESC, pm.role ASC, a.display_name ASC`,
        [pubs[0].id]
      )

      return reply.send({ members: rows })
    }
  )
}
