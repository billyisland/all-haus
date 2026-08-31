import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { FEED_SELECT, FEED_JOINS } from "../../lib/feed-sql.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
} from "../../lib/post-mapper.js";
import { UUID_RE, feedRowToResponse, loadFeed } from "./shared.js";
import { encodeTsIdCursor } from "../../lib/cursor.js";

// Slice 20 cursor parser: `${fractional_epoch_seconds}:${uuid}`. Distinct from
// parseCursor / parseScoredCursor because saves have no score axis — order is
// purely save-time. The epoch component is the shared fractional-seconds
// pattern (M13/§0f-6): full precision on the wire, `Number` (never `parseInt`)
// to parse, compared via to_timestamp() against the full-precision
// fs.created_at. The former bespoke ms codec is retired — its
// `(EXTRACT(EPOCH …) * 1000)::bigint` encoder ROUNDED to nearest ms, so ~half
// of all rows minted a cursor later than their own created_at and the next
// page's `<` filter re-admitted them (page-edge duplicates).
function parseSaveCursor(
  raw: string | undefined,
): { ts: number; id: string } | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length !== 2) return undefined;
  if (parts[0].trim() === "") return undefined;
  let ts = Number(parts[0]);
  const id = parts[1];
  if (!Number.isFinite(ts) || !UUID_RE.test(id)) return undefined;
  // Back-compat: a pre-§0f-6 in-flight cursor is integer MILLISECONDS
  // (~1.7e12); real seconds are ~1.7e9. Anything past year 5138 in seconds is
  // a legacy ms cursor — rescale rather than strand the client mid-scroll.
  if (ts > 1e11) ts = ts / 1000;
  // Clamp AFTER the rescale (mirrors parseCursorEpoch, §0k.4b): a crafted
  // finite epoch (1e300) survives the one-shot rescale and would reach
  // to_timestamp(), which raises `timestamp out of range` → 500. Out of range
  // degrades to page 1 instead.
  if (ts < 0 || ts > 1e11) return undefined;
  return { ts, id };
}

export function registerFeedSavesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /feeds/:id/saves — saved-items list for a feed (slice 20)
  //
  // Renders the same item shape as /items, sourced from feed_saves rows
  // joined to feed_items. Order is save-time DESC. Cursor parses
  // `${fractional_epoch_seconds}:${feed_save_id}` for stable pagination across
  // the compound (created_at, id) index. Soft-deleted feed_items are filtered out so
  // saving an item that later got deleted cleans visually without a
  // separate sweep.
  //
  // GET /feeds/:id/saves/ids — light-weight Set<feedItemId> for the strip
  // to mark Save vs Saved on each card without per-card round trips.
  // ---------------------------------------------------------------------------
  app.get<{
    Params: { id: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/feeds/:id/saves", { preHandler: requireAuth }, async (req, reply) => {
    const ownerId = req.session!.sub;
    const { id } = req.params;
    if (!UUID_RE.test(id))
      return reply.status(400).send({ error: "Invalid feed id" });

    const feed = await loadFeed(id, ownerId);
    if (!feed) return reply.status(404).send({ error: "Feed not found" });

    const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 50);
    const cursor = parseSaveCursor(req.query.cursor);

    const cursorClause = cursor
      ? `AND (fs.created_at, fs.id) < (to_timestamp($3), $4::uuid)`
      : "";
    const params: any[] = cursor
      ? [id, limit, cursor.ts, cursor.id]
      : [id, limit];

    const result = await pool.query<any>(
      `
      SELECT ${FEED_SELECT}${POST_SELECT},
        EXTRACT(EPOCH FROM fs.created_at)::bigint AS saved_at_epoch,
        -- Fractional epoch for the cursor (M13/§0f-6) — full precision, no
        -- rounding/truncation: the cursor must compare exactly against the
        -- full-precision fs.created_at the ORDER BY sorts on, or page edges
        -- duplicate (rounded-up cursor) / skip (truncated cursor) rows.
        EXTRACT(EPOCH FROM fs.created_at) AS saved_at_secs,
        fs.id AS save_id
      FROM feed_saves fs
      JOIN feed_items fi ON fi.id = fs.feed_item_id
      ${FEED_JOINS}${POST_JOINS}
      WHERE fs.feed_id = $1
        AND fi.deleted_at IS NULL
        ${cursorClause}
      ORDER BY fs.created_at DESC, fs.id DESC
      LIMIT $2
      `,
      params,
    );

    const items = result.rows.map((row) => ({
      ...feedItemToPost(row),
      savedAt: Number(row.saved_at_epoch),
    }));
    const lastRow = result.rows[result.rows.length - 1];
    const nextCursor = lastRow
      ? encodeTsIdCursor(lastRow.saved_at_secs, lastRow.save_id)
      : undefined;

    return reply.send({
      feed: feedRowToResponse(feed),
      items,
      nextCursor,
    });
  });

  app.get<{ Params: { id: string } }>(
    "/feeds/:id/saves/ids",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      const { rows } = await pool.query<{ feed_item_id: string }>(
        `SELECT feed_item_id FROM feed_saves WHERE feed_id = $1`,
        [id],
      );
      return reply.send({ feedItemIds: rows.map((r) => r.feed_item_id) });
    },
  );

  // POST /feeds/:id/saves { feedItemId } — idempotent save.
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/feeds/:id/saves",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });

      const parsed = z
        .object({ feedItemId: z.string().uuid() })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: "Invalid body", details: parsed.error.flatten() });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      // Confirm the feed_item exists + isn't soft-deleted before saving — a
      // deleted item would survive ON CONFLICT silently and surface as a
      // ghost row in the saved view.
      const { rows: itemRows } = await pool.query<{ id: string }>(
        `SELECT id FROM feed_items WHERE id = $1 AND deleted_at IS NULL`,
        [parsed.data.feedItemId],
      );
      if (itemRows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      await pool.query(
        `INSERT INTO feed_saves (feed_id, feed_item_id) VALUES ($1, $2)
         ON CONFLICT (feed_id, feed_item_id) DO NOTHING`,
        [id, parsed.data.feedItemId],
      );
      return reply.status(201).send({ ok: true });
    },
  );

  // DELETE /feeds/:id/saves/:feedItemId — unsave.
  app.delete<{ Params: { id: string; feedItemId: string } }>(
    "/feeds/:id/saves/:feedItemId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ownerId = req.session!.sub;
      const { id, feedItemId } = req.params;
      if (!UUID_RE.test(id))
        return reply.status(400).send({ error: "Invalid feed id" });
      if (!UUID_RE.test(feedItemId)) {
        return reply.status(400).send({ error: "Invalid feed item id" });
      }

      const feed = await loadFeed(id, ownerId);
      if (!feed) return reply.status(404).send({ error: "Feed not found" });

      await pool.query(
        `DELETE FROM feed_saves WHERE feed_id = $1 AND feed_item_id = $2`,
        [id, feedItemId],
      );
      return reply.status(204).send();
    },
  );
}
