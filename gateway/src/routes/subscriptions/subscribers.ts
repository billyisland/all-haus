import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";

// =============================================================================
// Writer-side subscriber management
//
// GET    /subscribers                      — List my subscribers
//
// The writer's comp routes (POST/DELETE /subscriptions/:readerId/comp) were
// RETIRED on 2026-09-30 (CA-I5): no surface ever called them. A comp is still
// an OFFER the reader redeems (routes/subscriptions/writer.ts, migration 193),
// and a revival restores both routes from git beside
// `.claude/rules/money.md` › *A state written on somebody ELSE'S account*.
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
}
