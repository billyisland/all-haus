import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { sanitizeContent } from "@platform-pub/shared/lib/sanitize.js";
import { requireAuth } from "../../middleware/auth.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  APPVIEW,
  NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  setCapped,
  type ExternalItemRow,
  type ParentItem,
  extractMastodonStatusId,
  rowToParentItem,
} from "../../lib/external-items-shared.js";

interface ParentContextResponse {
  parent: ParentItem | null;
  grandparentTag: { authorName: string; authorHandle: string } | null;
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when a parent was
  // expected (the item is a reply) but the source fetch failed / timed out.
  partial: boolean;
}

const parentCache = new Map<
  string,
  { data: ParentContextResponse; expiresAt: number }
>();
const PARENT_CACHE_TTL_MS = 120_000;

// The grandparent author tag is optional sugar ("→ in reply to X") and is also
// populated independently by the external_parent_prefetch worker. It is awaited
// on the parent fetch's critical path, so it gets a much tighter budget: a slow
// grandparent must never extend or jeopardise the parent response, and /parent
// must not balloon toward two full primary timeouts.
const GRANDPARENT_FETCH_TIMEOUT_MS = 2_500;

export function registerParentRoutes(app: FastifyInstance) {
  // =========================================================================
  // GET /external-items/:id/parent — parent context tile for reply items
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/parent",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;

      const cached = parentCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];

      if (!item.source_reply_uri) {
        const data: ParentContextResponse = {
          parent: null,
          grandparentTag: null,
          partial: false,
        };
        return reply.send(data);
      }

      // Check if parent already exists in external_items
      const { rows: parentRows } = await pool.query(
        `SELECT id, protocol, source_item_uri, source_reply_uri,
                author_name, author_handle, author_avatar_url, author_uri,
                content_text, content_html, title, summary, media,
                like_count, reply_count, repost_count, interaction_data,
                EXTRACT(EPOCH FROM published_at)::bigint AS published_at_epoch
         FROM external_items
         WHERE source_item_uri = $1 AND protocol = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [item.source_reply_uri, item.protocol],
      );

      let parent: ParentItem | null = null;
      let grandparentTag: { authorName: string; authorHandle: string } | null =
        null;
      // A parent is expected (source_reply_uri is set); if the source fetch
      // can't produce it, the neighbourhood is partial.
      let partial = false;

      if (parentRows.length > 0) {
        const row = parentRows[0];
        parent = rowToParentItem(row);
        grandparentTag = extractGrandparentTag(row);
      } else {
        // Fetch from source platform
        const fetched = await fetchParentFromSource(item);
        if (fetched) {
          parent = fetched.parent;
          grandparentTag = fetched.grandparentTag;
        } else {
          partial = true;
        }
      }

      const data: ParentContextResponse = { parent, grandparentTag, partial };
      setCapped(parentCache, id, {
        data,
        expiresAt: Date.now() + PARENT_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

// ---------------------------------------------------------------------------
// Parent context fetch from source platform
// ---------------------------------------------------------------------------

async function fetchParentFromSource(childItem: ExternalItemRow): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  const parentUri = childItem.source_reply_uri!;

  if (childItem.protocol === "atproto") {
    return fetchBlueskyParent(parentUri, childItem.source_id);
  }

  if (childItem.protocol === "activitypub") {
    return fetchMastodonParent(parentUri, childItem.source_id);
  }

  return null;
}

async function fetchBlueskyParent(
  parentUri: string,
  sourceId: string,
): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", parentUri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        uri: string;
        cid: string;
        author: {
          did: string;
          handle: string;
          displayName?: string;
          avatar?: string;
        };
        record: {
          text?: string;
          createdAt?: string;
          reply?: { parent: { uri: string }; root: { uri: string } };
        };
        likeCount?: number;
        replyCount?: number;
        repostCount?: number;
        embed?: unknown;
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    const publishedAt = post.record.createdAt
      ? Math.floor(new Date(post.record.createdAt).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const parentReplyUri = post.record.reply?.parent.uri ?? null;

    let grandparentTag: {
      authorName: string;
      authorHandle: string;
    } | null = null;
    if (parentReplyUri) {
      const gpTag = await fetchBlueskyGrandparentTag(parentReplyUri);
      if (gpTag) grandparentTag = gpTag;
    }

    const interactionData: Record<string, unknown> = {
      uri: post.uri,
      cid: post.cid,
    };
    if (grandparentTag) interactionData.grandparent = grandparentTag;

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        "atproto",
        parentUri,
        post.author.displayName || post.author.handle,
        post.author.handle,
        post.author.avatar ?? null,
        post.author.did,
        post.record.text ?? null,
        JSON.stringify([]),
        parentReplyUri,
        JSON.stringify(interactionData),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    const parent: ParentItem = {
      id: insertResult.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: parentUri,
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri: post.author.did,
      contentText: post.record.text ?? null,
      contentHtml: null,
      title: null,
      summary: null,
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      media: [],
      publishedAt: publishedAt,
      sourceReplyUri: parentReplyUri,
    };

    return { parent, grandparentTag };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Bluesky parent fetch failed",
    );
    return null;
  }
}

async function fetchBlueskyGrandparentTag(
  uri: string,
): Promise<{ authorName: string; authorHandle: string } | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", uri);

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
      timeout: GRANDPARENT_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      posts: Array<{
        author: { handle: string; displayName?: string };
      }>;
    };

    const post = data.posts?.[0];
    if (!post) return null;

    return {
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
    };
  } catch {
    return null;
  }
}

async function fetchMastodonParent(
  parentUri: string,
  sourceId: string,
): Promise<{
  parent: ParentItem;
  grandparentTag: { authorName: string; authorHandle: string } | null;
} | null> {
  const statusId = extractMastodonStatusId(parentUri);
  if (!statusId) return null;

  try {
    const host = new URL(parentUri).hostname;
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      id: string;
      url: string;
      uri: string;
      content: string;
      created_at: string;
      account: {
        acct: string;
        display_name: string;
        avatar: string;
        url: string;
        uri?: string; // ActivityPub actor id — the canonical author_uri
      };
      favourites_count?: number;
      replies_count?: number;
      reblogs_count?: number;
      in_reply_to_id: string | null;
      in_reply_to_account_id: string | null;
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
    };

    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const media = (status.media_attachments ?? []).map((m) => ({
      type:
        m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));

    let grandparentTag: {
      authorName: string;
      authorHandle: string;
    } | null = null;
    if (status.in_reply_to_id) {
      const gpTag = await fetchMastodonGrandparentTag(
        host,
        status.in_reply_to_id,
      );
      if (gpTag) grandparentTag = gpTag;
    }

    const interactionData: Record<string, unknown> = {
      id: status.uri,
      webUrl: status.url,
    };
    if (grandparentTag) interactionData.grandparent = grandparentTag;

    // Store in DB as context-only
    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        "activitypub",
        status.uri || status.url || parentUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.uri ?? status.account.url,
        sanitizeContent(status.content),
        JSON.stringify(media),
        null,
        JSON.stringify(interactionData),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    const parent: ParentItem = {
      id: insertResult.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.uri || status.url || parentUri,
      authorName: status.account.display_name || status.account.acct,
      authorHandle: status.account.acct,
      authorAvatarUrl: status.account.avatar ?? null,
      authorUri: status.account.uri ?? status.account.url,
      contentText: null,
      contentHtml: sanitizeContent(status.content),
      title: null,
      summary: null,
      likeCount: status.favourites_count ?? 0,
      replyCount: status.replies_count ?? 0,
      repostCount: status.reblogs_count ?? 0,
      media,
      publishedAt: publishedAt,
      sourceReplyUri: null,
    };

    return { parent, grandparentTag };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), parentUri },
      "Mastodon parent fetch failed",
    );
    return null;
  }
}

async function fetchMastodonGrandparentTag(
  host: string,
  statusId: string,
): Promise<{ authorName: string; authorHandle: string } | null> {
  try {
    const res = await safeFetch(`https://${host}/api/v1/statuses/${statusId}`, {
      headers: { Accept: "application/json" },
      timeout: GRANDPARENT_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const status = JSON.parse(res.text) as {
      account: { acct: string; display_name: string };
    };

    return {
      authorName: status.account.display_name || status.account.acct,
      authorHandle: status.account.acct,
    };
  } catch {
    return null;
  }
}

function extractGrandparentTag(
  row: any,
): { authorName: string; authorHandle: string } | null {
  if (!row.source_reply_uri) return null;
  const gp = row.interaction_data?.grandparent;
  if (gp?.authorName && gp?.authorHandle) return gp;
  return null;
}
