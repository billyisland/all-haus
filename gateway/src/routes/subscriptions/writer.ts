import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../../middleware/auth.js'
import { signSubscriptionEvent } from '../../lib/nostr-publisher.js'
import { enqueueRelayPublish } from '@platform-pub/shared/lib/relay-outbox.js'
import { sendSubscriptionCancelledEmail, sendNewSubscriberEmail, sendSubscriptionWelcomeEmail } from '@platform-pub/shared/lib/subscription-emails.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { anchorDayOf, firstPeriodEnd } from '@platform-pub/shared/lib/subscription-period.js'
import { logSubscriptionCharge } from './shared.js'

// =============================================================================
// Reader → writer subscription lifecycle
//
// POST   /subscriptions/:writerId              — Subscribe to a writer
// DELETE /subscriptions/:writerId              — Cancel subscription
// GET    /subscriptions/mine                   — List my subscriptions
// GET    /subscriptions/check/:writerId        — Check subscription status
// PATCH  /subscriptions/:writerId/visibility   — Toggle hidden flag
// PATCH  /subscriptions/:id/notifications      — Toggle email-on-publish
// =============================================================================

const VisibilitySchema = z.object({
  hidden: z.boolean(),
})

const NotifySchema = z.object({
  notifyOnPublish: z.boolean(),
})

export async function subscriptionWriterRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /subscriptions/:writerId — subscribe to a writer
  //
  // Charges immediately for the first month. Creates the subscription record
  // and logs a subscription_charge (debit) and subscription_earning (credit).
  // ---------------------------------------------------------------------------

  app.post<{ Params: { writerId: string }; Body: { period?: string; offerCode?: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { writerId } = req.params
      const body = req.body as { period?: string; offerCode?: string }
      const period = body?.period === 'annual' ? 'annual' : 'monthly'
      const offerCode = body?.offerCode

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      return withTransaction(async (client) => {
        // Collection gate (2026-07-06 audit P0): a subscription charge is pure
        // tab debt with no free-allowance leg — it is only ever collected by
        // settlement, which skips accounts without a card (checkAndSettle
        // returns early on a missing stripe_customer_id). So a card on file is
        // a precondition of subscribing at all, the subscription twin of the F3
        // gate-pass floor. 402 mirrors the gate-pass payment_required shape.
        const cardRow = await client.query<{ stripe_customer_id: string | null }>(
          `SELECT stripe_customer_id FROM accounts WHERE id = $1`,
          [readerId]
        )
        if (!cardRow.rows[0]?.stripe_customer_id) {
          return reply.status(402).send({ error: 'card_required' })
        }

        // Check writer exists and get their subscription price
        const writerResult = await client.query<{
          id: string
          subscription_price_pence: number
          annual_discount_pct: number
          display_name: string | null
          username: string
          nostr_pubkey: string
        }>(
          `SELECT id, subscription_price_pence, annual_discount_pct, display_name, username, nostr_pubkey
           FROM accounts WHERE id = $1 AND status = 'active'`,
          [writerId]
        )

        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const writer = writerResult.rows[0]
        const monthlyPrice = writer.subscription_price_pence
        let pricePence = period === 'annual'
          ? Math.round(monthlyPrice * 12 * (1 - writer.annual_discount_pct / 100))
          : monthlyPrice

        // Validate and apply offer if provided
        let offerId: string | null = null
        let offerPeriodsRemaining: number | null = null

        if (offerCode) {
          const offerResult = await client.query<{
            id: string; mode: string; discount_pct: number; duration_months: number | null
            max_redemptions: number | null; redemption_count: number; expires_at: Date | null
            recipient_id: string | null
          }>(
            `SELECT id, mode, discount_pct, duration_months, max_redemptions,
                    redemption_count, expires_at, recipient_id
             FROM subscription_offers
             WHERE code = $1 AND writer_id = $2 AND revoked_at IS NULL`,
            [offerCode, writerId]
          )

          if (offerResult.rows.length === 0) {
            return reply.status(404).send({ error: 'Offer not found or no longer available' })
          }

          const offer = offerResult.rows[0]

          if (offer.expires_at && new Date(offer.expires_at) < new Date()) {
            return reply.status(410).send({ error: 'This offer has expired' })
          }
          if (offer.max_redemptions !== null && offer.redemption_count >= offer.max_redemptions) {
            return reply.status(410).send({ error: 'This offer has been fully redeemed' })
          }
          if (offer.mode === 'grant' && offer.recipient_id !== readerId) {
            return reply.status(403).send({ error: 'This offer is not available to you' })
          }

          pricePence = Math.round(pricePence * (1 - offer.discount_pct / 100))
          offerId = offer.id
          offerPeriodsRemaining = offer.duration_months ?? null

          // Increment redemption count atomically
          await client.query(
            `UPDATE subscription_offers SET redemption_count = redemption_count + 1 WHERE id = $1`,
            [offer.id]
          )
        }

        // Check for existing subscription (any status — unique constraint on reader+writer)
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE reader_id = $1 AND writer_id = $2`,
          [readerId, writerId]
        )

        if (existing.rows.length > 0) {
          const sub = existing.rows[0]
          if (sub.status === 'active') {
            return reply.status(409).send({ error: 'Already subscribed' })
          }
          // Re-activate a cancelled or expired subscription. A re-activation
          // starts a fresh run of periods, so it re-anchors on today (§1.5).
          const now = new Date()
          const anchorDay = anchorDayOf(now)
          const periodEnd = firstPeriodEnd(now, period)

          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = $5,
                 offer_id = $6, offer_periods_remaining = $7,
                 period_anchor_day = $8, updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, pricePence, sub.id, period, offerId, offerPeriodsRemaining, anchorDay]
          )

          // F1: charge the reading tab (inside logSubscriptionCharge), not the
          // dead free_allowance column — so the charge is actually collected.
          await logSubscriptionCharge(client, sub.id, readerId, writerId, pricePence, now, periodEnd)

          logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription reactivated')

          pool.query(
            `INSERT INTO notifications (recipient_id, actor_id, type)
             VALUES ($1, $2, 'new_subscriber')
             ON CONFLICT DO NOTHING`,
            [writerId, readerId]
          ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

          // Sign the attestation and hand off to relay_outbox for durable
          // publish. Same transaction → enqueue is rolled back on error.
          const readerPubkey = req.session!.pubkey
          const reactivateEvent = signSubscriptionEvent({
            subscriptionId: sub.id,
            readerPubkey,
            writerPubkey: writer.nostr_pubkey,
            status: 'active',
            pricePence,
            periodStart: now,
            periodEnd,
          })
          await client.query(
            `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
            [reactivateEvent.id, sub.id]
          )
          await enqueueRelayPublish(client, {
            entityType: 'subscription',
            entityId: sub.id,
            signedEvent: reactivateEvent,
          })

          // Notify writer of new subscriber — non-blocking
          sendNewSubscriberEmail(writerId, readerId, pricePence).catch(err =>
            logger.warn({ err, subscriptionId: sub.id }, 'New subscriber email failed')
          )

          // And the reader's half of that exchange, in the writer's own words
          // (§4.2). Non-blocking for the same reason: an email provider having
          // a bad minute must not fail a subscription that is already charged,
          // signed and enqueued. `trackSend` counts the attempt either way.
          sendSubscriptionWelcomeEmail(readerId, writerId).catch(err =>
            logger.warn({ err, subscriptionId: sub.id }, 'Subscription welcome email failed')
          )

          return reply.status(200).send({ subscriptionId: sub.id, status: 'active', pricePence })
        }

        // Create new subscription
        const now = new Date()
        const periodEnd = firstPeriodEnd(now, period)

        const subResult = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
             current_period_start, current_period_end, subscription_period,
             offer_id, offer_periods_remaining, period_anchor_day)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [readerId, writerId, pricePence, now, periodEnd, period, offerId, offerPeriodsRemaining, anchorDayOf(now)]
        )

        const subscriptionId = subResult.rows[0].id

        // F1: charge the reading tab (inside logSubscriptionCharge), not the
        // dead free_allowance column — so the charge is actually collected.
        await logSubscriptionCharge(client, subscriptionId, readerId, writerId, pricePence, now, periodEnd)

        logger.info({ readerId, writerId, subscriptionId, pricePence }, 'Subscription created')

        pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_subscriber')
           ON CONFLICT DO NOTHING`,
          [writerId, readerId]
        ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

        // Sign the attestation and hand off to relay_outbox for durable
        // publish. Same transaction → enqueue is rolled back on error.
        const readerPubkey = req.session!.pubkey
        const createEvent = signSubscriptionEvent({
          subscriptionId,
          readerPubkey,
          writerPubkey: writer.nostr_pubkey,
          status: 'active',
          pricePence,
          periodStart: now,
          periodEnd,
        })
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [createEvent.id, subscriptionId]
        )
        await enqueueRelayPublish(client, {
          entityType: 'subscription',
          entityId: subscriptionId,
          signedEvent: createEvent,
        })

        // Notify writer of new subscriber — non-blocking
        sendNewSubscriberEmail(writerId, readerId, pricePence).catch(err =>
          logger.warn({ err, subscriptionId }, 'New subscriber email failed')
        )

        // And the reader's half of that exchange (§4.2) — see the reactivate
        // path above. Both paths send it: a reader returning after a lapse is
        // being welcomed back, and is exactly as much owed the writer's words
        // as a first-time subscriber.
        sendSubscriptionWelcomeEmail(readerId, writerId).catch(err =>
          logger.warn({ err, subscriptionId }, 'Subscription welcome email failed')
        )

        return reply.status(201).send({
          subscriptionId,
          status: 'active',
          pricePence,
          currentPeriodEnd: periodEnd.toISOString(),
          writerName: writer.display_name ?? writer.username,
        })
      })
    }
  )

  // ---------------------------------------------------------------------------
  // DELETE /subscriptions/:writerId — cancel subscription
  //
  // Sets auto_renew to false and status to 'cancelled'. Access continues
  // until current_period_end, then the subscription expires instead of renewing.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { writerId } = req.params

      const cancelled = await withTransaction(async (client) => {
        const result = await client.query<{
          id: string
          current_period_end: Date
          current_period_start: Date
          price_pence: number
          writer_pubkey: string
        }>(
          `UPDATE subscriptions
           SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
           WHERE reader_id = $1 AND writer_id = $2 AND status = 'active'
           RETURNING id, current_period_end, current_period_start, price_pence,
                     (SELECT nostr_pubkey FROM accounts WHERE id = $2) AS writer_pubkey`,
          [readerId, writerId]
        )

        if (result.rowCount === 0) return null

        const sub = result.rows[0]

        const readerPubkey = req.session!.pubkey
        const cancelEvent = signSubscriptionEvent({
          subscriptionId: sub.id,
          readerPubkey,
          writerPubkey: sub.writer_pubkey,
          status: 'cancelled',
          pricePence: sub.price_pence,
          periodStart: sub.current_period_start,
          periodEnd: sub.current_period_end,
        })
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [cancelEvent.id, sub.id]
        )
        await enqueueRelayPublish(client, {
          entityType: 'subscription',
          entityId: sub.id,
          signedEvent: cancelEvent,
        })

        return sub
      })

      if (!cancelled) {
        return reply.status(404).send({ error: 'No active subscription found' })
      }

      logger.info({ readerId, writerId, subscriptionId: cancelled.id }, 'Subscription cancelled')

      sendSubscriptionCancelledEmail(readerId, writerId, cancelled.current_period_end).catch(err =>
        logger.warn({ err, subscriptionId: cancelled.id }, 'Cancellation email failed')
      )

      return reply.status(200).send({
        subscriptionId: cancelled.id,
        status: 'cancelled',
        accessUntil: cancelled.current_period_end.toISOString(),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscriptions/mine — list my active/cancelled subscriptions
  // ---------------------------------------------------------------------------

  app.get(
    '/subscriptions/mine',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub

      const { rows } = await pool.query<{
        id: string
        writer_id: string
        writer_username: string
        writer_display_name: string | null
        writer_avatar: string | null
        price_pence: number
        status: string
        auto_renew: boolean
        current_period_end: Date
        started_at: Date
        cancelled_at: Date | null
        hidden: boolean
        notify_on_publish: boolean
      }>(
        `SELECT s.id, s.writer_id, w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                s.price_pence, s.status, s.auto_renew, s.current_period_end,
                s.started_at, s.cancelled_at, s.hidden, s.notify_on_publish
         FROM subscriptions s
         JOIN accounts w ON w.id = s.writer_id
         WHERE s.reader_id = $1 AND s.status IN ('active', 'cancelled')
         ORDER BY s.started_at DESC`,
        [readerId]
      )

      return reply.status(200).send({
        subscriptions: rows.map(s => ({
          id: s.id,
          writerId: s.writer_id,
          writerUsername: s.writer_username,
          writerDisplayName: s.writer_display_name,
          writerAvatar: s.writer_avatar,
          pricePence: s.price_pence,
          status: s.status,
          autoRenew: s.auto_renew,
          currentPeriodEnd: s.current_period_end.toISOString(),
          startedAt: s.started_at.toISOString(),
          cancelledAt: s.cancelled_at?.toISOString() ?? null,
          hidden: s.hidden,
          notifyOnPublish: s.notify_on_publish,
        })),
      })
    }
  )

  // ---------------------------------------------------------------------------
  // GET /subscriptions/check/:writerId — check subscription status
  //
  // Returns whether the current user has an active (or cancelled-but-valid)
  // subscription to the given writer.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { writerId: string } }>(
    '/subscriptions/check/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { writerId } = req.params

      // Own content is always free
      if (readerId === writerId) {
        return reply.status(200).send({ subscribed: false, ownContent: true })
      }

      const { rows } = await pool.query<{
        id: string
        status: string
        current_period_end: Date
        price_pence: number
      }>(
        `SELECT id, status, current_period_end, price_pence
         FROM subscriptions
         WHERE reader_id = $1 AND writer_id = $2
           AND status IN ('active', 'cancelled')
           AND current_period_end > now()`,
        [readerId, writerId]
      )

      if (rows.length === 0) {
        return reply.status(200).send({ subscribed: false })
      }

      const sub = rows[0]
      return reply.status(200).send({
        subscribed: true,
        subscriptionId: sub.id,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end.toISOString(),
        pricePence: sub.price_pence,
      })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /subscriptions/:writerId/visibility — toggle subscription visibility
  //
  // Readers can hide or show individual subscriptions on their public profile.
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { writerId: string } }>(
    '/subscriptions/:writerId/visibility',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { writerId } = req.params

      const parsed = VisibilitySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const result = await pool.query(
        `UPDATE subscriptions SET hidden = $1, updated_at = now()
         WHERE reader_id = $2 AND writer_id = $3 AND status IN ('active', 'cancelled')
         RETURNING id`,
        [parsed.data.hidden, readerId, writerId]
      )

      if ((result.rowCount ?? 0) === 0) {
        return reply.status(404).send({ error: 'Subscription not found' })
      }

      return reply.status(200).send({ ok: true, hidden: parsed.data.hidden })
    }
  )

  // ---------------------------------------------------------------------------
  // PATCH /subscriptions/:id/notifications — toggle email-on-publish
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string } }>(
    '/subscriptions/:id/notifications',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { id: subscriptionId } = req.params
      const parsed = NotifySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() })
      }

      const result = await pool.query(
        `UPDATE subscriptions
         SET notify_on_publish = $1, updated_at = now()
         WHERE id = $2 AND reader_id = $3 AND status = 'active'
         RETURNING id`,
        [parsed.data.notifyOnPublish, subscriptionId, readerId]
      )

      if (result.rowCount === 0) {
        return reply.status(404).send({ error: 'Subscription not found' })
      }

      return reply.send({ ok: true, notifyOnPublish: parsed.data.notifyOnPublish })
    }
  )
}
