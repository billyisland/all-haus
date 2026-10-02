import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction, loadConfig } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { signEvent } from '../../lib/key-custody-client.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { readNetSql, readFeeBpsSql } from '@platform-pub/shared/lib/per-read-net.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { isUuid } from '../../lib/request-inputs.js'

// =============================================================================
// Writer-side article management (dashboard, edit, soft-delete, pin, unpublish)
//
// GET    /my/articles               — List the authenticated writer's articles
// PATCH  /articles/:id              — Update article metadata (replies toggle)
// DELETE /articles/:id              — Soft-delete an article + kind 5 event
// POST   /articles/:id/pin          — Toggle pin on writer's profile
// POST   /articles/:id/unpublish    — Revert a personal article to draft
// =============================================================================

const PatchArticleSchema = z.object({
  repliesEnabled: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
})

export async function articleManageRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /my/articles — list the authenticated writer's articles
  //
  // Returns articles joined with comment counts and earnings data.
  // Used by the editorial dashboard.
  // ---------------------------------------------------------------------------

  app.get('/my/articles', { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub

    try {
      const { platformFeeBps } = await loadConfig()
      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag,
                a.nostr_event_id, a.access_mode, a.price_pence,
                a.word_count, a.published_at, a.comments_enabled,
                COALESCE(c.cnt, 0)::int AS comment_count,
                COALESCE(r.read_count, 0)::int AS read_count,
                COALESCE(r.net_earnings, 0)::int AS net_earnings_pence
         FROM articles a
         -- Both aggregates are LATERAL, per article (CA-G3): as uncorrelated
         -- derived tables they grouped EVERY comment and EVERY settled read on
         -- the platform before the join, since Postgres cannot push
         -- \`a.writer_id = $1\` into a subquery grouped on another key. Per
         -- article they ride idx_comments_target and idx_read_events_article_id.
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS cnt
           FROM comments
           WHERE deleted_at IS NULL AND target_event_id = a.nostr_event_id
         ) c ON true
         LEFT JOIN LATERAL (
           -- The column is called net_earnings and must mean it. It was
           -- SUM(amount_pence): the LIST price, with free-allowance pence the
           -- reader was never charged for, and no platform fee taken — so the
           -- dashboard's "Earned" overstated, and disagreed with the Ledger
           -- overlay on the very same reads. chargeable_pence through
           -- readNetSql, which is the one home for the per-read fee.
           -- The rate each read was SOLD at (migration 208), so this figure
           -- agrees with the payout to the penny even after a dial retune;
           -- $2 is the live dial, the fallback for a pre-stamp row.
           SELECT COUNT(*) AS read_count,
                  SUM(${readNetSql('chargeable_pence', readFeeBpsSql('', '$2'))}) AS net_earnings
           FROM read_events
           WHERE state IN ('platform_settled', 'writer_paid') AND article_id = a.id
         ) r ON true
         WHERE a.writer_id = $1 AND a.deleted_at IS NULL
         ORDER BY a.published_at DESC`,
        [writerId, platformFeeBps]
      )

      return reply.status(200).send({
        articles: rows.map(r => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          dTag: r.d_tag,
          nostrEventId: r.nostr_event_id,
          accessMode: r.access_mode,
          isPaywalled: r.access_mode === 'paywalled',
          pricePence: r.price_pence,
          wordCount: r.word_count,
          publishedAt: r.published_at?.toISOString() ?? null,
          repliesEnabled: r.comments_enabled,
          replyCount: r.comment_count,
          readCount: r.read_count,
          netEarningsPence: r.net_earnings_pence,
        })),
      })
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to load writer articles')
      return reply.status(500).send({ error: "Couldn't load your articles. Please try again." })
    }
  })

  // ---------------------------------------------------------------------------
  // PATCH /articles/:id — update article metadata
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      const parsed = PatchArticleSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error))
      }

      const writerId = req.session!.sub
      const body = parsed.data

      const updates: string[] = []
      const params: any[] = []
      let paramIdx = 1

      const repliesEnabledValue = body.repliesEnabled ?? body.commentsEnabled
      if (typeof repliesEnabledValue === 'boolean') {
        updates.push(`comments_enabled = $${paramIdx++}`)
        params.push(repliesEnabledValue)
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' })
      }

      params.push(req.params.id, writerId)
      const result = await pool.query(
        `UPDATE articles SET ${updates.join(', ')}, updated_at = now()
         WHERE id = $${paramIdx++} AND writer_id = $${paramIdx} AND deleted_at IS NULL
         RETURNING id`,
        params
      )

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      return reply.status(200).send({ ok: true })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /articles/:id — soft-delete an article
  //
  // Sets deleted_at on the articles row. Also publishes a Nostr kind 5
  // deletion event to signal to the relay and federated clients.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string } }>(
    '/articles/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      const { rows } = await pool.query<{ id: string; nostr_event_id: string; nostr_d_tag: string; nostr_pubkey: string }>(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.id = $1 AND a.writer_id = $2 AND a.deleted_at IS NULL`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      const article = rows[0]

      // Soft-delete all live rows for this d-tag (there may be duplicates from
      // previous publishes/edits that pre-date the unique-live-row constraint).
      // Dual-write to feed_items + enqueue the kind-5 tombstone in the same
      // transaction so a crash can't leave the DB marked deleted while the
      // relay still serves the article.
      const deletionEvent = await signEvent(writerId, {
        kind: 5,
        content: '',
        tags: [
          ['e', article.nostr_event_id],
          ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      })
      await withTransaction(async (client) => {
        await client.query(
          'UPDATE articles SET deleted_at = now() WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL',
          [writerId, article.nostr_d_tag]
        )
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE article_id IN (SELECT id FROM articles WHERE writer_id = $1 AND nostr_d_tag = $2)
             AND deleted_at IS NULL`,
          [writerId, article.nostr_d_tag]
        )
        await enqueueRelayPublish(client, {
          entityType: 'article_deletion',
          entityId: article.id,
          signedEvent: deletionEvent as SignedNostrEvent,
        })
      })

      logger.info(
        { articleId: article.id, nostrEventId: article.nostr_event_id, deletionEventId: deletionEvent.id, writerId },
        'Article soft-deleted and deletion event enqueued'
      )

      return reply.status(200).send({
        ok: true,
        deletedArticleId: article.id,
        nostrEventId: article.nostr_event_id,
        dTag: article.nostr_d_tag,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:id/pin — toggle pin on writer's profile
  //
  // Writers can pin articles to the top of their profile's Work tab.
  // Follows the same toggle pattern as POST /drives/:id/pin.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/articles/:id/pin',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      const writerId = req.session!.sub

      const result = await pool.query<{ id: string; pinned_on_profile: boolean }>(
        `UPDATE articles SET pinned_on_profile = NOT pinned_on_profile, updated_at = now()
         WHERE id = $1 AND writer_id = $2 AND deleted_at IS NULL
         RETURNING id, pinned_on_profile`,
        [req.params.id, writerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: "We couldn't find that article." })
      }

      return reply.status(200).send({ pinned: result.rows[0].pinned_on_profile })
    }
  )

  // ---------------------------------------------------------------------------
  // POST /articles/:id/unpublish — take a personal article off the site
  //
  // Clears published_at, drops the feed row, and TOMBSTONES THE EVENT. That
  // last part was missing: without a kind 5 the article stayed on the relay and
  // on every relay it had been fanned out to, so "unpublish" removed it from
  // all.haus and left it readable in any Nostr client — the one place a writer
  // taking a piece down cannot see, and the one that outlives us. The DELETE
  // route twenty lines up had it right; this one never did.
  //
  // `article_deletion` is the correct entity type rather than a new one: from
  // the relay's side these are the same act, and the constraint already permits
  // it, so no migration. What separates them here is that `deleted_at` stays
  // NULL — the row is still the writer's to edit and re-publish, and a
  // re-publish signs a NEW event whose created_at is later than this
  // tombstone's, which NIP-09 addressable deletion does not reach back over.
  //
  // All three writes are ONE transaction. Split, a crash between them leaves an
  // article unpublished in `articles` but still in the feed, or off the site
  // with the event still live — the same class the DELETE route's own comment
  // names.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    '/articles/:id/unpublish',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.status(404).send({ error: "We couldn't find that article, or it's already unpublished." })
      }

      const writerId = req.session!.sub

      const { rows } = await pool.query<{
        id: string
        nostr_event_id: string | null
        nostr_d_tag: string
        nostr_pubkey: string
      }>(
        `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, acc.nostr_pubkey
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.id = $1 AND a.writer_id = $2 AND a.deleted_at IS NULL
           AND a.published_at IS NOT NULL AND a.publication_id IS NULL`,
        [req.params.id, writerId]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that article, or it's already unpublished." })
      }

      const article = rows[0]

      // Signed outside the transaction (key-custody is a network call), the
      // same order the DELETE route uses. The `e` tag is omitted when the
      // article has no event id — an index row whose publish never completed —
      // since the `a` coordinate is what deletes an addressable event anyway.
      const deletionEvent = await signEvent(writerId, {
        kind: 5,
        content: '',
        tags: [
          ...(article.nostr_event_id ? [['e', article.nostr_event_id]] : []),
          ['a', `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      })

      await withTransaction(async (client) => {
        await client.query(
          `UPDATE articles SET published_at = NULL, updated_at = now()
           WHERE id = $1 AND writer_id = $2`,
          [article.id, writerId]
        )
        await client.query(
          'DELETE FROM feed_items WHERE article_id = $1',
          [article.id]
        )
        await enqueueRelayPublish(client, {
          entityType: 'article_deletion',
          entityId: article.id,
          signedEvent: deletionEvent as SignedNostrEvent,
        })
      })

      logger.info(
        { articleId: article.id, nostrEventId: article.nostr_event_id, deletionEventId: deletionEvent.id, writerId },
        'Article unpublished and tombstone enqueued'
      )

      return reply.status(200).send({ ok: true })
    }
  )
}
