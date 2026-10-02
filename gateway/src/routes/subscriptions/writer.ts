import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import type { PoolClient } from 'pg'
import { requireAuth } from '../../middleware/auth.js'
import { writerAdmittedSql } from '../../lib/writer-gate.js'
import { signSubscriptionEvent } from '../../lib/nostr-publisher.js'
import { enqueueRelayPublish } from '@platform-pub/shared/lib/relay-outbox.js'
import { sendSubscriptionCancelledEmail, sendNewSubscriberEmail, sendSubscriptionWelcomeEmail } from '@platform-pub/shared/lib/subscription-emails.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { anchorDayOf, firstPeriodEnd, type SubscriptionPeriodKind } from '@platform-pub/shared/lib/subscription-period.js'
import { logSubscriptionCharge } from './shared.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { readerTermsOutstanding, READER_TERMS_REQUIRED } from '../../lib/terms-gate.js'
import { blockExistsBetween } from '../../lib/blocks.js'

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

// =============================================================================
// Cancel a reader→writer subscription at the end of its current period — the
// one home, because two acts reach it: the reader's own unsubscribe (below)
// and a BLOCK between the pair (`social.ts`), whichever of them set it.
//
// Nothing is refunded and nothing is charged: `auto_renew` goes FALSE, so the
// expiry worker closes the row at `current_period_end` instead of renewing it,
// and access runs to that date. The kind-7003 cancellation is signed by the
// SERVICE key (`signSubscriptionEvent`), so it needs no session from either
// party — the reader pubkey is read off the account, not off a request.
// Runs on the caller's client; null when there was no active subscription.
// =============================================================================
export async function cancelAtPeriodEnd(
  client: PoolClient,
  readerId: string,
  writerId: string,
): Promise<{ id: string; current_period_end: Date } | null> {
  const result = await client.query<{
    id: string
    current_period_end: Date
    current_period_start: Date
    price_pence: number
    writer_pubkey: string
    reader_pubkey: string
  }>(
    `UPDATE subscriptions
     SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
     WHERE reader_id = $1 AND writer_id = $2 AND status = 'active'
     RETURNING id, current_period_end, current_period_start, price_pence,
               (SELECT nostr_pubkey FROM accounts WHERE id = $2) AS writer_pubkey,
               (SELECT nostr_pubkey FROM accounts WHERE id = $1) AS reader_pubkey`,
    [readerId, writerId]
  )

  if (result.rowCount === 0) return null

  const sub = result.rows[0]

  const cancelEvent = signSubscriptionEvent({
    subscriptionId: sub.id,
    readerPubkey: sub.reader_pubkey,
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

  return { id: sub.id, current_period_end: sub.current_period_end }
}

export async function subscriptionWriterRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /subscriptions/:writerId — subscribe to a writer
  //
  // Three arms, decided on the reader's existing row read under a row lock:
  //   • none, or expired      → create / re-activate: a fresh period anchored
  //                             on today, charged now (subscription_charge
  //                             debit + subscription_earning credit)
  //   • cancelled, period ended (the hourly worker has not marked it expired
  //                             yet) → the same re-activation
  //   • cancelled, PAID UP     → restore: the cancellation undone, the period
  //                             and price as they were, NOTHING charged
  // Every refusal is answered inside the transaction (reads only); every
  // side effect of a success — the writer's notice, both emails, the 20x —
  // waits for COMMIT.
  // ---------------------------------------------------------------------------

  type SubscribeOutcome = {
    code: 200 | 201
    /** false on a restore: the writer never lost this subscriber. */
    notify: boolean
    pricePence: number
    subscriptionId: string
    body: Record<string, unknown>
  }
  const isOutcome = (v: unknown): v is SubscribeOutcome =>
    typeof v === 'object' && v !== null && 'notify' in v && 'body' in v

  app.post<{ Params: { writerId: string }; Body: { period?: string; offerCode?: string } }>(
    '/subscriptions/:writerId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { writerId } = req.params
      const body = req.body as { period?: string; offerCode?: string }
      let period: SubscriptionPeriodKind = body?.period === 'annual' ? 'annual' : 'monthly'
      const offerCode = body?.offerCode

      if (readerId === writerId) {
        return reply.status(400).send({ error: 'Cannot subscribe to yourself' })
      }

      const outcome = await withTransaction(async (client): Promise<SubscribeOutcome | FastifyReply> => {
        // Check writer exists and get their subscription price. A READER is not
        // sold (READER-WRITER-SPLIT-ADR §5): the recipient predicate rides this
        // lookup beside `status = 'active'` and answers the same 404 as any
        // other target that cannot be subscribed to — a fact about the object,
        // so before the offer, the block check and the card (money.md).
        const writerResult = await client.query<{
          id: string
          subscription_price_pence: number
          annual_discount_pct: number
          display_name: string | null
          username: string
          nostr_pubkey: string
          paid_access_withdrawn_at: Date | null
        }>(
          `SELECT id, subscription_price_pence, annual_discount_pct, display_name, username, nostr_pubkey,
                  paid_access_withdrawn_at
           FROM accounts a WHERE a.id = $1 AND a.status = 'active' AND ${writerAdmittedSql('a')}`,
          [writerId]
        )

        if (writerResult.rows.length === 0) {
          return reply.status(404).send({ error: 'Writer not found' })
        }

        const writer = writerResult.rows[0]

        // Blocks, BOTH ways, through the one home (lib/blocks.ts), before the
        // offer is read or the card is asked. A block lets any subscription
        // between the pair lapse at period end (`cancelAtPeriodEnd`, called from
        // social.ts) — and until this check nothing stopped the reader pressing
        // subscribe again the day after the lapse, which undoes the block's own
        // consequence and hands the writer a `new_subscriber` notice from the
        // person they blocked. One neutral refusal, naming neither direction.
        if (await blockExistsBetween(readerId, writerId, client)) {
          return reply.status(403).send({ error: 'You cannot subscribe to this writer' })
        }

        const monthlyPrice = writer.subscription_price_pence
        let pricePence = period === 'annual'
          ? Math.round(monthlyPrice * 12 * (1 - writer.annual_discount_pct / 100))
          : monthlyPrice

        // Validate and apply offer if provided
        let offerId: string | null = null
        let offerPeriodsRemaining: number | null = null
        // A COMP redeemed (MIRROR-AUDIT §2.12, migration 193): the reader
        // accepting the gift a writer offered. Free, one calendar year, and it
        // ENDS — auto_renew FALSE, so the expiry worker's phase 2 closes it and
        // no renewal ever charges. That is what separates it from a
        // 100%-discount offer, which is a price on a subscription that renews.
        let isComp = false

        if (offerCode) {
          const offerResult = await client.query<{
            id: string; mode: string; discount_pct: number; duration_months: number | null
            max_redemptions: number | null; redemption_count: number; expires_at: Date | null
            recipient_id: string | null; is_comp: boolean
          }>(
            `SELECT id, mode, discount_pct, duration_months, max_redemptions,
                    redemption_count, expires_at, recipient_id, is_comp
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

          offerId = offer.id
          isComp = offer.is_comp

          if (isComp) {
            // Not `Math.round(price * 0)` — the comp's price is 0 because it is
            // a comp, not because a discount happened to land there, and the
            // card carve-out below is keyed on the same fact. The offer's shape
            // (grant · 100% · one recipient · one redemption) is held by
            // subscription_offers_comp_shape and is not re-derived here.
            pricePence = 0
            period = 'annual'
            offerPeriodsRemaining = null
          } else {
            pricePence = Math.round(pricePence * (1 - offer.discount_pct / 100))
            offerPeriodsRemaining = offer.duration_months ?? null
          }
        }

        // Collection gate (2026-07-06 audit P0): a subscription charge is pure
        // tab debt with no free-allowance leg — it is only ever collected by
        // settlement, which skips accounts without a card (checkAndSettle
        // returns early on a missing stripe_customer_id). So a card on file is
        // a precondition of subscribing at all, the subscription twin of the F3
        // gate-pass floor. 402 mirrors the gate-pass payment_required shape.
        //
        // A COMP IS THE ONE EXEMPTION, and it is narrow by construction: it
        // charges 0 now and can never charge later, because auto_renew is FALSE
        // and the expiry worker's phase 2 expires such a row rather than
        // renewing it. There is no debt for a card to collect. Requiring one
        // would also make the gift unusable for exactly the readers it is for —
        // a comp is what a writer offers someone who has not put a card down.
        // Asserted rather than assumed: the branch below must charge nothing.
        if (!isComp) {
          const cardRow = await client.query<{
            stripe_customer_id: string | null
            card_action_required_at: Date | null
          }>(
            `SELECT stripe_customer_id, card_action_required_at FROM accounts WHERE id = $1`,
            [readerId]
          )
          if (!cardRow.rows[0]?.stripe_customer_id) {
            return reply.status(402).send({ error: 'card_required' })
          }
          // Reader Terms 6.1 — "we will pause your paid reading until you settle
          // the outstanding amount and give us a working payment method". A
          // subscription is the largest single thing a reader can add to a tab
          // we have just been told we cannot collect from, so the pause covers
          // it: having a card on file is not the same fact as having one that
          // works, and until now only the first was asked. Cleared by
          // connectPaymentMethod, in the same UPDATE that records the new card.
          if (cardRow.rows[0].card_action_required_at) {
            return reply.status(402).send({ error: 'card_action_required' })
          }
        } else if (pricePence !== 0) {
          // Unreachable, and it stays that way: a comp that acquired a price
          // would be a charge with no card gate in front of it.
          logger.error({ readerId, writerId, offerId, pricePence }, 'Comp redemption carried a non-zero price')
          return reply.status(500).send({ error: 'internal_error' })
        }

        // The existing row, LOCKED (CA-A3, 2026-09-29). Any status — the
        // unique index on (reader, writer) means at most one. `FOR UPDATE`
        // is what makes the 409 below true under concurrency: a second
        // transaction blocks here until the first commits, then re-reads the
        // row AS COMMITTED and sees `active`. Without it two resubscribes
        // pressed together (the button disables only after the first press's
        // state update lands, so a double-click is a real path) both read
        // `cancelled`, the second queued on the row lock inside its UPDATE and
        // then overwrote the first — and charged a second period on top of it,
        // since `subscription_events` has no unique on (subscription, period).
        //
        // `paid_up` is the restore-only predicate, computed against the
        // database's own clock so that the row's `current_period_end` and the
        // `now()` it is compared with come from one place: a subscription the
        // reader CANCELLED (auto_renew off, access running to period end) whose
        // period has not ended yet.
        const existing = await client.query<{
          id: string
          status: string
          paid_up: boolean
          price_pence: number
          subscription_period: string
          current_period_start: Date
          current_period_end: Date
          is_comp: boolean
        }>(
          `SELECT id, status,
                  (status = 'cancelled' AND current_period_end > now()) AS paid_up,
                  price_pence, subscription_period, current_period_start,
                  current_period_end, is_comp
           FROM subscriptions
           WHERE reader_id = $1 AND writer_id = $2
           FOR UPDATE`,
          [readerId, writerId]
        )

        if (existing.rows.length > 0 && existing.rows[0].status === 'active') {
          // Before the redemption is spent — a 409 here used to burn the
          // offer's single redemption, which for a one-shot grant (every comp)
          // meant the reader could never accept it afterwards.
          return reply.status(409).send({ error: 'Already subscribed' })
        }

        // A RESUBSCRIBE INSIDE A PAID-UP PERIOD IS A RESTORE, NOT A SALE
        // (CA-A2, 2026-09-29). `cancelAtPeriodEnd` leaves the reader's access
        // running to `current_period_end` — the cancellation email and the
        // "Access until X" title on the resubscribe button both say so. Until
        // now that button took the reactivation arm below, which re-anchored
        // the period on today and charged a whole new one: cancel on the 5th,
        // change your mind on the 6th, pay twice for one month. What the
        // reader is asking for is the cancellation undone — so that is all
        // that happens: `auto_renew` back on (except for a comp, which never
        // renews), `cancelled_at` cleared, the period, price and offer exactly
        // as they were, and no charge. The attestation is re-signed with the
        // EXISTING dates so the relay's record agrees with the row.
        //
        // An offer code against a paid-up row is REFUSED rather than banked:
        // the row has no place to hold a price for the next period without
        // misstating what was paid for this one, and an offer applied to a
        // subscription that already ran would have spent its redemption on a
        // discount nobody received. Nothing is spent by the refusal, so a
        // grant (every comp) stays outstanding and can be accepted once the
        // period has actually ended. The request's `period` is likewise not
        // applied: the row's own period stands and is reported back.
        const paidUp = existing.rows.length > 0 && existing.rows[0].paid_up
        if (paidUp && offerId) {
          return reply.status(409).send({
            error: 'subscription_paid_up',
            message: 'Your subscription still runs to the end of its current period, so this offer cannot be applied to it yet.',
          })
        }

        // Writer 9.3 — we have stopped offering paid access to this writer's
        // work (L5.6; §0z item 10), and a subscription IS paid access: until
        // 2026-09-18 only the gate pass read the stamp, so a withdrawn writer
        // kept selling subscriptions whose earnings we could not pay out and
        // which then opened the very pieces the stamp refuses to sell. Same
        // code and status as the gate pass, and the message says nothing about
        // the writer's Stripe account, which is between us and them. After the
        // 409 (an existing subscriber loses nothing here) and before the terms
        // gate (accepting a text to buy what is not for sale is a pointless
        // errand). A comp is not paid access and is not refused.
        if (!isComp && writer.paid_access_withdrawn_at !== null) {
          return reply.status(403).send({
            error: 'not_for_sale',
            message: "This writer's paid access isn't available at the moment. Nothing has been charged.",
          })
        }

        // The Reader Terms are what the reading tab runs on, and a subscription
        // is the largest single thing a reader can put on it — so a reader who
        // registered a card before the text existed is asked here as well as at
        // the gate pass (§0z item 5; operator decision A3). NOT beside the card
        // gates above, and not beside Step 3b's twin in `performGatePass`
        // either, but here: after every path on which no sale happens (the
        // 409 above — asking a reader to accept a text in order to be told they
        // are already subscribed sends them on a pointless errand) and before
        // the first write (the redemption increment, the row, the charge). A
        // comp is not a sale and is not asked. Asked on the transaction's own
        // connection, like every read in here.
        if (!isComp && (await readerTermsOutstanding(readerId, client))) {
          return reply.status(403).send({
            error: READER_TERMS_REQUIRED,
            message: 'Before subscribing, please accept the all.haus Reader Terms.',
          })
        }

        const readerPubkey = req.session!.pubkey

        // --- The restore arm: no charge, no re-anchor, no redemption spent. ---
        if (paidUp) {
          const sub = existing.rows[0]
          // A comp never renews: `auto_renew` is what separates a comp from a
          // 100%-discount offer (see the offer block above), and restoring it
          // to TRUE would have the worker renew the gift for ever at 0p.
          const restored = await client.query<{ id: string }>(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = NOT is_comp, cancelled_at = NULL,
                 updated_at = now()
             WHERE id = $1 AND status = 'cancelled'
             RETURNING id`,
            [sub.id]
          )
          if (restored.rowCount === 0) {
            // Unreachable under the row lock above; kept so that a lock
            // dropped in a later edit refuses rather than restores blind.
            return reply.status(409).send({ error: 'Already subscribed' })
          }

          const restoreEvent = signSubscriptionEvent({
            subscriptionId: sub.id,
            readerPubkey,
            writerPubkey: writer.nostr_pubkey,
            status: 'active',
            pricePence: sub.price_pence,
            periodStart: sub.current_period_start,
            periodEnd: sub.current_period_end,
          })
          await client.query(
            `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
            [restoreEvent.id, sub.id]
          )
          await enqueueRelayPublish(client, {
            entityType: 'subscription',
            entityId: sub.id,
            signedEvent: restoreEvent,
          })

          logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription restored inside its paid-up period')

          // No `new_subscriber` notice and no welcome: the writer was never
          // told of the cancellation (access ran on), so there is nothing to
          // announce, and the reader was welcomed when they first subscribed.
          return {
            code: 200 as const,
            notify: false,
            pricePence: sub.price_pence,
            subscriptionId: sub.id,
            body: {
              subscriptionId: sub.id,
              status: 'active',
              restored: true,
              pricePence: sub.price_pence,
              isComp: sub.is_comp,
              period: sub.subscription_period,
              currentPeriodEnd: sub.current_period_end.toISOString(),
              writerName: writer.display_name ?? writer.username,
            },
          }
        }

        // Spend the redemption, GUARDED (CA-A3): the cap was read on an
        // unlocked row at the top of the route, so two readers redeeming the
        // last redemption together both passed it and both incremented — the
        // offer over-shot its cap by however many pressed at once. The
        // increment now carries the cap in its own WHERE, which Postgres
        // evaluates on the locked row after any concurrent increment commits;
        // a 0-row result is the same refusal the unlocked read gives, one step
        // later. `subscription_offers` has no CHECK tying the two columns, so
        // this predicate is the whole of the guarantee. It stays here, after
        // the 409 and the terms gate, for the reason the comment above the
        // 409 gives.
        if (offerId) {
          const spent = await client.query(
            `UPDATE subscription_offers
             SET redemption_count = redemption_count + 1
             WHERE id = $1
               AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`,
            [offerId]
          )
          if (spent.rowCount === 0) {
            return reply.status(410).send({ error: 'This offer has been fully redeemed' })
          }
        }

        if (existing.rows.length > 0) {
          const sub = existing.rows[0]
          // Re-activate an expired subscription, or a cancelled one whose
          // period has ended but which the hourly worker has not yet marked
          // expired. A re-activation starts a fresh run of periods, so it
          // re-anchors on today (§1.5) — the reader has nothing running that a
          // fresh period could overlap.
          const now = new Date()
          const anchorDay = anchorDayOf(now)
          const periodEnd = firstPeriodEnd(now, period)

          // `status <> 'active'` and RETURNING: with the row lock above this
          // cannot match 0 rows, and it is written so that it refuses rather
          // than double-charges if the lock is ever lost.
          const reactivated = await client.query<{ id: string }>(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = $9, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = $5,
                 offer_id = $6, offer_periods_remaining = $7,
                 period_anchor_day = $8, is_comp = $10, updated_at = now()
             WHERE id = $4 AND status <> 'active'
             RETURNING id`,
            [now, periodEnd, pricePence, sub.id, period, offerId, offerPeriodsRemaining, anchorDay, !isComp, isComp]
          )
          if (reactivated.rowCount === 0) {
            return reply.status(409).send({ error: 'Already subscribed' })
          }

          // F1: charge the reading tab (inside logSubscriptionCharge), not the
          // dead free_allowance column — so the charge is actually collected.
          //
          // A comp posts NOTHING. Zero is not a movement, and the ledger records
          // movements: a 0-pence subscription_charge would be a tab delta of 0
          // mirrored by a ledger entry of 0, plus a 0-pence subscription_earning
          // for the payout cycle to claim. The old comp route posted none of
          // these either, so this is the same fact under the new model.
          if (!isComp) {
            await logSubscriptionCharge(client, sub.id, readerId, writerId, pricePence, now, periodEnd)
          }

          logger.info({ readerId, writerId, subscriptionId: sub.id }, 'Subscription reactivated')

          // Sign the attestation and hand off to relay_outbox for durable
          // publish. Same transaction → enqueue is rolled back on error.
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

          return {
            code: 200 as const,
            notify: true,
            pricePence,
            subscriptionId: sub.id,
            body: {
              subscriptionId: sub.id,
              status: 'active',
              restored: false,
              pricePence,
              isComp,
              period,
              currentPeriodEnd: periodEnd.toISOString(),
              writerName: writer.display_name ?? writer.username,
            },
          }
        }

        // Create new subscription
        const now = new Date()
        const periodEnd = firstPeriodEnd(now, period)

        const subResult = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
             current_period_start, current_period_end, subscription_period,
             offer_id, offer_periods_remaining, period_anchor_day, auto_renew, is_comp)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [readerId, writerId, pricePence, now, periodEnd, period, offerId, offerPeriodsRemaining, anchorDayOf(now), !isComp, isComp]
        )

        const subscriptionId = subResult.rows[0].id

        // F1: charge the reading tab (inside logSubscriptionCharge), not the
        // dead free_allowance column — so the charge is actually collected.
        // A comp posts nothing — see the reactivate arm above.
        if (!isComp) {
          await logSubscriptionCharge(client, subscriptionId, readerId, writerId, pricePence, now, periodEnd)
        }

        logger.info({ readerId, writerId, subscriptionId, pricePence }, 'Subscription created')

        // Sign the attestation and hand off to relay_outbox for durable
        // publish. Same transaction → enqueue is rolled back on error.
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

        return {
          code: 201 as const,
          notify: true,
          pricePence,
          subscriptionId,
          body: {
            subscriptionId,
            status: 'active',
            restored: false,
            pricePence,
            isComp,
            period,
            currentPeriodEnd: periodEnd.toISOString(),
            writerName: writer.display_name ?? writer.username,
          },
        }
      })

      // A refusal answered inside the transaction (reads only; nothing to
      // roll back).
      if (reply.sent || !isOutcome(outcome)) return reply

      // EVERYTHING BELOW HAPPENS AFTER COMMIT (CA-B7, 2026-09-29). The
      // notification, both emails and the 20x all used to fire INSIDE the
      // callback — before `enqueueRelayPublish`, even — so an enqueue failure
      // rolled the subscription back after the writer had been notified, both
      // emails had gone and the reader had been told 201. The callback now
      // returns what happened; the side effects read that, once it is true.
      const { subscriptionId, pricePence, body: responseBody, code } = outcome
      if (outcome.notify) {
        pool.query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
           VALUES ($1, $2, 'new_subscriber')
           ON CONFLICT DO NOTHING`,
          [writerId, readerId]
        ).catch((err) => logger.warn({ err }, 'Failed to insert new_subscriber notification'))

        // Notify writer of new subscriber — non-blocking
        sendNewSubscriberEmail(writerId, readerId, pricePence).catch(err =>
          logger.warn({ err, subscriptionId }, 'New subscriber email failed')
        )

        // And the reader's half of that exchange, in the writer's own words
        // (§4.2). Both charging arms send it: a reader returning after a
        // lapse is being welcomed back, and is exactly as much owed the
        // writer's words as a first-time subscriber. Non-blocking: an email
        // provider having a bad minute must not fail a subscription that is
        // already charged, signed and committed. `trackSend` counts the
        // attempt either way.
        sendSubscriptionWelcomeEmail(readerId, writerId).catch(err =>
          logger.warn({ err, subscriptionId }, 'Subscription welcome email failed')
        )
      }

      return reply.status(code).send(responseBody)
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

      const cancelled = await withTransaction((client) =>
        cancelAtPeriodEnd(client, readerId, writerId))

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
        return reply.status(400).send(zodValidationError(parsed.error))
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
        return reply.status(400).send(zodValidationError(parsed.error))
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
