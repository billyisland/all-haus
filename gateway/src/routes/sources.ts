import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS, parseCursor } from "../lib/feed-sql.js";
import { POST_SELECT, POST_JOINS, feedItemToPost } from "../lib/post-mapper.js";
import { encodeTsIdCursor } from "../lib/cursor.js";
import { isPublicSourceProtocol } from "../lib/public-source-protocols.js";
import { parseLimit, isUuid } from "../lib/request-inputs.js";

// =============================================================================
// External source surface (CARD-BEHAVIOUR-ADR §VI.2)
//
// GET /sources/:id — canonical metadata for one external source plus a
// chronological page of its items, projected as the unified Post model
// (UNIVERSAL-POST-ADR §9) so the surface renders through the one PostCard path,
// exactly like GET /author/:id/posts. This is the destination for an external
// card's PROVENANCE-LINE click (BYLINE-AND-PROVENANCE-ADR D7 — the source name
// in `VIA RSS · The Guardian →`; the byline is the per-post author and routes
// to /author/:id when it routes at all): the all.haus source surface, not the
// origin platform.
//
// `source.followTarget` is the same shape /author/:id/profile emits for an
// external author, so the surface mounts the same feed-derived follow control
// (D6/D7 ⟂: "you follow the Guardian" has to be true ON THIS PAGE). Follow
// state is the feed-derived projection — an external_subscriptions row exists
// iff the source sits in ≥1 of the viewer's feeds (CLAUDE.md Invariants).
// =============================================================================

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;


export async function sourcesRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/sources/:id",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!isUuid(id)) {
        return reply.status(404).send({ error: "We couldn't find that source." });
      }

      const cursor = parseCursor(req.query.cursor);
      const limit = parseLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

      try {
        const { rows: sourceRows } = await pool.query(
          `SELECT id, protocol, source_uri, display_name, description
           FROM external_sources
           WHERE id = $1 AND is_active = TRUE`,
          [id],
        );

        // A source row is shared by every subscriber to it, and this route
        // takes its uuid from the caller — so without a protocol check any
        // member could read any other member's private email newsletter by
        // guessing a row id (MIRROR-AUDIT §3 *Security*, S16). One home for the
        // list, and the reason it is an allow-list rather than a refusal of
        // `email`, in lib/public-source-protocols.ts.
        //
        // 404 rather than 403: a non-public source must not be distinguishable
        // from one that does not exist, or the route stays an oracle for which
        // uuids name a private newsletter even after it stops serving one.
        if (
          sourceRows.length === 0 ||
          !isPublicSourceProtocol(sourceRows[0].protocol)
        ) {
          return reply.status(404).send({ error: "We couldn't find that source." });
        }

        const s = sourceRows[0];

        // Mirrors resolveExternalAuthorById's followTarget (author.ts): `id`
        // is the viewer's subscription-row id when subscribed (the unfollow
        // handle), else the sourceUri (only the subscribe path runs then);
        // `sourceId` lets the client match per-feed membership on
        // feed_sources.external_source_id.
        const viewerId = req.session!.sub;
        const { rows: subRows } = await pool.query<{ sub_id: string }>(
          `SELECT id AS sub_id FROM external_subscriptions
            WHERE source_id = $1 AND subscriber_id = $2
            LIMIT 1`,
          [id, viewerId],
        );
        const subId = subRows[0]?.sub_id ?? null;

        const source = {
          id: s.id,
          protocol: s.protocol,
          sourceUri: s.source_uri,
          displayName: s.display_name,
          description: s.description,
          followTarget: {
            type: "source" as const,
            id: subId ?? s.source_uri,
            isFollowing: subId !== null,
            protocol: s.protocol,
            sourceUri: s.source_uri,
            sourceId: s.id,
          },
        };

        const cursorClause = cursor
          ? `AND (fi.published_at, fi.id) < (to_timestamp($3), $4::uuid)`
          : "";
        const params: any[] = cursor
          ? [id, limit, cursor.ts, cursor.id]
          : [id, limit];

        const result = await pool.query<any>(
          `
          SELECT ${FEED_SELECT}${POST_SELECT},
            -- Fractional epoch for the cursor (M13) — published_at_epoch is
            -- ::bigint (whole seconds, for display), but the ORDER BY and the
            -- to_timestamp() filter are full-precision, so a whole-second cursor
            -- skips every remaining row inside that second.
            EXTRACT(EPOCH FROM fi.published_at) AS published_at_secs
          FROM feed_items fi
          -- Everything this source SERVED, including items another source
          -- wrote first (CA-C4) — never fi.source_id, which names only the
          -- first writer.
          JOIN external_item_sources eis
            ON eis.external_item_id = fi.external_item_id AND eis.source_id = $1
          ${FEED_JOINS}
          ${POST_JOINS}
          WHERE fi.deleted_at IS NULL
            AND fi.item_type = 'external'
            AND (ei.is_context_only IS NOT TRUE)
            ${cursorClause}
          ORDER BY fi.published_at DESC, fi.id DESC
          LIMIT $2
          `,
          params,
        );

        const items = result.rows.map(feedItemToPost);
        // Only hand out a cursor when the page was full — a short page is the
        // last page (mirrors GET /author/:id/posts).
        const lastRow =
          result.rows.length === limit
            ? result.rows[result.rows.length - 1]
            : undefined;
        const nextCursor = lastRow
          ? encodeTsIdCursor(lastRow.published_at_secs, lastRow.fi_id)
          : undefined;

        return reply.send({ source, items, nextCursor });
      } catch (err) {
        logger.error({ err, sourceId: id }, "Source surface fetch failed");
        return reply.status(500).send({ error: "Couldn't load that source. Please try again." });
      }
    },
  );
}
