import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import {
  type AuthorCardResponse,
  computeTier,
  resolveNativeAuthor,
  fetchBlueskyProfile,
  fetchAPProfile,
  buildExternalProfileUrl,
} from "../lib/author-resolve.js";

const CACHE_TTL_MS = 5 * 60_000;
const authorCardCache = new Map<
  string,
  { data: AuthorCardResponse; expiresAt: number }
>();

export async function authorCardRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { type: string; id: string };
  }>(
    "/author-card",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { type, id } = req.query;
      const viewerId = req.session!.sub;

      if (!type || !id) {
        return reply
          .status(400)
          .send({ error: "type and id are required query parameters" });
      }

      if (type !== "native" && type !== "external") {
        return reply
          .status(400)
          .send({ error: 'type must be "native" or "external"' });
      }

      const cacheKey = `${type}:${id}:${viewerId}`;
      const cached = authorCardCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      let data: AuthorCardResponse;

      if (type === "native") {
        data = await resolveNativeAuthor(id, viewerId);
      } else {
        data = await resolveExternalAuthor(id, viewerId);
      }

      authorCardCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

// Item-keyed external resolution (the legacy hover card). The Phase-4
// constructed profile (routes/author.ts) keys on external_authors.id instead;
// both reuse the live-origin fetchers in lib/author-resolve.ts.
async function resolveExternalAuthor(
  externalItemId: string,
  viewerId: string,
): Promise<AuthorCardResponse> {
  const { rows } = await pool.query<{
    id: string;
    source_id: string;
    protocol: string;
    author_name: string | null;
    author_handle: string | null;
    author_avatar_url: string | null;
    author_uri: string | null;
    source_item_uri: string;
  }>(
    `SELECT id, source_id, protocol, author_name, author_handle,
            author_avatar_url, author_uri, source_item_uri
     FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
    [externalItemId],
  );

  if (rows.length === 0) {
    return { tier: "D", partial: true };
  }

  const item = rows[0];
  const tier = computeTier(item.protocol, item.author_uri);

  const { rows: sourceRows } = await pool.query<{
    id: string;
    name: string | null;
    description: string | null;
    url: string | null;
    protocol: string;
    source_uri: string;
  }>(
    `SELECT id, name, description, url, protocol, source_uri FROM external_sources WHERE id = $1`,
    [item.source_id],
  );
  const source = sourceRows[0] ?? null;

  // Follow state must key on the AUTHOR'S identity, not the item's source.
  // Thread-context hydration files every participant under the FOCAL author's
  // source_id (see routes/external-items.ts), so source-based follow state marks
  // every participant in an expanded external conversation as followed. For the
  // hydrated protocols (atproto/activitypub) derive the author's own subscribe
  // URI (the DID / actor URI) and match a subscription on it; rss/email/nostr
  // keep source-based (their source IS the followable feed / is per-author).
  //
  // `id` is the unfollow handle — the viewer's subscription-row id, since DELETE
  // /feeds/:id keys on external_subscriptions.id. When unsubscribed there's no
  // row, so fall back to the subscribe URI — only the subscribe path runs then,
  // keyed off protocol + sourceUri.
  let authorUri: string | null = null;
  if (item.protocol === "atproto" && item.author_uri) {
    authorUri = item.author_uri.match(/did:(?:plc|web):[a-zA-Z0-9.:_-]+/)?.[0] ?? null;
  } else if (
    item.protocol === "activitypub" &&
    item.author_uri &&
    /^https:\/\//.test(item.author_uri)
  ) {
    authorUri = item.author_uri;
  }

  let followTarget: AuthorCardResponse["followTarget"];
  if (authorUri) {
    const { rows: subRows } = await pool.query<{
      source_id: string;
      sub_id: string | null;
    }>(
      `SELECT es.id AS source_id, sub.id AS sub_id
         FROM external_sources es
         LEFT JOIN external_subscriptions sub
           ON sub.source_id = es.id AND sub.subscriber_id = $1
        WHERE es.protocol = $2::external_protocol
          AND es.source_uri = $3
        LIMIT 1`,
      [viewerId, item.protocol, authorUri],
    );
    const sourceId = subRows[0]?.source_id ?? null;
    const subId = subRows[0]?.sub_id ?? null;
    followTarget = {
      type: "source",
      id: subId ?? authorUri,
      isFollowing: subId !== null,
      protocol: item.protocol,
      sourceUri: authorUri,
      sourceId,
    };
  } else if (source) {
    const { rows: subRows } = await pool.query<{ id: string }>(
      `SELECT id FROM external_subscriptions
        WHERE subscriber_id = $1 AND source_id = $2
        LIMIT 1`,
      [viewerId, item.source_id],
    );
    const subId = subRows[0]?.id ?? null;
    followTarget = {
      type: "source",
      id: subId ?? item.source_id,
      isFollowing: subId !== null,
      protocol: source.protocol,
      sourceUri: source.source_uri,
      sourceId: item.source_id,
    };
  }

  if (tier === "A" && item.protocol === "atproto" && item.author_uri) {
    const profile = await fetchBlueskyProfile(item.author_uri);
    if (profile) {
      return {
        tier: "A",
        displayName: profile.displayName ?? profile.handle,
        handle: profile.handle,
        avatarUrl: profile.avatar,
        bio: profile.description,
        followerCount: profile.followersCount,
        followingCount: profile.followsCount,
        postCount: profile.postsCount,
        sourceProtocol: "atproto",
        externalUrl: buildExternalProfileUrl("atproto", {
          handle: profile.handle,
          handleUri: item.author_uri,
        }),
        followTarget,
      };
    }
  }

  if (tier === "A" && item.protocol === "nostr_external") {
    return {
      tier: "A",
      displayName: item.author_name ?? undefined,
      handle: item.author_handle ?? undefined,
      avatarUrl: item.author_avatar_url ?? undefined,
      sourceProtocol: "nostr_external",
      followTarget,
    };
  }

  if (
    (tier === "A" || tier === "B") &&
    item.protocol === "activitypub" &&
    item.author_uri
  ) {
    const profile = await fetchAPProfile(item.author_uri, item.source_item_uri);
    if (profile) {
      return {
        tier,
        displayName: profile.displayName ?? undefined,
        handle: profile.handle ?? undefined,
        avatarUrl: profile.avatar ?? undefined,
        bio: profile.description ?? undefined,
        followerCount: profile.followersCount,
        followingCount: profile.followingCount,
        postCount: profile.postsCount,
        sourceProtocol: "activitypub",
        externalUrl: buildExternalProfileUrl("activitypub", {
          handleUri: item.author_uri,
        }),
        followTarget,
        partial: profile.partial,
      };
    }
    return {
      tier,
      displayName: item.author_name ?? undefined,
      handle: item.author_handle ?? undefined,
      avatarUrl: item.author_avatar_url ?? undefined,
      sourceProtocol: "activitypub",
      externalUrl: buildExternalProfileUrl("activitypub", {
        handleUri: item.author_uri,
      }),
      followTarget,
      partial: true,
    };
  }

  if (tier === "C") {
    return {
      tier: "C",
      sourceName: source?.name ?? item.author_name ?? undefined,
      sourceDescription: source?.description ?? undefined,
      sourceUrl: source?.url ?? undefined,
      sourceProtocol: item.protocol,
      followTarget,
    };
  }

  return {
    tier: "D",
    displayName: item.author_name ?? undefined,
    sourceName: source?.name ?? undefined,
    sourceProtocol: item.protocol,
    followTarget,
  };
}
