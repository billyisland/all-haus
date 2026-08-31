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
  type QuoteMedia,
  extractBlueskyViewMedia,
  extractMastodonStatusId,
  rowToParentItem,
} from "../../lib/external-items-shared.js";

interface QuoteResponse {
  // A quoted post is rendered as a nested mini-card; it carries the same shape
  // as a parent (author + content + its own media). null when the item quotes
  // nothing, or when the source fetch couldn't produce the quoted post.
  quote: ParentItem | null;
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when a quote was expected
  // (source_quote_uri is set) but the source fetch failed / timed out.
  partial: boolean;
}

const quoteCache = new Map<
  string,
  { data: QuoteResponse; expiresAt: number }
>();
const QUOTE_CACHE_TTL_MS = 120_000;

export function registerQuoteRoutes(app: FastifyInstance) {
  // =========================================================================
  // GET /external-items/:id/quote — quoted-post tile for quote posts.
  // Mirrors /parent: a quoted post is hydrated (from external_items if already
  // present, else fetched from the source platform) and rendered as a nested
  // mini-card in our idiom. Same rate-limit / cache / partial-flag contract.
  // =========================================================================
  app.get<{ Params: { id: string } }>(
    "/external-items/:id/quote",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;

      const cached = quoteCache.get(id);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.send(cached.data);
      }

      const { rows } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_quote_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }

      const item = rows[0];

      if (!item.source_quote_uri) {
        const data: QuoteResponse = { quote: null, partial: false };
        return reply.send(data);
      }

      // Already hydrated? (e.g. eager prefetch, or the quoted post is itself a
      // subscribed item).
      const { rows: quoteRows } = await pool.query(
        `SELECT id, protocol, source_item_uri, source_reply_uri,
                author_name, author_handle, author_avatar_url, author_uri,
                content_text, content_html, title, summary, media,
                like_count, reply_count, repost_count, interaction_data,
                EXTRACT(EPOCH FROM published_at)::bigint AS published_at_epoch
         FROM external_items
         WHERE source_item_uri = $1 AND protocol = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [item.source_quote_uri, item.protocol],
      );

      let quote: ParentItem | null = null;
      let partial = false;

      if (quoteRows.length > 0) {
        quote = rowToParentItem(quoteRows[0]);
      } else {
        const fetched = await fetchQuoteFromSource(item);
        if (fetched) {
          quote = fetched;
        } else {
          partial = true;
        }
      }

      // Make the quoted post resolvable as a re-root target (best-effort: a
      // failure here only means re-root falls back to a no-op, never a 500).
      if (quote) {
        await ensureQuoteFeedItem(quote.id).catch(() => {});
      }

      const data: QuoteResponse = { quote, partial };
      setCapped(quoteCache, id, {
        data,
        expiresAt: Date.now() + QUOTE_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

// Mastodon's OpenGraph link preview (a `card` on the status — never in the AP
// outbox) becomes the same {type:"link"} media entry we render for Bluesky's
// app.bsky.embed.external, so a previewed link looks identical across sources.
function mastodonCardToMedia(
  card:
    | {
        url?: string;
        title?: string;
        description?: string;
        image?: string | null;
        type?: string;
      }
    | null
    | undefined,
): QuoteMedia | null {
  if (!card?.url) return null;
  if (card.type && card.type !== "link") return null;
  return {
    type: "link",
    url: card.url,
    thumbnail: card.image ?? undefined,
    title: card.title || undefined,
    description: card.description || undefined,
  };
}

// Re-root target enablement: give a quoted post a context-only feed_items row so
// GET /thread/:postId can resolve it when the reader clicks the quote tile to
// re-root onto it. The thread projector resolves an external focal via
// `feed_items WHERE post_id = $1`; a quote inserted into external_items alone
// (the on-demand fetch + the prefetch worker both write external_items only)
// has no post_id until the daily feed_items_reconcile backfills it, so re-root
// would 404 until then. This mirrors reconcile case 3 for a single row, runs at
// the moment the tile is displayed (the only time re-root is reachable), and is
// idempotent. The feed query filters is_context_only, so it never surfaces in
// the timeline. The identity trigger mints post_id from (protocol,
// source_item_uri) — identical to the host's source_quote_uri derivation — so
// the minted post_id equals the host Post's `quotes`, which is the re-root id.
async function ensureQuoteFeedItem(externalItemId: string): Promise<void> {
  await pool.query(
    `INSERT INTO feed_items (
       item_type, external_item_id,
       author_name, author_avatar,
       title, content_preview,
       published_at,
       source_protocol, source_item_uri, source_id, media,
       is_reply
     )
     SELECT
       'external', ei.id,
       NULLIF(ei.author_name, ''),
       COALESCE(ei.author_avatar_url, xs.avatar_url),
       ei.title,
       LEFT(COALESCE(ei.content_text, ei.summary), 200),
       ei.published_at,
       ei.protocol::text, ei.source_item_uri, ei.source_id, ei.media,
       ei.source_reply_uri IS NOT NULL
     FROM external_items ei
     JOIN external_sources xs ON xs.id = ei.source_id
     WHERE ei.id = $1 AND ei.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM feed_items fi WHERE fi.external_item_id = ei.id)
     ON CONFLICT DO NOTHING`,
    [externalItemId],
  );
}

async function fetchQuoteFromSource(
  item: ExternalItemRow,
): Promise<ParentItem | null> {
  const quoteUri = item.source_quote_uri!;
  if (item.protocol === "atproto") {
    return fetchBlueskyQuote(quoteUri, item.source_id);
  }
  if (item.protocol === "activitypub") {
    return fetchMastodonQuote(quoteUri, item.source_id);
  }
  return null;
}

async function fetchBlueskyQuote(
  quoteUri: string,
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.append("uris", quoteUri);

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
        record: { text?: string; createdAt?: string };
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
    const media = extractBlueskyViewMedia(post.embed);

    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        media = EXCLUDED.media
      RETURNING id`,
      [
        sourceId,
        "atproto",
        quoteUri,
        post.author.displayName || post.author.handle,
        post.author.handle,
        post.author.avatar ?? null,
        post.author.did,
        post.record.text ?? null,
        JSON.stringify(media),
        JSON.stringify({ uri: post.uri, cid: post.cid }),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    return {
      id: insertResult.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: quoteUri,
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
      media,
      publishedAt,
      sourceReplyUri: null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Bluesky quote fetch failed",
    );
    return null;
  }
}

async function fetchMastodonQuote(
  quoteUri: string,
  sourceId: string,
): Promise<ParentItem | null> {
  const statusId = extractMastodonStatusId(quoteUri);
  if (!statusId) return null;

  try {
    const host = new URL(quoteUri).hostname;
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
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
      card?: {
        url?: string;
        title?: string;
        description?: string;
        image?: string | null;
        type?: string;
      } | null;
    };

    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const media: QuoteMedia[] = (status.media_attachments ?? []).map((m) => ({
      type: (m.type === "image"
        ? "image"
        : m.type === "video"
          ? "video"
          : "link") as QuoteMedia["type"],
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));
    const link = mastodonCardToMedia(status.card);
    if (link) media.push(link);

    const insertResult = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, $2, 'tier3', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        media = EXCLUDED.media
      RETURNING id`,
      [
        sourceId,
        "activitypub",
        status.uri || status.url || quoteUri,
        status.account.display_name || status.account.acct,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.uri ?? status.account.url,
        sanitizeContent(status.content),
        JSON.stringify(media),
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    return {
      id: insertResult.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.uri || status.url || quoteUri,
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
      publishedAt,
      sourceReplyUri: null,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), quoteUri },
      "Mastodon quote fetch failed",
    );
    return null;
  }
}
