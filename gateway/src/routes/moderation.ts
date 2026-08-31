import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth, invalidateAuthCache } from '../middleware/auth.js'
import { getAdminIds, requireAdmin } from '../middleware/admin.js'
import { signEvent } from '../lib/key-custody-client.js'
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from '@platform-pub/shared/lib/relay-outbox.js'
import logger from '@platform-pub/shared/lib/logger.js'

// -----------------------------------------------------------------------------
// Removal helpers — an admin removal must be as complete as the author's own
// delete paths (articles/manage.ts, notes.ts): un-publishing alone left the
// card, title and free body in every workspace feed (feed queries filter only
// on feed_items.deleted_at, never published_at) and left the full NIP-23 /
// kind-1 event served forever by the platform's own relay (no kind-5). So we
// (a) soft-delete the feed_items rows and (b) enqueue the kind-5 tombstone in
// the same transaction. Notes cascade out of feed_items on DELETE, so they only
// need the tombstone. Signed with the content author's own custodial key (the
// platform holds it), exactly as a self-delete would be.
//
// Two-phase (§0f-14, H4): PREPARE — select the removable set and sign every
// tombstone (one key-custody HTTP round-trip each) — runs OUTSIDE the caller's
// transaction, so a prolific account's hundreds of sign calls no longer hold a
// transaction open, and key-custody downtime fails the request cleanly instead
// of mid-transaction. APPLY — pure DB writes + outbox enqueues — is what runs
// inside the transaction (only the enqueue ever needed it). Content published
// in the tiny prepare→commit window escapes this sweep, but a suspension
// commits `status = 'suspended'` which blocks further publishing, and the
// admin surface can always re-run a removal.
// -----------------------------------------------------------------------------

interface RemovableArticle {
  id: string
  nostr_event_id: string | null
  nostr_d_tag: string | null
  writer_id: string
  nostr_pubkey: string
}

interface RemovableNote {
  id: string
  nostr_event_id: string | null
  author_id: string
}

interface PreparedRemoval {
  articles: Array<{ article: RemovableArticle; tombstone: SignedNostrEvent | null }>
  notes: Array<{ note: RemovableNote; tombstone: SignedNostrEvent | null }>
}

async function signRemovals(
  articles: RemovableArticle[],
  notes: RemovableNote[],
): Promise<PreparedRemoval> {
  const prepared: PreparedRemoval = { articles: [], notes: [] }
  for (const a of articles) {
    let tombstone: SignedNostrEvent | null = null
    if (a.nostr_event_id && a.nostr_d_tag) {
      tombstone = (await signEvent(a.writer_id, {
        kind: 5,
        content: '',
        tags: [
          ['e', a.nostr_event_id],
          ['a', `30023:${a.nostr_pubkey}:${a.nostr_d_tag}`],
        ],
        created_at: Math.floor(Date.now() / 1000),
      })) as SignedNostrEvent
    }
    prepared.articles.push({ article: a, tombstone })
  }
  for (const n of notes) {
    let tombstone: SignedNostrEvent | null = null
    if (n.nostr_event_id) {
      tombstone = (await signEvent(n.author_id, {
        kind: 5,
        content: '',
        tags: [['e', n.nostr_event_id]],
        created_at: Math.floor(Date.now() / 1000),
      })) as SignedNostrEvent
    }
    prepared.notes.push({ note: n, tombstone })
  }
  return prepared
}

// PREPARE one target by its Nostr event id (article or note). No transaction.
async function prepareContentRemovalByEventId(eventId: string): Promise<PreparedRemoval> {
  const { rows: articles } = await pool.query<RemovableArticle>(
    `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.writer_id, acc.nostr_pubkey
       FROM articles a JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.nostr_event_id = $1 AND a.deleted_at IS NULL`,
    [eventId]
  )
  const { rows: notes } = await pool.query<RemovableNote>(
    `SELECT id, nostr_event_id, author_id FROM notes WHERE nostr_event_id = $1`,
    [eventId]
  )
  return signRemovals(articles, notes)
}

// PREPARE all of an account's published articles + notes. No transaction.
async function prepareAllContentRemovalForAccount(accountId: string): Promise<PreparedRemoval> {
  const { rows: articles } = await pool.query<RemovableArticle>(
    `SELECT a.id, a.nostr_event_id, a.nostr_d_tag, a.writer_id, acc.nostr_pubkey
       FROM articles a JOIN accounts acc ON acc.id = a.writer_id
      WHERE a.writer_id = $1 AND a.published_at IS NOT NULL AND a.deleted_at IS NULL`,
    [accountId]
  )
  const { rows: notes } = await pool.query<RemovableNote>(
    `SELECT id, nostr_event_id, author_id FROM notes WHERE author_id = $1`,
    [accountId]
  )
  return signRemovals(articles, notes)
}

// APPLY a prepared removal: DB effects + outbox enqueues only — no external IO,
// safe to run inside the caller's transaction. Idempotent per row (UPDATE/
// DELETE by id), so re-applying after a retried transaction is harmless.
async function applyPreparedRemoval(client: PoolClient, prepared: PreparedRemoval): Promise<void> {
  for (const { article: a, tombstone } of prepared.articles) {
    await client.query(
      `UPDATE articles SET published_at = NULL, updated_at = now() WHERE id = $1`,
      [a.id]
    )
    await client.query(
      `UPDATE feed_items SET deleted_at = now() WHERE article_id = $1 AND deleted_at IS NULL`,
      [a.id]
    )
    if (tombstone) {
      await enqueueRelayPublish(client, {
        entityType: 'article_deletion',
        entityId: a.id,
        signedEvent: tombstone,
      })
    }
  }
  for (const { note: n, tombstone } of prepared.notes) {
    if (tombstone) {
      await enqueueRelayPublish(client, {
        entityType: 'note_deletion',
        entityId: n.id,
        signedEvent: tombstone,
      })
    }
    // Cascades to feed_items via feed_items_note_id_fkey ON DELETE CASCADE.
    await client.query(`DELETE FROM notes WHERE id = $1`, [n.id])
  }
}

// =============================================================================
// Moderation Routes
//
// Per ADR §I.5 (Minimum Viable Moderation at Launch):
//   - Report button on all content, feeding a human-reviewed queue
//   - Small set of report categories: illegal content, harassment, spam, other
//   - No automated action — human review only
//   - Platform ability to remove content and suspend accounts
//   - Manual operation by the founder is acceptable at launch
//
// POST   /reports                  — submit a report (any authenticated user)
// GET    /admin/reports            — list reports (founder/admin only)
// PATCH  /admin/reports/:reportId  — resolve a report (remove content / no action)
// POST   /admin/suspend/:accountId — suspend an account
// =============================================================================

const SubmitReportSchema = z.object({
  targetNostrEventId: z.string().optional(),
  targetAccountId: z.string().uuid().optional(),
  category: z.enum(['illegal_content', 'harassment', 'spam', 'other']),
  notes: z.string().max(2000).optional(),
})

const ResolveReportSchema = z.object({
  action: z.enum(['no_action', 'remove_content', 'suspend_account']),
  reason: z.string().max(1000).optional(),
})

export async function moderationRoutes(app: FastifyInstance) {
  const adminIds = await getAdminIds()
  if (adminIds.length === 0) {
    logger.warn('ADMIN_ACCOUNT_IDS is not set — all admin routes will return 403')
  }


  // ---------------------------------------------------------------------------
  // POST /reports — submit a content report
  //
  // Per ADR: "Any reader can report content using the report button present
  // on every article, note, and comment. Reports are reviewed by a human —
  // there is no automated removal."
  // ---------------------------------------------------------------------------

  app.post('/reports', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SubmitReportSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const reporterId = req.session!.sub
    const data = parsed.data

    if (!data.targetNostrEventId && !data.targetAccountId) {
      return reply.status(400).send({ error: 'Must specify targetNostrEventId or targetAccountId' })
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO moderation_reports (
         reporter_id, target_nostr_event_id, target_account_id,
         category, notes, status
       ) VALUES ($1, $2, $3, $4, $5, 'open')
       RETURNING id`,
      [
        reporterId,
        data.targetNostrEventId ?? null,
        data.targetAccountId ?? null,
        data.category,
        data.notes ?? null,
      ]
    )

    logger.info(
      { reportId: rows[0].id, category: data.category, reporterId },
      'Report submitted'
    )

    return reply.status(201).send({ reportId: rows[0].id })
  })

  // ---------------------------------------------------------------------------
  // GET /admin/reports — list reports (admin only)
  //
  // Returns open and under_review reports, newest first.
  // Resolved reports are excluded by default (pass ?all=true to include).
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { all?: string; limit?: string; offset?: string } }>(
    '/admin/reports',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const showAll = req.query.all === 'true'
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100)
      const offset = parseInt(req.query.offset ?? '0', 10)

      const statusFilter = showAll
        ? ''
        : `AND r.status IN ('open', 'under_review')`

      const { rows } = await pool.query<{
        id: string
        reporter_username: string | null
        target_nostr_event_id: string | null
        target_account_username: string | null
        target_account_id: string | null
        category: string
        notes: string | null
        status: string
        created_at: Date
        reviewed_at: Date | null
      }>(
        `SELECT r.id, reporter.username AS reporter_username,
                r.target_nostr_event_id,
                target_acct.username AS target_account_username,
                r.target_account_id,
                r.category, r.notes, r.status,
                r.created_at, r.reviewed_at
         FROM moderation_reports r
         LEFT JOIN accounts reporter ON reporter.id = r.reporter_id
         LEFT JOIN accounts target_acct ON target_acct.id = r.target_account_id
         WHERE 1=1 ${statusFilter}
         ORDER BY r.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      )

      // Count open reports
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM moderation_reports WHERE status = 'open'`
      )

      return reply.status(200).send({
        reports: rows.map((r) => ({
          id: r.id,
          reporterUsername: r.reporter_username,
          targetNostrEventId: r.target_nostr_event_id,
          targetAccountUsername: r.target_account_username,
          targetAccountId: r.target_account_id,
          category: r.category,
          notes: r.notes,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          reviewedAt: r.reviewed_at?.toISOString() ?? null,
        })),
        openCount: parseInt(countResult.rows[0].count, 10),
        limit,
        offset,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /admin/reports/:reportId — resolve a report
  //
  // Actions:
  //   no_action        — content stays, report closed
  //   remove_content   — content removed from platform relay + DB index
  //   suspend_account  — account suspended, all content removed
  //
  // Per ADR: "We do not remove content silently. Writers are informed of
  // enforcement actions and the reason for them."
  //
  // Per ADR enforcement rules:
  //   - Content removed from platform relay and surfaces
  //   - Nostr identity (keypair) intact
  //   - Settled earnings paid out on normal schedule
  //   - Accrued-but-unsettled earnings held pending review
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { reportId: string } }>(
    '/admin/reports/:reportId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = ResolveReportSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const adminId = req.session!.sub
      const { reportId } = req.params
      const { action } = parsed.data

      // Set inside the transaction, invalidated after COMMIT — an in-txn
      // invalidate races a concurrent request re-caching the pre-commit row.
      let suspendedAccountId: string | null = null

      // Read the report + PREPARE the removal (select + sign every tombstone
      // via key-custody) BEFORE the transaction (§0f-14): the sign loop is one
      // HTTP round-trip per item, so a prolific account held a transaction
      // open across hundreds of calls — and key-custody downtime failed the
      // resolution mid-transaction. The status is re-checked inside the
      // transaction, so a concurrent resolve still loses cleanly (409).
      const preRead = await pool.query<{
        id: string
        target_nostr_event_id: string | null
        target_account_id: string | null
        status: string
      }>(
        'SELECT id, target_nostr_event_id, target_account_id, status FROM moderation_reports WHERE id = $1',
        [reportId]
      )
      if (preRead.rows.length === 0) {
        return reply.status(404).send({ error: 'Report not found' })
      }
      const report = preRead.rows[0]
      if (report.status === 'resolved_removed' || report.status === 'resolved_no_action') {
        return reply.status(409).send({ error: 'Report already resolved' })
      }

      let prepared: PreparedRemoval | null = null
      if (action === 'remove_content' && report.target_nostr_event_id) {
        prepared = await prepareContentRemovalByEventId(report.target_nostr_event_id)
      } else if (action === 'suspend_account' && report.target_account_id) {
        prepared = await prepareAllContentRemovalForAccount(report.target_account_id)
      }

      const result = await withTransaction(async (client) => {
        // Re-check under lock: only one resolver may move the report out of
        // its open state (the pre-read above was advisory).
        const { rows: current } = await client.query<{ status: string }>(
          'SELECT status FROM moderation_reports WHERE id = $1 FOR UPDATE',
          [reportId]
        )
        if (current.length === 0) {
          return reply.status(404).send({ error: 'Report not found' })
        }
        if (current[0].status === 'resolved_removed' || current[0].status === 'resolved_no_action') {
          return reply.status(409).send({ error: 'Report already resolved' })
        }

        let resolvedStatus: string

        switch (action) {
          case 'no_action':
            resolvedStatus = 'resolved_no_action'
            break

          case 'remove_content':
            resolvedStatus = 'resolved_removed'

            // Remove from every workspace feed AND the relay (kind-5), not just
            // un-publish — see the removal-helper header.
            if (prepared) {
              await applyPreparedRemoval(client, prepared)

              logger.info(
                { nostrEventId: report.target_nostr_event_id, reportId },
                'Content removed from platform surfaces + relay'
              )
            }
            break

          case 'suspend_account':
            resolvedStatus = 'resolved_removed'

            if (report.target_account_id) {
              // Suspend the account. Cache invalidation happens AFTER the
              // transaction commits (see below) — invalidating here left a
              // window where a request from the target re-read the still-
              // 'active' row and re-cached it for a full TTL (2026-07-06 audit).
              await client.query(
                `UPDATE accounts SET status = 'suspended', updated_at = now()
                 WHERE id = $1`,
                [report.target_account_id]
              )
              suspendedAccountId = report.target_account_id

              // Remove all their content from every feed AND the relay.
              if (prepared) await applyPreparedRemoval(client, prepared)

              logger.info(
                { accountId: report.target_account_id, reportId },
                'Account suspended — content removed from platform surfaces + relay'
              )
            }
            break
        }

        // Update the report
        await client.query(
          `UPDATE moderation_reports
           SET status = $1, reviewed_by = $2, reviewed_at = now()
           WHERE id = $3`,
          [resolvedStatus!, adminId, reportId]
        )

        return reply.status(200).send({
          reportId,
          status: resolvedStatus!,
          action,
        })
      })
      if (suspendedAccountId) invalidateAuthCache(suspendedAccountId)
      return result
    }
  )

  // ---------------------------------------------------------------------------
  // POST /admin/suspend/:accountId — suspend an account directly
  // (without a report — for cases the founder discovers directly)
  // ---------------------------------------------------------------------------

  app.post<{ Params: { accountId: string } }>(
    '/admin/suspend/:accountId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { accountId } = req.params

      // Sign all tombstones before the transaction (§0f-14) — see the
      // removal-helper header.
      const prepared = await prepareAllContentRemovalForAccount(accountId)

      const result = await withTransaction(async (client) => {
        await client.query(
          `UPDATE accounts SET status = 'suspended', updated_at = now() WHERE id = $1`,
          [accountId]
        )
        await applyPreparedRemoval(client, prepared)

        logger.info({ accountId, adminId: req.session!.sub }, 'Account suspended directly')

        return reply.status(200).send({ ok: true, accountId, status: 'suspended' })
      })
      // After COMMIT — an in-txn invalidate races a concurrent request
      // re-caching the pre-commit 'active' row for a full TTL.
      invalidateAuthCache(accountId)
      return result
    }
  )
}
