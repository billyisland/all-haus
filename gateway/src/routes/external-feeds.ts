import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAdmin } from "../middleware/admin.js";

// =============================================================================
// External feeds — admin diagnostics only.
//
// External subscriptions are now FEED-DERIVED: a row in external_subscriptions
// exists iff the source sits in ≥1 of the owner's feeds, maintained by
// addSource/removeSource in feeds.ts. The standalone subscription CRUD
// (subscribe / unsubscribe / mute / refresh / list) was retired with the
// Subscriptions page — see UNIVERSAL-FEED-ADR. Only the admin instance-health
// diagnostic remains here.
// =============================================================================
export async function externalFeedsRoutes(app: FastifyInstance) {
  // GET /admin/activitypub/instance-health — per-instance ingest stats
  //
  // Exposes the counters maintained by feed_ingest_activitypub so admins can
  // spot unreliable Mastodon instances and inform the ADR's §XII.5 decision
  // on whether to accelerate inbox delivery.
  app.get(
    "/admin/activitypub/instance-health",
    {
      preHandler: requireAdmin,
    },
    async (_req, reply) => {
      const { rows } = await pool.query<{
        host: string;
        success_count: string;
        failure_count: string;
        last_success_at: Date | null;
        last_failure_at: Date | null;
        last_error: string | null;
        subscribed_sources: string;
      }>(`
      SELECT
        h.host,
        h.success_count,
        h.failure_count,
        h.last_success_at,
        h.last_failure_at,
        h.last_error,
        (
          SELECT COUNT(*)::text FROM external_sources s
          WHERE s.protocol = 'activitypub'
            AND s.is_active = TRUE
            AND split_part(
              replace(replace(s.source_uri, 'https://', ''), 'http://', ''),
              '/', 1
            ) = h.host
        ) AS subscribed_sources
      FROM activitypub_instance_health h
      ORDER BY (h.success_count + h.failure_count) DESC
      LIMIT 200
    `);
      return reply.send({
        instances: rows.map((r) => {
          const s = parseInt(r.success_count, 10);
          const f = parseInt(r.failure_count, 10);
          const total = s + f;
          return {
            host: r.host,
            successCount: s,
            failureCount: f,
            successRate: total === 0 ? null : s / total,
            lastSuccessAt: r.last_success_at,
            lastFailureAt: r.last_failure_at,
            lastError: r.last_error,
            subscribedSources: parseInt(r.subscribed_sources, 10),
          };
        }),
      });
    },
  );
}
