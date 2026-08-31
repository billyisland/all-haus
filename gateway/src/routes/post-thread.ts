import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { optionalAuth } from "../middleware/auth.js";
import { checkArticleAccess } from "../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS } from "../lib/feed-sql.js";
import { collectDescendants } from "../lib/thread-walk.js";
import {
  hydrateExternalThreadContext,
  willHydrateThread,
  getInFlightHydration,
  awaitHydrationWithinBudget,
  THREAD_HYDRATE_SYNC_BUDGET_MS,
} from "../lib/external-hydration.js";
import {
  POST_SELECT,
  POST_JOINS,
  feedItemToPost,
  commentToPost,
  type Post,
  type CommentRow,
  type RepostEdgeDTO,
} from "../lib/post-mapper.js";

// =============================================================================
// GET /thread/:postId  — UNIVERSAL-POST-ADR Phase 1 (unified read endpoint)
//
// The Post-model thread. Coexists with the legacy native /conversation/:eventId
// (replies.ts) and external /external-items/:id/thread (external-items.ts) until
// the Phase 5 cutover. ADR §9 contract:
//
//   GET /thread/:postId?replyLimit=5&replyCursor=<c>
//     → { focalId, posts: Post[], repostEdges: RepostEdge[], replyCursor?, totalDescendants }
//       posts = ancestors-to-root + focal + first N descendants (§8 bounds).
//
// This is a PROJECTOR, not a new walk: it resolves the focal and sources its
// ancestors/descendants from the substrate that actually holds them, projecting
// every node into the one §2.2 Post shape (shared mapper, lib/post-mapper.ts):
//
//   • native article/note root  → focal is the THING (feed_items row); descendants
//     are the conversation's `comments` (target_event_id = root event id), nested
//     via parent_comment_id. Native replies live in `comments`, NOT feed_items —
//     they have no post_id, so each is given a DETERMINISTIC derived post_id
//     (feed_items_derive_post_id('nostr', comment.nostr_event_id), the §2.3
//     derivation) so it is addressable + re-rootable like any Post.
//   • native comment focal      → same conversation; ancestors walk parent_comment_id
//     up to the root article/note; descendants are the focal's subtree.
//   • external focal            → ancestors/descendants over external_items via
//     source_reply_uri. For atproto/activitypub the live source thread is first
//     HYDRATED into external_items + feed_items (hydrateExternalThreadContext,
//     best-effort + throttled) so the DB walk resolves the full reply graph the
//     projector would otherwise miss — we only ingest a source's own posts, not
//     the replies around them. (The legacy /external-items/:id/thread live walk is
//     still used by /feed + /source via useNeighbourhood.)
//
// Like the /feed slice, this endpoint reads the persisted Phase 0a/0b columns and
// the same feed_items_derive_post_id() the identity trigger uses, so inReplyTo /
// quotes / parent edges resolve consistently across /feed and /thread.
// =============================================================================

const DEFAULT_REPLY_LIMIT = 5; // §8: initial descendant page
const MAX_REPLY_LIMIT = 50;

const POST_ID_RE = /^[0-9a-f]{64}$/i; // sha256 hex (feed_items_derive_post_id output)

// ── reply cursor: "<published_at_epoch>:<node_uuid>" ─────────────────────────
// Keyset over the flattened descendant list (published_at, id). node_uuid is the
// comment uuid (native) or external_items uuid (external) — both stable per node.
interface ReplyCursor {
  ts: number;
  id: string;
}
function parseReplyCursor(raw: string | undefined): ReplyCursor | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length !== 2) return undefined;
  const ts = parseInt(parts[0], 10);
  const id = parts[1];
  if (Number.isFinite(ts) && UUID_RE.test(id)) return { ts, id };
  return undefined;
}

// CommentRow + commentToPost (the native comment → Post projection) now live in
// lib/post-mapper.ts, shared with the author replies log (author.ts).

// =============================================================================
// Focal resolution. :postId is a deterministic post_id (sha256 hex).
//   1. feed_items by post_id → article / note / external THING.
//   2. else comments by derived post_id → a native reply; resolve its root.
// =============================================================================
async function loadFeedItemPost(postId: string): Promise<Post | null> {
  // POST_SELECT/POST_JOINS carry no scoring machinery (score_live absent → score
  // undefined; boost_count absent → 0). That's exactly right for a thread node.
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.post_id = $1 AND fi.deleted_at IS NULL
      LIMIT 1`,
    [postId],
  );
  return rows[0] ? feedItemToPost(rows[0]) : null;
}

// Load the full native conversation for a root event id, each comment carrying its
// derived post_id + parent's derived post_id + vote tallies. Conversations are
// small and bounded; one flat fetch mirrors the legacy /conversation read.
async function loadConversationComments(
  rootEventId: string,
): Promise<CommentRow[]> {
  const { rows } = await pool.query<CommentRow>(
    `SELECT c.id,
            feed_items_derive_post_id('nostr', c.nostr_event_id) AS derived_post_id,
            c.nostr_event_id,
            c.parent_comment_id,
            feed_items_derive_post_id('nostr', p.nostr_event_id) AS parent_post_id,
            c.content,
            EXTRACT(EPOCH FROM c.published_at)::bigint AS published_at_epoch,
            c.deleted_at,
            c.author_id,
            acc.display_name AS acc_display_name,
            acc.username AS acc_username,
            acc.avatar_blossom_url AS acc_avatar,
            acc.nostr_pubkey AS nostr_pubkey,
            tl.pip_status AS pip_status,
            vt.upvote_count AS vt_up, vt.downvote_count AS vt_down
       FROM comments c
       JOIN accounts acc ON acc.id = c.author_id
       LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
       LEFT JOIN comments p ON p.id = c.parent_comment_id
       LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = c.nostr_event_id
      WHERE c.target_event_id = $1
      ORDER BY c.published_at ASC`,
    [rootEventId],
  );
  return rows;
}

async function loadMutes(viewerId: string | null): Promise<Set<string>> {
  if (!viewerId) return new Set();
  const { rows } = await pool.query<{ muted_id: string }>(
    "SELECT muted_id FROM mutes WHERE muter_id = $1",
    [viewerId],
  );
  return new Set(rows.map((r) => r.muted_id));
}

// =============================================================================
// Native thread assembly. Given the focal (root THING or a comment) and the full
// conversation, compute ancestors-to-root + first N descendants + cursor.
// =============================================================================
function assembleNativeThread(
  rootPost: Post,
  comments: CommentRow[],
  focalPostId: string,
  mutedIds: Set<string>,
  replyLimit: number,
  replyCursor: ReplyCursor | undefined,
): {
  posts: Post[];
  focalId: string;
  replyCursor?: string;
  totalDescendants: number;
} {
  const rootPostId = rootPost.id;
  // index comments by their derived post_id and build child adjacency
  const byPostId = new Map<string, CommentRow>();
  const childrenOf = new Map<string, CommentRow[]>(); // parent post_id → children
  for (const c of comments) {
    byPostId.set(c.derived_post_id, c);
  }
  for (const c of comments) {
    const parentId = c.parent_post_id ?? rootPostId;
    (childrenOf.get(parentId) ?? childrenOf.set(parentId, []).get(parentId)!).push(c);
  }

  const focalIsRoot = focalPostId === rootPostId;
  const focalComment = focalIsRoot ? null : byPostId.get(focalPostId);

  // ── ancestors: root-first chain from the focal up to (and including) the root.
  // Root THING is always the top ancestor (unless the focal IS the root).
  const ancestors: Post[] = [];
  if (!focalIsRoot && focalComment) {
    const chain: CommentRow[] = [];
    let cur: CommentRow | undefined = focalComment;
    const seen = new Set<string>();
    // walk parent_post_id up; stop at top-level (parent_post_id null → root)
    while (cur && cur.parent_post_id && !seen.has(cur.parent_post_id)) {
      seen.add(cur.parent_post_id);
      const parent = byPostId.get(cur.parent_post_id);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    chain.reverse(); // oldest-first
    ancestors.push(rootPost, ...chain.map((c) => commentToPost(c, rootPostId, mutedIds)));
  }

  // ── focal
  const focalPost: Post = focalIsRoot
    ? rootPost
    : commentToPost(focalComment!, rootPostId, mutedIds);

  // ── descendants: subtree under the focal, flattened chronologically.
  // (Flat chronological matches the playscript thread render — CLAUDE.md.)
  const subtree: CommentRow[] = collectDescendants(focalPostId, childrenOf);
  subtree.sort(
    (a, b) =>
      a.published_at_epoch - b.published_at_epoch || (a.id < b.id ? -1 : 1),
  );

  const totalDescendants = subtree.length;

  // keyset page over (published_at, id)
  const after = replyCursor;
  const pageSource = after
    ? subtree.filter(
        (c) =>
          c.published_at_epoch > after.ts ||
          (c.published_at_epoch === after.ts && c.id > after.id),
      )
    : subtree;
  const page = pageSource.slice(0, replyLimit);
  const last = page[page.length - 1];
  const nextReplyCursor =
    last && page.length < pageSource.length
      ? `${last.published_at_epoch}:${last.id}`
      : undefined;

  const descendants = page.map((c) => commentToPost(c, rootPostId, mutedIds));

  return {
    posts: [...ancestors, focalPost, ...descendants],
    focalId: focalPostId,
    replyCursor: nextReplyCursor,
    totalDescendants,
  };
}

// =============================================================================
// External thread assembly (ingested external_items only). Walk source_reply_uri
// for ancestors; direct + transitive replies for descendants. Pure DB — the live
// source-API walk stays in /external-items/:id/thread.
// =============================================================================
interface ExtNode {
  post: Post;
  itemId: string; // external_items uuid (cursor id)
  sourceItemUri: string;
  sourceReplyUri: string | null;
  sourceId: string; // external_sources id (for hydration dual-write)
  protocol: string;
  interactionData: Record<string, unknown> | null;
}

async function loadExternalNode(postId: string): Promise<ExtNode | null> {
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${EXT_NODE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.post_id = $1 AND fi.item_type = 'external' AND fi.deleted_at IS NULL
      LIMIT 1`,
    [postId],
  );
  return rows[0] ? rowToExtNode(rows[0]) : null;
}

// Shared projection of an external-thread feed_items row → ExtNode.
function rowToExtNode(r: any): ExtNode {
  return {
    post: feedItemToPost(r),
    itemId: r.ext_item_id,
    sourceItemUri: r.ext_source_item_uri,
    sourceReplyUri: r.ext_source_reply_uri,
    sourceId: r.ext_source_id,
    protocol: r.ext_protocol,
    interactionData: r.ext_interaction_data ?? null,
  };
}

const EXT_NODE_COLS = `,
            fi.external_item_id AS ext_item_id,
            ei.source_item_uri AS ext_source_item_uri,
            ei.source_reply_uri AS ext_source_reply_uri,
            ei.source_id AS ext_source_id,
            ei.protocol AS ext_protocol,
            ei.interaction_data AS ext_interaction_data`;

async function loadExternalByUri(uri: string): Promise<ExtNode | null> {
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${EXT_NODE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE ei.source_item_uri = $1 AND fi.item_type = 'external' AND fi.deleted_at IS NULL
      LIMIT 1`,
    [uri],
  );
  return rows[0] ? rowToExtNode(rows[0]) : null;
}

async function loadExternalReplies(parentUri: string): Promise<ExtNode[]> {
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${EXT_NODE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE ei.source_reply_uri = $1 AND fi.item_type = 'external' AND fi.deleted_at IS NULL`,
    [parentUri],
  );
  return rows.map(rowToExtNode);
}

async function assembleExternalThread(
  focal: ExtNode,
  replyLimit: number,
  replyCursor: ReplyCursor | undefined,
): Promise<{
  posts: Post[];
  focalId: string;
  replyCursor?: string;
  totalDescendants: number;
}> {
  // ancestors: walk source_reply_uri up through ingested items, root-first.
  const ancestors: Post[] = [];
  const seenUris = new Set<string>([focal.sourceItemUri]);
  let cur: ExtNode | null = focal;
  const chain: Post[] = [];
  while (cur?.sourceReplyUri && !seenUris.has(cur.sourceReplyUri)) {
    seenUris.add(cur.sourceReplyUri);
    const parent: ExtNode | null = await loadExternalByUri(cur.sourceReplyUri);
    if (!parent) break; // ancestor not ingested — stop (live walk lives elsewhere)
    chain.push(parent.post);
    cur = parent;
  }
  chain.reverse();
  ancestors.push(...chain);

  // descendants: BFS over ingested replies, flattened chronologically.
  const subtree: ExtNode[] = [];
  const queue: string[] = [focal.sourceItemUri];
  const visited = new Set<string>(seenUris);
  while (queue.length) {
    const parentUri = queue.shift()!;
    const replies = await loadExternalReplies(parentUri);
    for (const rep of replies) {
      if (visited.has(rep.sourceItemUri)) continue;
      visited.add(rep.sourceItemUri);
      subtree.push(rep);
      queue.push(rep.sourceItemUri);
    }
  }
  subtree.sort(
    (a, b) =>
      a.post.publishedAt - b.post.publishedAt ||
      (a.itemId < b.itemId ? -1 : 1),
  );

  const totalDescendants = subtree.length;
  const after = replyCursor;
  const pageSource = after
    ? subtree.filter(
        (n) =>
          n.post.publishedAt > after.ts ||
          (n.post.publishedAt === after.ts && n.itemId > after.id),
      )
    : subtree;
  const page = pageSource.slice(0, replyLimit);
  const last = page[page.length - 1];
  const nextReplyCursor =
    last && page.length < pageSource.length
      ? `${last.post.publishedAt}:${last.itemId}`
      : undefined;

  return {
    posts: [...ancestors, focal.post, ...page.map((n) => n.post)],
    focalId: focal.post.id,
    replyCursor: nextReplyCursor,
    totalDescendants,
  };
}

// =============================================================================
// Repost-edge attribution for every Post in the thread (§5 social-proof set).
// Wired now; empty until Phase 0c boosts accumulate.
// =============================================================================
async function fetchRepostEdges(postIds: string[]): Promise<RepostEdgeDTO[]> {
  if (postIds.length === 0) return [];
  const { rows } = await pool.query<any>(
    `SELECT re.target_post_id, re.actor_handle, re.actor_external_author_id,
            re.trust_weight, re.origin_uri,
            EXTRACT(EPOCH FROM re.boosted_at)::bigint AS boosted_at_epoch,
            xa.display_name AS actor_display_name, xa.handle AS actor_handle_name
       FROM repost_edges re
       LEFT JOIN external_authors xa ON xa.id = re.actor_external_author_id
      WHERE re.target_post_id = ANY($1)
      ORDER BY re.boosted_at DESC`,
    [postIds],
  );
  return rows.map((r) => ({
    targetPostId: r.target_post_id,
    actorId: r.actor_external_author_id ?? null,
    actorHandle: r.actor_handle,
    actorDisplayName: r.actor_display_name ?? r.actor_handle_name ?? null,
    trustWeight: Number(r.trust_weight),
    timestamp: Number(r.boosted_at_epoch),
    originUri: r.origin_uri ?? null,
  }));
}

export async function postThreadRoutes(app: FastifyInstance) {
  app.get<{
    Params: { postId: string };
    Querystring: { replyLimit?: string; replyCursor?: string };
  }>("/thread/:postId", { preHandler: optionalAuth }, async (req, reply) => {
    const { postId } = req.params;
    const viewerId = req.session?.sub ?? null;
    const replyLimit = Math.min(
      parseInt(req.query.replyLimit ?? String(DEFAULT_REPLY_LIMIT), 10) ||
        DEFAULT_REPLY_LIMIT,
      MAX_REPLY_LIMIT,
    );
    const replyCursor = parseReplyCursor(req.query.replyCursor);

    if (!POST_ID_RE.test(postId)) {
      return reply
        .status(400)
        .send({ error: "Invalid postId (expected a 64-char hex post_id)" });
    }

    try {
      const focalFeedItem = await loadFeedItemPost(postId);

      // ── external branch ───────────────────────────────────────────────────
      if (focalFeedItem && focalFeedItem.origin.protocol !== "nostr") {
        const node = await loadExternalNode(postId);
        if (!node) return reply.status(404).send({ error: "Thread not found" });
        // Hydrate the live source thread (Bluesky/Mastodon/Nostr) into the DB so
        // the pure-DB walk below can resolve ancestors + replies the projector
        // would otherwise miss (we only ingest a source's own posts, not the full
        // reply graph). Each protocol's hydrate makes several relay/API round
        // trips. We kick it off (or find a running one) and give it a short
        // synchronous budget to finish (D5): on a fast relay the whole thread is
        // committed before we assemble below, so `settled` is true and we return
        // the thread complete in one round trip with hydrating:false — no client
        // poll. If the budget elapses first — or the hydrate FAILS within it
        // (§0f-5: a fast failure must not read as settled, else the bare-focal
        // thread gets cached 60s with no poll to drive the retry) — we assemble
        // whatever is ingested so far and flag hydrating:true so the client
        // polls to merge the rest (D2).
        // `hydrating` = !settled derives from the in-flight registry (D1), NOT
        // from willHydrateThread — the latter flips false the instant the
        // throttle guard is set, so reading it here would yield a mid-flight
        // `hydrating: false` and cache an empty thread (the 60 s deadlock). Only
        // on the first/cursorless page — pagination walks the already-hydrated
        // subtree. See §8 parity fix in external-items.ts.
        let hydrating = false;
        if (!replyCursor) {
          const job = willHydrateThread(node.itemId, node.protocol)
            ? hydrateExternalThreadContext({
                id: node.itemId,
                source_id: node.sourceId,
                protocol: node.protocol,
                source_item_uri: node.sourceItemUri,
                interaction_data: node.interactionData,
              })
            : getInFlightHydration(node.itemId);
          const settled = await awaitHydrationWithinBudget(
            job,
            THREAD_HYDRATE_SYNC_BUDGET_MS,
          );
          hydrating = !settled;
        }
        const result = await assembleExternalThread(
          node,
          replyLimit,
          replyCursor,
        );
        const repostEdges = await fetchRepostEdges(
          result.posts.map((p) => p.id),
        );
        return reply.send({ ...result, repostEdges, hydrating });
      }

      // ── native branch ─────────────────────────────────────────────────────
      // Resolve the conversation root + focal. Either the focal IS a feed_items
      // THING (article/note root), or it's a comment (resolve its root).
      let rootPost: Post | null = focalFeedItem;
      let rootEventId: string | null = null;

      if (rootPost) {
        rootEventId = rootPost.origin.uri || null;
      } else {
        // focal is a native comment: find its conversation root, then the root THING.
        const { rows } = await pool.query<{ target_event_id: string }>(
          `SELECT target_event_id
             FROM comments
            WHERE feed_items_derive_post_id('nostr', nostr_event_id) = $1
            LIMIT 1`,
          [postId],
        );
        rootEventId = rows[0]?.target_event_id ?? null;
        if (!rootEventId)
          return reply.status(404).send({ error: "Thread not found" });
        // The root THING lives in feed_items keyed by its nostr_event_id → post_id.
        const rootRes = await pool.query<{ post_id: string }>(
          `SELECT post_id FROM feed_items
            WHERE nostr_event_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [rootEventId],
        );
        const rootThingPostId = rootRes.rows[0]?.post_id;
        if (rootThingPostId) rootPost = await loadFeedItemPost(rootThingPostId);
      }

      if (!rootPost || !rootEventId)
        return reply.status(404).send({ error: "Thread not found" });

      // Gate paywalled article conversations exactly like /conversation: locked
      // viewers get the focal THING (free portion only) but no comment bodies.
      if (rootPost.accessMode === "gated") {
        let hasAccess = false;
        if (viewerId) {
          // Re-fetch article ids for the access check, keyed on the conversation
          // ROOT THING (not the focal): a viewer deep-linking to a comment inside
          // a gated article must still get the access check, else a paying reader
          // is wrongly paywalled out of the thread.
          // re-fetch article ids for the access check
          const a = await pool.query<{
            id: string;
            writer_id: string;
            publication_id: string | null;
          }>(
            `SELECT a.id, a.writer_id, a.publication_id
               FROM feed_items fi JOIN articles a ON a.id = fi.article_id
              WHERE fi.post_id = $1 LIMIT 1`,
            [rootPost.id],
          );
          if (a.rows[0]) {
            const access = await checkArticleAccess(
              viewerId,
              a.rows[0].id,
              a.rows[0].writer_id,
              a.rows[0].publication_id,
            );
            hasAccess = access.hasAccess;
          }
        }
        if (!hasAccess) {
          const repostEdges = await fetchRepostEdges([rootPost.id]);
          return reply.send({
            focalId: postId === rootPost.id ? rootPost.id : postId,
            posts: [rootPost],
            repostEdges,
            totalDescendants: 0,
            paywallLocked: true,
          });
        }
      }

      const [comments, mutedIds] = await Promise.all([
        loadConversationComments(rootEventId),
        loadMutes(viewerId),
      ]);

      // If the focal was a comment, ensure it actually exists in this conversation.
      const focalPostId = focalFeedItem ? rootPost.id : postId;
      if (
        focalPostId !== rootPost.id &&
        !comments.some((c) => c.derived_post_id === focalPostId)
      ) {
        return reply.status(404).send({ error: "Thread not found" });
      }

      const result = assembleNativeThread(
        rootPost,
        comments,
        focalPostId,
        mutedIds,
        replyLimit,
        replyCursor,
      );
      const repostEdges = await fetchRepostEdges(result.posts.map((p) => p.id));
      return reply.send({ ...result, repostEdges });
    } catch (err) {
      logger.error({ err, postId }, "Thread fetch failed");
      return reply.status(500).send({ error: "Thread fetch failed" });
    }
  });
}
