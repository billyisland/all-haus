import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { optionalAuth } from '../middleware/auth.js'
import { resolveProfilePresences } from '../lib/author-resolve.js'
import { viewerRelation } from '../lib/blocks.js'
import { parseLimit, parseOffset } from '../lib/request-inputs.js'
import { accountArrivedSql } from '../lib/account-arrived.js'

// Every lookup of a profile's SUBJECT asks `accountArrivedSql` beside its
// status: an account admit created answers 404 here, exactly like an absent
// one, until its owner signs in (RESHAPE-PLAN-2026-10 §A.5, ruled 2026-09-30).
const ARRIVED = accountArrivedSql('accounts')

// =============================================================================
// Writer Routes
//
// GET /writers/:username   — Public writer profile (for /:username page)
// GET /writers/:username/articles — Writer's published articles (DB index)
//
// These are public routes — no auth required. The writer profile page is
// the primary landing surface for cold traffic per ADR §II.5:
//   "The primary cold traffic pattern at launch is writer-directed: a writer
//    posts 'find me at writer.all.haus' and their audience follows that link."
// =============================================================================

// ---------------------------------------------------------------------------
// Does this writer have a paywalled article?
//
// WHAT MAKES AN ARTICLE PAYWALLED IS `access_mode`, NEVER A LEFTOVER PRICE.
// `price_pence` is not cleared when a piece is switched back to public — the
// publish upsert takes whatever the editor sends and the schema floors it only
// at 0 — so `price_pence > 0`, which is what this asked until now, kept reading
// TRUE for a writer who once charged for something and then opened it up. That
// flag is what draws the subscribe affordance beside their name, so the answer
// was a standing claim about the writer that the writer had revoked. The other
// direction cannot happen: the three publish-side validators all refuse a
// paywalled article priced below 1p.
//
// EXPORTED so the DB-backed test runs this fragment rather than a copy of it.
// The whole defect is which column the predicate names, and a test that retypes
// the predicate has already made the same choice the code did. It interpolates
// `a.id`, so it is a fragment rather than a statement — the alias is the caller's.
// ---------------------------------------------------------------------------
export const HAS_PAYWALLED_ARTICLE_SQL = `EXISTS(
                    SELECT 1 FROM articles
                    WHERE writer_id = a.id
                      AND access_mode = 'paywalled'
                      AND deleted_at IS NULL
                  )`

export async function writerRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /writers/:username — public writer profile
  // ---------------------------------------------------------------------------

  app.get<{ Params: { username: string } }>(
    '/writers/:username',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const viewerId = req.session?.sub ?? null

      const { rows } = await pool.query<{
        id: string
        nostr_pubkey: string
        username: string
        display_name: string | null
        bio: string | null
        avatar_blossom_url: string | null
        hosting_type: string
        subscription_price_pence: number
        annual_discount_pct: number
        show_commission_button: boolean
      }>(
        `SELECT id, nostr_pubkey, username, display_name, bio,
                avatar_blossom_url, hosting_type, subscription_price_pence,
                annual_discount_pct, show_commission_button
         FROM accounts
         WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that writer." })
      }

      const writer = rows[0]

      // Count published articles, paywalled articles, notes, replies, followers,
      // and following.
      // `presences` is the profile's `verified` identity row (PROFILE-PANE-
      // REDESIGN-ADR D7) — network identities the subject proved, consent-gated
      // on show_on_profile so an OAuth link never becomes public retroactively.
      //
      // noteCount/replyCount exist because the profile's button row renders a
      // view's button ONLY when that view has something in it, and it must know
      // that before it paints. Derived client-side from the logs' own fetches,
      // the row would gain two buttons a beat after load and the selected view
      // would move under the reader — the counts have to arrive with the
      // profile. They are the SAME populations the two logs draw
      // (`GET /author/:id/posts?kind=note` and `/author/:id/replies`), so their
      // predicates are copied from those queries and must move with them: a
      // count that disagrees with its log is a button that opens an empty view.
      const [countsResult, presences, viewer] = await Promise.all([
        // ONE statement, one pooled connection (CA-G10): six parallel
        // round-trips each held a connection of their own for a profile load.
        // Every count is still its own subselect on its own index; the two
        // article counts share one scan through FILTER.
        pool.query<{
          article_count: string
          paywalled_count: string
          note_count: string
          reply_count: string
          follower_count: string
          following_count: string
        }>(
          `SELECT a.article_count, a.paywalled_count,
                  -- Mirrors /author/:id/posts' native arm (item_type = 'note').
                  -- The context filter that query also carries is over
                  -- external_items, and a native note has no such row, so it is
                  -- a no-op here — hence no join rather than a forgotten predicate.
                  (SELECT COUNT(*) FROM feed_items
                    WHERE author_id = $1 AND item_type = 'note' AND deleted_at IS NULL) AS note_count,
                  -- Mirrors /author/:id/replies — kind-1111 comments live in
                  -- \`comments\`.
                  (SELECT COUNT(*) FROM comments
                    WHERE author_id = $1 AND deleted_at IS NULL) AS reply_count,
                  (SELECT COUNT(*) FROM follows WHERE followee_id = $1) AS follower_count,
                  (SELECT COUNT(*) FROM follows WHERE follower_id = $1) AS following_count
             FROM (
               SELECT COUNT(*) AS article_count,
                      COUNT(*) FILTER (WHERE access_mode = 'paywalled') AS paywalled_count
                 FROM articles
                WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL
                  AND (publication_id IS NULL OR show_on_writer_profile = TRUE)
             ) a`,
          [writer.id]
        ),
        resolveProfilePresences(writer.id),
        // What the VIEWER has done to this writer — the Mute/Block pair on the
        // profile bar (W2). A fact about a relationship, so it is OMITTED, and
        // its query not run, for an anonymous reader and on your own profile
        // (security.md › widening a gated read omits the viewer's fields).
        viewerId && viewerId !== writer.id
          ? viewerRelation(viewerId, writer.id)
          : Promise.resolve(undefined),
      ])
      const counts = countsResult.rows[0]

      return reply.status(200).send({
        id: writer.id,
        pubkey: writer.nostr_pubkey,
        username: writer.username,
        displayName: writer.display_name,
        bio: writer.bio,
        avatar: writer.avatar_blossom_url,
        hostingType: writer.hosting_type,
        subscriptionPricePence: writer.subscription_price_pence,
        annualDiscountPct: writer.annual_discount_pct,
        showCommissionButton: writer.show_commission_button,
        articleCount: parseInt(counts.article_count, 10),
        hasPaywalledArticle: parseInt(counts.paywalled_count, 10) > 0,
        noteCount: parseInt(counts.note_count, 10),
        replyCount: parseInt(counts.reply_count, 10),
        followerCount: parseInt(counts.follower_count, 10),
        followingCount: parseInt(counts.following_count, 10),
        presences,
        ...(viewer ? { viewer } : {}),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/articles — writer's published articles
  //
  // Returns article metadata from the platform DB index.
  // The full content is on the relay; this endpoint serves feed/profile data.
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/articles',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      // Look up writer
      const writerResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts
         WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (writerResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that writer." })
      }

      const writerId = writerResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        nostr_d_tag: string
        title: string
        slug: string
        summary: string | null
        content_free: string | null
        word_count: number | null
        access_mode: string
        price_pence: number | null
        gate_position_pct: number | null
        published_at: Date | null
        pinned_on_profile: boolean
        profile_pin_order: number
      }>(
        `SELECT id, nostr_event_id, nostr_d_tag, title, slug, summary,
                content_free, word_count, access_mode, price_pence,
                gate_position_pct, published_at,
                pinned_on_profile, profile_pin_order
         FROM articles
         WHERE writer_id = $1 AND published_at IS NOT NULL AND deleted_at IS NULL
           AND (publication_id IS NULL OR show_on_writer_profile = TRUE)
         ORDER BY pinned_on_profile DESC, profile_pin_order ASC, published_at DESC
         LIMIT $2 OFFSET $3`,
        [writerId, limit, offset]
      )

      const articles = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        wordCount: r.word_count,
        accessMode: r.access_mode,
        isPaywalled: r.access_mode === 'paywalled',
        publishedAt: r.published_at?.toISOString() ?? null,
        pinnedOnProfile: r.pinned_on_profile,
        profilePinOrder: r.profile_pin_order,
      }))

      return reply.status(200).send({ articles, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/notes — writer's published notes
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/notes',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." })
      }

      const authorId = accountResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        content: string
        published_at: Date
        quoted_event_id: string | null
        quoted_event_kind: number | null
        quoted_excerpt: string | null
        quoted_title: string | null
        quoted_author: string | null
      }>(
        `SELECT id, nostr_event_id, content, published_at,
                quoted_event_id, quoted_event_kind,
                quoted_excerpt, quoted_title, quoted_author
         FROM notes
         WHERE author_id = $1
         ORDER BY published_at DESC
         LIMIT $2 OFFSET $3`,
        [authorId, limit, offset]
      )

      const notes = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        content: r.content,
        publishedAt: r.published_at.toISOString(),
        quotedEventId: r.quoted_event_id ?? undefined,
        quotedEventKind: r.quoted_event_kind ?? undefined,
        quotedExcerpt: r.quoted_excerpt ?? undefined,
        quotedTitle: r.quoted_title ?? undefined,
        quotedAuthor: r.quoted_author ?? undefined,
      }))

      return reply.status(200).send({ notes, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/replies — writer's published replies
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/replies',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." })
      }

      const authorId = accountResult.rows[0].id

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string
        content: string
        published_at: Date
        deleted_at: Date | null
        target_kind: number
        target_event_id: string
        article_slug: string | null
        article_title: string | null
        article_author_username: string | null
        article_author_display_name: string | null
        parent_event_id: string | null
        parent_author_username: string | null
        parent_author_display_name: string | null
      }>(
        `SELECT c.id, c.nostr_event_id, c.content, c.published_at, c.deleted_at,
                c.target_kind, c.target_event_id,
                ar.nostr_d_tag AS article_slug,
                ar.title AS article_title,
                aw.username AS article_author_username,
                aw.display_name AS article_author_display_name,
                pc.nostr_event_id AS parent_event_id,
                pa.username AS parent_author_username,
                pa.display_name AS parent_author_display_name
         FROM comments c
         LEFT JOIN articles ar
           ON ar.nostr_event_id = c.target_event_id
           AND c.target_kind = 30023
           AND ar.deleted_at IS NULL
         LEFT JOIN accounts aw ON aw.id = ar.writer_id
         LEFT JOIN comments pc ON pc.id = c.parent_comment_id
         LEFT JOIN accounts pa ON pa.id = pc.author_id
         WHERE c.author_id = $1
         ORDER BY c.published_at DESC
         LIMIT $2 OFFSET $3`,
        [authorId, limit, offset]
      )

      const replies = rows.map((r) => ({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        content: r.deleted_at ? '[deleted]' : r.content,
        publishedAt: r.published_at.toISOString(),
        isDeleted: !!r.deleted_at,
        targetKind: r.target_kind,
        targetEventId: r.target_event_id,
        articleSlug: r.article_slug ?? null,
        articleTitle: r.article_title ?? null,
        articleAuthorUsername: r.article_author_username ?? null,
        articleAuthorDisplayName: r.article_author_display_name ?? null,
        parentEventId: r.parent_event_id ?? null,
        parentAuthorUsername: r.parent_author_username ?? null,
        parentAuthorDisplayName: r.parent_author_display_name ?? null,
      }))

      return reply.status(200).send({ replies, limit, offset })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/by-pubkey/:pubkey — resolve pubkey → writer info
  //
  // Used by feed cards to resolve a Nostr pubkey to a display name.
  // The feed fetches articles from the relay (which only has pubkeys),
  // then the client resolves names via this endpoint.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { pubkey: string } }>(
    '/writers/by-pubkey/:pubkey',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { pubkey } = req.params

      if (!pubkey.match(/^[0-9a-f]{64}$/)) {
        return reply.status(400).send({ error: 'Invalid pubkey format' })
      }

      const { rows } = await pool.query<{
        username: string
        display_name: string | null
        avatar_blossom_url: string | null
      }>(
        `SELECT username, display_name, avatar_blossom_url
         FROM accounts
         WHERE nostr_pubkey = $1 AND status = 'active' AND ${ARRIVED}`,
        [pubkey]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that writer." })
      }

      const w = rows[0]
      return reply.status(200).send({
        username: w.username,
        displayName: w.display_name,
        avatar: w.avatar_blossom_url,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/followers — public follower list
  //
  // Returns a paginated list of accounts that follow this writer.
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/followers',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." })
      }

      const userId = accountResult.rows[0].id
      const isOwner = req.session?.sub === userId

      const [{ rows }, totalResult] = await Promise.all([
        pool.query<{
          id: string
          username: string
          display_name: string | null
          avatar_blossom_url: string | null
          nostr_pubkey: string
          followed_at: Date
          subscription_status: string | null
        }>(
          `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                  a.nostr_pubkey, f.followed_at,
                  s.status AS subscription_status
           FROM follows f
           JOIN accounts a ON a.id = f.follower_id
           LEFT JOIN subscriptions s
             ON s.reader_id = a.id AND s.writer_id = $1
             AND s.status IN ('active', 'cancelled')
           WHERE f.followee_id = $1 AND a.status = 'active'
           ORDER BY f.followed_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM follows f
           JOIN accounts a ON a.id = f.follower_id
           WHERE f.followee_id = $1 AND a.status = 'active'`,
          [userId]
        ),
      ])

      return reply.status(200).send({
        followers: rows.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          avatar: r.avatar_blossom_url,
          pubkey: r.nostr_pubkey,
          followedAt: r.followed_at.toISOString(),
          ...(isOwner && r.subscription_status ? { subscriptionStatus: r.subscription_status } : {}),
        })),
        total: parseInt(totalResult.rows[0].count, 10),
        limit,
        offset,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/following — public following list
  //
  // Returns a paginated list of accounts this user follows.
  //
  // The has_paywalled_article fragment below reads articles.WRITER_id (see
  // HAS_PAYWALLED_ARTICLE_SQL for which column decides the answer). There is no
  // articles.author_id, so the version that named one raised 42703 and the whole
  // route 500'd — and FollowingTab swallows a bad response into an empty list,
  // so the outage rendered as "Not following anyone yet": a claim about the
  // member, made by a broken query, on every profile there has ever been. It
  // surfaced the day the profile's button row started printing the count beside
  // the view it opens, because "9 FOLLOWING" over nobody is a contradiction a
  // reader can see and a swallowed 500 is not.
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/following',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." })
      }

      const userId = accountResult.rows[0].id

      const [{ rows }, totalResult] = await Promise.all([
        pool.query<{
          id: string
          username: string
          display_name: string | null
          avatar_blossom_url: string | null
          nostr_pubkey: string
          followed_at: Date
          subscription_price_pence: number
          has_paywalled_article: boolean
        }>(
          `SELECT a.id, a.username, a.display_name, a.avatar_blossom_url,
                  a.nostr_pubkey, f.followed_at,
                  a.subscription_price_pence,
                  ${HAS_PAYWALLED_ARTICLE_SQL} AS has_paywalled_article
           FROM follows f
           JOIN accounts a ON a.id = f.followee_id
           WHERE f.follower_id = $1 AND a.status = 'active'
           ORDER BY f.followed_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        ),
        pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM follows f
           JOIN accounts a ON a.id = f.followee_id
           WHERE f.follower_id = $1 AND a.status = 'active'`,
          [userId]
        ),
      ])

      return reply.status(200).send({
        following: rows.map((r) => ({
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          avatar: r.avatar_blossom_url,
          pubkey: r.nostr_pubkey,
          followedAt: r.followed_at.toISOString(),
          subscriptionPricePence: r.subscription_price_pence,
          hasPaywalledArticle: r.has_paywalled_article,
        })),
        total: parseInt(totalResult.rows[0].count, 10),
        limit,
        offset,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /writers/:username/subscriptions — public subscription list
  //
  // Returns subscriptions this user has to other writers (non-hidden only).
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { username: string }
    Querystring: { limit?: string; offset?: string }
  }>(
    '/writers/:username/subscriptions',
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { username } = req.params
      const limit = parseLimit(req.query.limit, 20, 50)
      const offset = parseOffset(req.query.offset)

      const accountResult = await pool.query<{ id: string }>(
        `SELECT id FROM accounts WHERE username = $1 AND status = 'active' AND ${ARRIVED}`,
        [username]
      )

      if (accountResult.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that account." })
      }

      const userId = accountResult.rows[0].id

      const { rows } = await pool.query<{
        writer_id: string
        writer_username: string
        writer_display_name: string | null
        writer_avatar: string | null
        started_at: Date
      }>(
        `SELECT s.writer_id, w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                s.started_at
         FROM subscriptions s
         JOIN accounts w ON w.id = s.writer_id
         WHERE s.reader_id = $1 AND s.status = 'active' AND s.hidden = FALSE
         ORDER BY s.started_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      )

      return reply.status(200).send({
        subscriptions: rows.map((r) => ({
          writerId: r.writer_id,
          writerUsername: r.writer_username,
          writerDisplayName: r.writer_display_name,
          writerAvatar: r.writer_avatar,
          startedAt: r.started_at.toISOString(),
        })),
        limit,
        offset,
      })
    }
  )
}
