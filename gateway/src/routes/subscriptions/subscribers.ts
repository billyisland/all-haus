import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  anchorDayOf,
  firstPeriodEnd,
} from "@platform-pub/shared/lib/subscription-period.js";

// =============================================================================
// Writer-side subscriber management
//
// GET    /subscribers                      — List my subscribers
// POST   /subscriptions/:readerId/comp     — Grant a comp (free) subscription
// DELETE /subscriptions/:readerId/comp     — Revoke a comp subscription
// =============================================================================

export async function subscriptionSubscribersRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /subscribers — list my subscribers (writer view)
  //
  // Shows active and recently-cancelled subscribers with engagement data.
  // ---------------------------------------------------------------------------

  app.get("/subscribers", { preHandler: requireAuth }, async (req, reply) => {
    const writerId = req.session!.sub;

    const { rows } = await pool.query<{
      subscription_id: string;
      reader_id: string;
      reader_username: string;
      reader_display_name: string | null;
      reader_avatar: string | null;
      price_pence: number;
      status: string;
      is_comp: boolean;
      auto_renew: boolean;
      subscription_period: string;
      started_at: Date;
      current_period_end: Date;
      cancelled_at: Date | null;
      articles_read: string;
      total_article_value_pence: string;
    }>(
      `SELECT s.id AS subscription_id, s.reader_id,
                r.username AS reader_username,
                r.display_name AS reader_display_name,
                r.avatar_blossom_url AS reader_avatar,
                s.price_pence, s.status, s.is_comp, s.auto_renew,
                COALESCE(s.subscription_period, 'monthly') AS subscription_period,
                s.started_at, s.current_period_end, s.cancelled_at,
                COUNT(se.id) FILTER (WHERE se.event_type = 'subscription_read') AS articles_read,
                COALESCE(SUM(
                  CASE WHEN se.event_type = 'subscription_read' AND se.article_id IS NOT NULL
                  THEN (SELECT price_pence FROM articles WHERE id = se.article_id)
                  ELSE 0 END
                ), 0) AS total_article_value_pence
         FROM subscriptions s
         JOIN accounts r ON r.id = s.reader_id
         LEFT JOIN subscription_events se ON se.subscription_id = s.id
         WHERE s.writer_id = $1 AND s.status IN ('active', 'cancelled')
         GROUP BY s.id, s.reader_id, r.username, r.display_name,
                  r.avatar_blossom_url, s.price_pence, s.status, s.is_comp,
                  s.auto_renew, s.subscription_period,
                  s.started_at, s.current_period_end, s.cancelled_at
         ORDER BY s.started_at DESC`,
      [writerId],
    );

    const subscribers = rows.map((s) => {
      const articlesRead = parseInt(s.articles_read, 10);
      const totalArticleValue = parseInt(s.total_article_value_pence, 10);
      const gettingMoneysworth = totalArticleValue >= s.price_pence;

      return {
        subscriptionId: s.subscription_id,
        readerId: s.reader_id,
        readerUsername: s.reader_username,
        readerDisplayName: s.reader_display_name,
        readerAvatar: s.reader_avatar,
        pricePence: s.price_pence,
        status: s.status,
        isComp: s.is_comp,
        autoRenew: s.auto_renew,
        subscriptionPeriod: s.subscription_period,
        startedAt: s.started_at.toISOString(),
        currentPeriodEnd: s.current_period_end.toISOString(),
        cancelledAt: s.cancelled_at?.toISOString() ?? null,
        articlesRead,
        totalArticleValuePence: totalArticleValue,
        gettingMoneysworth,
      };
    });

    return reply.status(200).send({ subscribers });
  });

  // ---------------------------------------------------------------------------
  // POST /subscriptions/:readerId/comp — grant a comp (free) subscription
  //
  // Writer grants a complimentary subscription to a reader. No charge.
  // ---------------------------------------------------------------------------

  app.post<{ Params: { readerId: string } }>(
    "/subscriptions/:readerId/comp",
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub;
      const { readerId } = req.params;

      if (readerId === writerId) {
        return reply.status(400).send({ error: "Cannot comp yourself" });
      }

      // Verify reader exists
      const readerResult = await pool.query<{
        id: string;
        nostr_pubkey: string;
      }>(
        `SELECT id, nostr_pubkey FROM accounts WHERE id = $1 AND status = 'active'`,
        [readerId],
      );
      if (readerResult.rows.length === 0) {
        return reply.status(404).send({ error: "Reader not found" });
      }

      const now = new Date();
      // One calendar year, not 365 days — a comp granted the day before a leap
      // day otherwise ends a day short (§1.5). A comp never auto-renews, so the
      // anchor is stored for consistency rather than for a future advance.
      const anchorDay = anchorDayOf(now);
      const periodEnd = firstPeriodEnd(now, "annual");

      const { subscriptionId, status } = await withTransaction(
        async (client) => {
          const existing = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM subscriptions WHERE reader_id = $1 AND writer_id = $2`,
            [readerId, writerId],
          );

          if (existing.rows.length > 0) {
            const sub = existing.rows[0];
            if (sub.status === "active") {
              return { subscriptionId: sub.id, status: "conflict" as const };
            }
            await client.query(
              `UPDATE subscriptions
             SET status = 'active', auto_renew = FALSE, is_comp = TRUE, price_pence = 0,
                 cancelled_at = NULL, current_period_start = $1, current_period_end = $2,
                 period_anchor_day = $4, updated_at = now()
             WHERE id = $3`,
              [now, periodEnd, sub.id, anchorDay],
            );
            logger.info(
              { writerId, readerId, subscriptionId: sub.id },
              "Comp subscription granted (reactivated)",
            );
            return { subscriptionId: sub.id, status: "reactivated" as const };
          }

          const result = await client.query<{ id: string }>(
            `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status, is_comp, auto_renew,
             current_period_start, current_period_end, period_anchor_day)
           VALUES ($1, $2, 0, 'active', TRUE, FALSE, $3, $4, $5)
           ON CONFLICT (reader_id, writer_id) WHERE writer_id IS NOT NULL DO UPDATE
             SET status = 'active', auto_renew = FALSE, is_comp = TRUE, price_pence = 0,
                 cancelled_at = NULL, current_period_start = EXCLUDED.current_period_start,
                 current_period_end = EXCLUDED.current_period_end,
                 period_anchor_day = EXCLUDED.period_anchor_day, updated_at = now()
           RETURNING id`,
            [readerId, writerId, now, periodEnd, anchorDay],
          );

          const subId = result.rows[0].id;
          logger.info(
            { writerId, readerId, subscriptionId: subId },
            "Comp subscription granted",
          );
          return { subscriptionId: subId, status: "created" as const };
        },
      );

      if (status === "conflict") {
        return reply
          .status(409)
          .send({ error: "Reader already has an active subscription" });
      }

      // Notification
      pool
        .query(
          `INSERT INTO notifications (recipient_id, actor_id, type)
         VALUES ($1, $2, 'comp_subscription')
         ON CONFLICT DO NOTHING`,
          [readerId, writerId],
        )
        .catch((err) =>
          logger.warn(
            { err },
            "Failed to insert comp_subscription notification",
          ),
        );

      const httpStatus = status === "reactivated" ? 200 : 201;
      return reply
        .status(httpStatus)
        .send({ subscriptionId, status: "active", isComp: true });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /subscriptions/:readerId/comp — revoke a comp subscription (writer)
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { readerId: string } }>(
    "/subscriptions/:readerId/comp",
    { preHandler: requireAuth },
    async (req, reply) => {
      const writerId = req.session!.sub;
      const { readerId } = req.params;

      const result = await pool.query(
        `UPDATE subscriptions
         SET status = 'expired', updated_at = now()
         WHERE reader_id = $1 AND writer_id = $2 AND is_comp = TRUE AND status = 'active'
         RETURNING id`,
        [readerId, writerId],
      );

      if ((result.rowCount ?? 0) === 0) {
        return reply
          .status(404)
          .send({ error: "No active comp subscription found" });
      }

      logger.info({ writerId, readerId }, "Comp subscription revoked");
      return reply.status(200).send({ ok: true });
    },
  );
}
