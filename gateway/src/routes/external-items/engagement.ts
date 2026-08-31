import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  APPVIEW,
  setCapped,
  type ExternalItemRow,
  extractMastodonStatusId,
} from "../../lib/external-items-shared.js";

interface EngagementResponse {
  likeCount: number;
  replyCount: number;
  repostCount: number;
  protocol: string;
  fetchedAt: string;
}

// In-memory TTL cache to prevent rapid re-fetches (30s per item)
const engagementCache = new Map<
  string,
  { data: EngagementResponse; expiresAt: number }
>();
const CACHE_TTL_MS = 30_000;

export function registerEngagementRoutes(app: FastifyInstance) {
  // =========================================================================
  // GET /external-items/:id/engagement — live engagement counts from source
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/engagement",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;

      const cached = engagementCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, protocol, source_item_uri, like_count, reply_count, repost_count
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];
      let likeCount = item.like_count;
      let replyCount = item.reply_count;
      let repostCount = item.repost_count;

      if (item.protocol === "atproto") {
        const live = await fetchBlueskyEngagement(item.source_item_uri);
        if (live) {
          likeCount = live.likeCount;
          replyCount = live.replyCount;
          repostCount = live.repostCount;
        }
      } else if (item.protocol === "activitypub") {
        const live = await fetchMastodonEngagement(item.source_item_uri);
        if (live) {
          likeCount = live.likeCount;
          replyCount = live.replyCount;
          repostCount = live.repostCount;
        }
      }
      // nostr_external + rss: return stored snapshot

      // Side-effect: update snapshot columns
      if (
        likeCount !== item.like_count ||
        replyCount !== item.reply_count ||
        repostCount !== item.repost_count
      ) {
        pool
          .query(
            `UPDATE external_items SET like_count = $1, reply_count = $2, repost_count = $3 WHERE id = $4`,
            [likeCount, replyCount, repostCount, id],
          )
          .catch((err) =>
            logger.warn({ err, id }, "Failed to update engagement snapshot"),
          );
      }

      const data: EngagementResponse = {
        likeCount,
        replyCount,
        repostCount,
        protocol: item.protocol,
        fetchedAt: new Date().toISOString(),
      };

      setCapped(engagementCache, id, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Bluesky engagement fetch
// ---------------------------------------------------------------------------

async function fetchBlueskyEngagement(uri: string): Promise<{
  likeCount: number;
  replyCount: number;
  repostCount: number;
} | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", uri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        uri: string;
        likeCount?: number;
        replyCount?: number;
        repostCount?: number;
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    return {
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri },
      "Bluesky engagement fetch failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mastodon engagement fetch
// ---------------------------------------------------------------------------

async function fetchMastodonEngagement(uri: string): Promise<{
  likeCount: number;
  replyCount: number;
  repostCount: number;
} | null> {
  const statusId = extractMastodonStatusId(uri);
  if (!statusId) return null;

  try {
    const host = new URL(uri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      favourites_count?: number;
      replies_count?: number;
      reblogs_count?: number;
    };

    return {
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri },
      "Mastodon engagement fetch failed",
    );
    return null;
  }
}
