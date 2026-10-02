import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { signSubscriptionEvent } from "../../lib/nostr-publisher.js";
import { enqueueRelayPublish } from "@platform-pub/shared/lib/relay-outbox.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  anchorDayOf,
  firstPeriodEnd,
} from "@platform-pub/shared/lib/subscription-period.js";
import { logSubscriptionCharge } from "./shared.js";
import { requirePublicationsEnabled } from "../../middleware/publication-auth.js";
import {
  readerTermsOutstanding,
  READER_TERMS_REQUIRED,
} from "../../lib/terms-gate.js";

// =============================================================================
// Publication subscriptions
//
// POST   /subscriptions/publication/:id — Subscribe to a publication
// DELETE /subscriptions/publication/:id — Cancel publication subscription
// =============================================================================

export async function subscriptionPublicationRoutes(app: FastifyInstance) {
  // Publications suspended 2026-08-31 — subscribe cannot use the plugin-level
  // hook (its siblings are the WRITER subscription routes, which are not
  // suspended), so it carries the gate per route; cancel below is deliberately
  // ungated. See env.ts.
  app.post<{ Params: { id: string }; Body: { period?: string } }>(
    "/subscriptions/publication/:id",
    { preHandler: [requirePublicationsEnabled(), requireAuth] },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const { id: publicationId } = req.params;
      const body = req.body as { period?: string };
      const period = body?.period === "annual" ? "annual" : "monthly";

      return withTransaction(async (client) => {
        // Collection gate (2026-07-06 audit P0): same card-on-file precondition
        // as the writer subscribe route — a subscription charge is settleable
        // tab debt only, and settlement skips card-less accounts, so the charge
        // would be uncollectible. 402 mirrors the gate-pass shape.
        const cardRow = await client.query<{
          stripe_customer_id: string | null;
          card_action_required_at: Date | null;
        }>(
          `SELECT stripe_customer_id, card_action_required_at FROM accounts WHERE id = $1`,
          [readerId],
        );
        if (!cardRow.rows[0]?.stripe_customer_id) {
          return reply.status(402).send({ error: "card_required" });
        }
        // And the same pause as the writer route (Reader Terms 6.1): a card on
        // file is not a card that works. Kept in step deliberately — these two
        // routes have carried the same collection gate since it was written,
        // and a paused reader who could still subscribe via a publication would
        // be paused nowhere.
        if (cardRow.rows[0].card_action_required_at) {
          return reply.status(402).send({ error: "card_action_required" });
        }

        const { rows: pubs } = await client.query<{
          subscription_price_pence: number;
          annual_discount_pct: number;
          name: string;
          nostr_pubkey: string;
        }>(
          `SELECT subscription_price_pence, annual_discount_pct, name, nostr_pubkey
           FROM publications WHERE id = $1 AND status = 'active'`,
          [publicationId],
        );
        if (pubs.length === 0) {
          return reply.status(404).send({ error: "Publication not found" });
        }

        const pub = pubs[0];
        const pricePence =
          period === "annual"
            ? Math.round(
                pub.subscription_price_pence *
                  12 *
                  (1 - pub.annual_discount_pct / 100),
              )
            : pub.subscription_price_pence;

        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM subscriptions
           WHERE reader_id = $1 AND publication_id = $2`,
          [readerId, publicationId],
        );

        // Hoisted out of the re-activate branch so the terms gate can sit
        // after it: a reader who is already subscribed is refused here, and is
        // never sent to accept a text for a sale that will not happen.
        if (existing.rows.length > 0 && existing.rows[0].status === "active") {
          return reply.status(409).send({ error: "Already subscribed" });
        }

        // Same gate as the writer route, in the same place: after every path
        // on which no sale happens and before the first write. The Reader
        // Terms are what the tab runs on, and a pre-text card-holder has never
        // been shown them (§0z item 5; A3).
        if (await readerTermsOutstanding(readerId, client)) {
          return reply.status(403).send({
            error: READER_TERMS_REQUIRED,
            message: "Before subscribing, please accept the all.haus Reader Terms.",
          });
        }

        const now = new Date();
        // Calendar periods anchored on today, for both the re-activate and the
        // create branch below (a re-activation starts a fresh run) — §1.5.
        const anchorDay = anchorDayOf(now);
        const periodEnd = firstPeriodEnd(now, period);
        const readerPubkey = req.session!.pubkey;

        if (existing.rows.length > 0) {
          const sub = existing.rows[0];

          await client.query(
            `UPDATE subscriptions
             SET status = 'active', auto_renew = TRUE, cancelled_at = NULL,
                 current_period_start = $1, current_period_end = $2,
                 price_pence = $3, subscription_period = $5,
                 period_anchor_day = $6, updated_at = now()
             WHERE id = $4`,
            [now, periodEnd, pricePence, sub.id, period, anchorDay],
          );

          // F1: charge the reading tab (inside logSubscriptionCharge), not the
          // dead free_allowance column — so the charge is actually collected.
          await logSubscriptionCharge(
            client,
            sub.id,
            readerId,
            null,
            pricePence,
            now,
            periodEnd,
            publicationId,
          );

          const reactivateEvent = signSubscriptionEvent({
            subscriptionId: sub.id,
            readerPubkey,
            writerPubkey: pub.nostr_pubkey,
            status: "active",
            pricePence,
            periodStart: now,
            periodEnd,
          });
          await client.query(
            `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
            [reactivateEvent.id, sub.id],
          );
          await enqueueRelayPublish(client, {
            entityType: "subscription",
            entityId: sub.id,
            signedEvent: reactivateEvent,
          });

          // BINDS THE PUBLICATION (migration 198). Without it, one reader
          // subscribing to two of a manager's publications was ONE
          // notification — so the second publication's revenue arrived
          // unannounced.
          pool
            .query(
              `INSERT INTO notifications (recipient_id, actor_id, type, publication_id)
               SELECT pm.account_id, $1, 'pub_new_subscriber', $2
               FROM publication_members pm
               WHERE pm.publication_id = $2 AND pm.can_manage_finances = TRUE
                 AND pm.removed_at IS NULL
               ON CONFLICT DO NOTHING`,
              [readerId, publicationId],
            )
            .catch((err) =>
              logger.warn({ err }, "Failed to notify pub_new_subscriber"),
            );

          return reply
            .status(200)
            .send({ subscriptionId: sub.id, status: "active", pricePence });
        }

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO subscriptions (reader_id, publication_id, price_pence, status,
             current_period_start, current_period_end, subscription_period,
             period_anchor_day)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
           RETURNING id`,
          [
            readerId,
            publicationId,
            pricePence,
            now,
            periodEnd,
            period,
            anchorDay,
          ],
        );
        const subscriptionId = rows[0].id;

        // F1: charge the reading tab (inside logSubscriptionCharge), not the
        // dead free_allowance column — so the charge is actually collected.
        await logSubscriptionCharge(
          client,
          subscriptionId,
          readerId,
          null,
          pricePence,
          now,
          periodEnd,
          publicationId,
        );

        const createEvent = signSubscriptionEvent({
          subscriptionId,
          readerPubkey,
          writerPubkey: pub.nostr_pubkey,
          status: "active",
          pricePence,
          periodStart: now,
          periodEnd,
        });
        await client.query(
          `UPDATE subscriptions SET nostr_event_id = $1 WHERE id = $2`,
          [createEvent.id, subscriptionId],
        );
        await enqueueRelayPublish(client, {
          entityType: "subscription",
          entityId: subscriptionId,
          signedEvent: createEvent,
        });

        pool
          .query(
            `INSERT INTO notifications (recipient_id, actor_id, type, publication_id)
             SELECT pm.account_id, $1, 'pub_new_subscriber', $2
             FROM publication_members pm
             WHERE pm.publication_id = $2 AND pm.can_manage_finances = TRUE
               AND pm.removed_at IS NULL
             ON CONFLICT DO NOTHING`,
            [readerId, publicationId],
          )
          .catch((err) =>
            logger.warn({ err }, "Failed to notify pub_new_subscriber"),
          );

        logger.info(
          { readerId, publicationId, subscriptionId },
          "Publication subscription created",
        );
        return reply.status(201).send({
          subscriptionId,
          status: "active",
          pricePence,
          publicationName: pub.name,
          currentPeriodEnd: periodEnd.toISOString(),
        });
      });
    },
  );

  // Cancel is DELIBERATELY NOT behind requirePublicationsEnabled(), unlike its
  // subscribe sibling above: an active auto-renew subscription is a standing
  // recurring charge, and the reader's power to withdraw from it must survive
  // the surface going dark. Gated, a cancel attempted during the suspension
  // 404s and is LOST — there is no other path (the writer cancel route keys on
  // writer_id, NULL here) — so re-enabling the flag would renew and charge a
  // reader who demonstrably tried to stop it. Cancelling touches no suspended
  // surface: it only ends a commitment. Same money-over-darkness reasoning as
  // the deliberately ungated publication payout cycle (env.ts).
  app.delete<{ Params: { id: string } }>(
    "/subscriptions/publication/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const readerId = req.session!.sub;
      const { id: publicationId } = req.params;

      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'cancelled', auto_renew = FALSE, cancelled_at = now(), updated_at = now()
         WHERE reader_id = $1 AND publication_id = $2 AND status = 'active'
         RETURNING id`,
        [readerId, publicationId],
      );

      if (result.rowCount === 0) {
        return reply
          .status(404)
          .send({ error: "No active subscription found" });
      }

      return reply.send({ ok: true });
    },
  );
}
