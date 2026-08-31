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
  type BlueskyThreadViewPost,
  type MastodonStatus,
  isThreadViewPost,
  extractBlueskyViewMedia,
  stripHtmlTags,
  extractMastodonStatusId,
} from "../../lib/external-items-shared.js";

interface ExternalThreadEntry {
  id: string;
  authorName: string;
  authorHandle: string;
  authorUri: string;
  contentHtml: string;
  contentText: string;
  publishedAt: string;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  parentId: string | null;
  protocol: string;
}

interface ThreadResponse {
  ancestors: ExternalThreadEntry[];
  descendants: ExternalThreadEntry[];
  // The re-rooted focal node rendered as a full card (author + content + its own
  // media + engagement counts), persisted context-only so it carries a real
  // all.haus id the client can like/repost/reply against. Populated ONLY when the
  // request carries `?focus=` (re-rooting onto a reply/ancestor) — for the base
  // item the client already renders the host richly. null when the focus node's
  // source fetch failed. See CARD-BEHAVIOUR-ADR addendum (rich re-rooted focal).
  focus?: ParentItem | null;
  // Server-signalled (CARD-BEHAVIOUR-ADR §VII.3): true when the source thread
  // could not be reached or completed (fetch failure / timeout). The client no
  // longer infers this from a rejected promise.
  partial: boolean;
}

const threadCache = new Map<
  string,
  { data: ThreadResponse; expiresAt: number }
>();
const THREAD_CACHE_TTL_MS = 60_000;

export function registerThreadRoutes(app: FastifyInstance) {
  // =========================================================================
  // GET /external-items/:id/thread — full reply thread from source platform
  // =========================================================================
  app.get<{ Params: { id: string }; Querystring: { focus?: string } }>(
    "/external-items/:id/thread",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { id } = req.params;
      // `focus` re-roots the thread on a source-platform node (a clicked
      // ancestor/descendant whose ExternalThreadEntry.id is a source URI/id, not
      // an all.haus id). The base item row scopes protocol + host, so there is
      // no SSRF surface (see deriveFocusItem). NOTE: for atproto, `focus` is an
      // at:// URI that is NOT verified to belong to the base item's
      // conversation — this is effectively an authed read-proxy for any public
      // Bluesky thread on the pinned AppView host. Acceptable (the data is
      // already public) but it is not "ownership scoping" (L6).
      const focus = req.query.focus?.trim() || null;

      const cacheKey = focus ? `${id}|${focus}` : id;
      const cached = threadCache.get(cacheKey);
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

      const item = focus ? deriveFocusItem(rows[0], focus) : rows[0];
      // When re-rooting, also hydrate the focal node itself as a full card (the
      // base-item case renders the host richly client-side, so it's skipped).
      const wantFocus = !!focus;
      let data: ThreadResponse = {
        ancestors: [],
        descendants: [],
        partial: false,
      };

      if (item.protocol === "atproto") {
        const thread = await fetchBlueskyThread(item, wantFocus);
        // null = source unreachable / timed out → partial; nostr_external + rss
        // intentionally return an empty (non-partial) thread.
        if (thread) data = thread;
        else data = { ancestors: [], descendants: [], partial: true };
      } else if (item.protocol === "activitypub") {
        const thread = await fetchMastodonThread(item, wantFocus);
        if (thread) data = thread;
        else data = { ancestors: [], descendants: [], partial: true };
      }

      setCapped(threadCache, cacheKey, {
        data,
        expiresAt: Date.now() + THREAD_CACHE_TTL_MS,
      });

      return reply.send(data);
    },
  );
}

function blueskyPostToEntry(tvp: BlueskyThreadViewPost): ExternalThreadEntry {
  const post = tvp.post;
  return {
    id: post.uri,
    authorName: post.author.displayName || post.author.handle,
    authorHandle: post.author.handle,
    authorUri: post.author.did,
    contentHtml: "",
    contentText: post.record.text ?? "",
    publishedAt: post.record.createdAt ?? new Date().toISOString(),
    likeCount: post.likeCount ?? 0,
    replyCount: post.replyCount ?? 0,
    repostCount: post.repostCount ?? 0,
    parentId: post.record.reply?.parent.uri ?? null,
    protocol: "atproto",
  };
}

// Hydrate a Bluesky thread-root post into a rich focal ParentItem and persist it
// context-only (so like/repost/reply have a real all.haus id to act on). Mirrors
// fetchBlueskyParent's upsert. Returns null on persist failure (caller degrades).
async function persistBlueskyFocus(
  post: BlueskyThreadViewPost["post"],
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const media = extractBlueskyViewMedia(post.embed);
    const authorName = post.author.displayName || post.author.handle;
    const authorUri = post.author.did;
    const parentReplyUri = post.record.reply?.parent.uri ?? null;
    const publishedAt = Math.floor(
      new Date(post.record.createdAt ?? Date.now()).getTime() / 1000,
    );
    const ins = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_text, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, 'atproto', 'tier3', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        post.uri,
        authorName,
        post.author.handle,
        post.author.avatar ?? null,
        authorUri,
        post.record.text ?? null,
        JSON.stringify(media),
        parentReplyUri,
        JSON.stringify({ uri: post.uri, cid: post.cid }),
        post.likeCount ?? 0,
        post.replyCount ?? 0,
        post.repostCount ?? 0,
        new Date(post.record.createdAt ?? Date.now()),
      ],
    );

    return {
      id: ins.rows[0].id,
      sourceProtocol: "atproto",
      sourceItemUri: post.uri,
      authorName,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri,
      contentText: post.record.text ?? null,
      contentHtml: null,
      title: null,
      summary: null,
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      media,
      publishedAt,
      sourceReplyUri: parentReplyUri,
    };
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), uri: post.uri },
      "Bluesky focus persist failed",
    );
    return null;
  }
}

async function fetchBlueskyThread(
  item: ExternalItemRow,
  wantFocus = false,
): Promise<ThreadResponse | null> {
  try {
    const atUri =
      (item.interaction_data as { uri?: string }).uri ?? item.source_item_uri;

    const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread`);
    url.searchParams.append("uri", atUri);
    url.searchParams.append("depth", "50");
    url.searchParams.append("parentHeight", "100");

    const res = await safeFetch(url.toString(), {
      headers: { Accept: "application/json" },
      timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
    });

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as { thread: BlueskyThreadViewPost };
    if (!isThreadViewPost(data.thread)) return null;

    // Walk ancestors
    const ancestors: ExternalThreadEntry[] = [];
    let current = data.thread.parent;
    while (current && isThreadViewPost(current)) {
      ancestors.unshift(blueskyPostToEntry(current));
      current = current.parent;
    }

    // Flatten descendants (BFS)
    const descendants: ExternalThreadEntry[] = [];
    const queue: BlueskyThreadViewPost[] = [];
    for (const r of data.thread.replies ?? []) {
      if (isThreadViewPost(r)) queue.push(r);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      descendants.push(blueskyPostToEntry(node));
      for (const r of node.replies ?? []) {
        if (isThreadViewPost(r)) queue.push(r);
      }
    }

    // Sort descendants chronologically
    descendants.sort(
      (a, b) =>
        new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
    );

    // The thread root IS the focused node; when re-rooting, hydrate it as a rich
    // focal card (media from its #view embed) and persist context-only so it gets
    // a real id for like/repost/reply. Best-effort: a persist failure leaves
    // focus null and the client falls back to the lightweight focal it already has.
    let focus: ParentItem | null = null;
    if (wantFocus) {
      focus = await persistBlueskyFocus(data.thread.post, item.source_id);
    }

    return { ancestors, descendants, focus, partial: false };
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        uri: item.source_item_uri,
      },
      "Bluesky thread fetch failed",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mastodon thread fetch
// ---------------------------------------------------------------------------

async function fetchMastodonThread(
  item: ExternalItemRow,
  wantFocus = false,
): Promise<ThreadResponse | null> {
  const statusId = extractMastodonStatusId(item.source_item_uri);
  if (!statusId) return null;

  try {
    const host = new URL(item.source_item_uri).hostname;
    const res = await safeFetch(
      `https://${host}/api/v1/statuses/${statusId}/context`,
      {
        headers: { Accept: "application/json" },
        timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
      },
    );

    if (!res.ok) return null;

    const data = JSON.parse(res.text) as {
      ancestors: MastodonStatus[];
      descendants: MastodonStatus[];
    };

    const mapStatus = (s: MastodonStatus): ExternalThreadEntry => ({
      id: s.id,
      authorName: s.account.display_name || s.account.acct,
      authorHandle: s.account.acct,
      authorUri: s.account.uri ?? s.account.url,
      contentHtml: sanitizeContent(s.content ?? ""),
      contentText: stripHtmlTags(s.content ?? ""),
      publishedAt: s.created_at,
      likeCount: s.favourites_count ?? 0,
      replyCount: s.replies_count ?? 0,
      repostCount: s.reblogs_count ?? 0,
      parentId: s.in_reply_to_id,
      protocol: "activitypub",
    });

    // The /context endpoint omits the focal status itself; when re-rooting,
    // fetch it directly and persist context-only so it renders as a rich focal
    // card with a real id (best-effort — null degrades to lightweight focal).
    let focus: ParentItem | null = null;
    if (wantFocus) {
      focus = await persistMastodonFocus(host, statusId, item.source_id);
    }

    return {
      ancestors: data.ancestors.map(mapStatus),
      descendants: data.descendants.map(mapStatus),
      focus,
      partial: false,
    };
  } catch (err) {
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        uri: item.source_item_uri,
      },
      "Mastodon thread fetch failed",
    );
    return null;
  }
}

// Fetch a single Mastodon status (the re-rooted focal — /context omits it) and
// persist it context-only so it renders as a rich focal card with a real id.
// Mirrors fetchMastodonParent's upsert. Returns null on fetch/persist failure.
async function persistMastodonFocus(
  host: string,
  statusId: string,
  sourceId: string,
): Promise<ParentItem | null> {
  try {
    const res = await safeFetch(
      `https://${host}/api/v1/statuses/${statusId}`,
      {
        headers: { Accept: "application/json" },
        timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
      },
    );
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
      media_attachments?: Array<{
        type: string;
        url: string;
        preview_url?: string;
        description?: string;
      }>;
    };

    const authorName = status.account.display_name || status.account.acct;
    const media = (status.media_attachments ?? []).map((m) => ({
      type:
        m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
      url: m.url,
      thumbnail: m.preview_url,
      alt: m.description,
    }));
    const contentHtml = sanitizeContent(status.content ?? "");
    const publishedAt = Math.floor(
      new Date(status.created_at).getTime() / 1000,
    );

    const ins = await pool.query(
      `INSERT INTO external_items (
        source_id, protocol, tier, source_item_uri,
        author_name, author_handle, author_avatar_url, author_uri,
        content_html, media, source_reply_uri, interaction_data,
        like_count, reply_count, repost_count,
        published_at, is_context_only
      ) VALUES ($1, 'activitypub', 'tier3', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, TRUE)
      ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
        like_count = EXCLUDED.like_count,
        reply_count = EXCLUDED.reply_count,
        repost_count = EXCLUDED.repost_count,
        interaction_data = EXCLUDED.interaction_data
      RETURNING id`,
      [
        sourceId,
        status.url || status.uri,
        authorName,
        status.account.acct,
        status.account.avatar ?? null,
        status.account.uri ?? status.account.url,
        contentHtml,
        JSON.stringify(media),
        null,
        JSON.stringify({ id: status.uri, webUrl: status.url }),
        status.favourites_count ?? 0,
        status.replies_count ?? 0,
        status.reblogs_count ?? 0,
        new Date(status.created_at),
      ],
    );

    return {
      id: ins.rows[0].id,
      sourceProtocol: "activitypub",
      sourceItemUri: status.url || status.uri,
      authorName,
      authorHandle: status.account.acct,
      authorAvatarUrl: status.account.avatar ?? null,
      authorUri: status.account.uri ?? status.account.url,
      contentText: stripHtmlTags(status.content ?? ""),
      contentHtml,
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
      { err: err instanceof Error ? err.message : String(err), statusId },
      "Mastodon focus persist failed",
    );
    return null;
  }
}

// Build a synthetic item row pointing at a different node in the same source
// conversation, so the thread fetch re-roots on a clicked ancestor/descendant.
// `focus` is the source-platform id carried on ExternalThreadEntry.id. The base
// row supplies the trusted protocol + host; focus only redirects the node.
function deriveFocusItem(base: ExternalItemRow, focus: string): ExternalItemRow {
  if (base.protocol === "atproto") {
    // Bluesky entry ids are self-contained at:// URIs; getPostThread takes one
    // directly, and fetchBlueskyThread reads interaction_data.uri first.
    return { ...base, source_item_uri: focus, interaction_data: { uri: focus } };
  }
  if (base.protocol === "activitypub") {
    // Mastodon entry ids are local status ids on the base instance. Rebuild a
    // URL on the base host so the host derivation + extractMastodonStatusId in
    // fetchMastodonThread resolve to /api/v1/statuses/<id>/context. The id only
    // ever reaches the source as a numeric path segment (no SSRF surface).
    let host = "";
    try {
      host = new URL(base.source_item_uri).hostname;
    } catch {
      host = "";
    }
    return { ...base, source_item_uri: `https://${host}/x/${focus}` };
  }
  return base;
}
