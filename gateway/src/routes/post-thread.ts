import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance } from "fastify";
import { pool } from "@platform-pub/shared/db/client.js";
import { optionalAuth } from "../middleware/auth.js";
import { checkArticleAccess } from "../services/article-access/index.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { FEED_SELECT, FEED_JOINS } from "../lib/feed-sql.js";
import { collectDescendants, rankTopLevel } from "../lib/thread-walk.js";
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
import { parseLimit } from "../lib/request-inputs.js";
import { externalAuthorBlockedSql } from "@platform-pub/shared/lib/platform-blocks.js";
import { loadHiddenAuthorIds } from "../lib/blocks.js";
import {
  echoKey,
  loadEchoNotes,
  loadNoteEchoUris,
  reparentOntoNotes,
  substitutes,
  type EchoNote,
} from "../lib/cross-post-echo.js";

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
// The article foot's rest state (/thread/:postId/top): a page of direct
// replies, each carrying its first few replies as previews.
const TOP_LEVEL_PAGE = 10;
const TOP_LEVEL_PREVIEWS = 2;

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
// A PLATFORM-BLOCKED NPUB IS REFUSED HERE TOO (§0z item 15). The feed arm
// filtered blocked identities and nothing else did, so a blocked reply still
// rendered in every conversation it had reached. Every feed_items read in
// this projector carries `externalAuthorBlockedSql`, so the block holds
// "however they reach us" — a focal, a parent, a reply.
async function loadFeedItemPost(postId: string): Promise<Post | null> {
  // POST_SELECT/POST_JOINS carry no scoring machinery (score_live absent → score
  // undefined; boost_count absent → 0). That's exactly right for a thread node.
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.post_id = $1 AND fi.deleted_at IS NULL
        -- A COMMENT IS NOT A THING, AND SINCE MIGRATION 232 IT HAS A ROW HERE.
        -- A native reply now carries a feed_items row so it can reach a feed,
        -- minted with exactly the post_id this projector derives for it — so
        -- without this predicate every reply focal would resolve HERE, be
        -- treated as its own conversation's root, and return a thread with no
        -- ancestors and no descendants. The comments branch below is still the
        -- one that answers for a remark.
        AND fi.item_type <> 'comment'
        AND NOT ${externalAuthorBlockedSql("fi")}
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
  return loadConversationsComments([rootEventId]);
}

// The same read over several conversations at once — the external branch asks
// it for every native note it splices in (A2), each note being the root of its
// own `comments` conversation.
async function loadConversationsComments(
  rootEventIds: string[],
): Promise<CommentRow[]> {
  if (rootEventIds.length === 0) return [];
  const { rows } = await pool.query<CommentRow>(
    `SELECT c.id,
            feed_items_derive_post_id('nostr', c.nostr_event_id) AS derived_post_id,
            c.nostr_event_id,
            c.parent_comment_id,
            feed_items_derive_post_id('nostr', p.nostr_event_id) AS parent_post_id,
            -- The conversation's root, carried onto every comment Post as
            -- the "conversation" block: what a reply to this comment is
            -- addressed to (post-mapper.ts). The $1 above is this same event
            -- id, but read it off the ROW -- the mapper's contract is with
            -- its CommentRow, not with whatever a caller passed beside it.
            c.target_event_id,
            c.target_kind,
            c.content,
            EXTRACT(EPOCH FROM c.published_at)::bigint AS published_at_epoch,
            c.deleted_at,
            c.author_id,
            acc.display_name AS acc_display_name,
            acc.username AS acc_username,
            acc.nostr_pubkey AS nostr_pubkey,
            tl.pip_status AS pip_status,
            vt.upvote_count AS vt_up, vt.downvote_count AS vt_down
       FROM comments c
       JOIN accounts acc ON acc.id = c.author_id
       LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
       LEFT JOIN comments p ON p.id = c.parent_comment_id
       LEFT JOIN vote_tallies vt ON vt.target_nostr_event_id = c.nostr_event_id
      WHERE c.target_event_id = ANY($1::text[])
      ORDER BY c.published_at ASC`,
    [rootEventIds],
  );
  return rows;
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
  // D5: the root is paywalled and this viewer cannot read it. Stamped onto
  // every comment the conversation returns; `rootPost` arrives already stamped
  // by the caller, because it comes out of `feedItemToPost`, which takes no
  // viewer and must not learn to.
  rootLocked: boolean,
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
    ancestors.push(rootPost, ...chain.map((c) => commentToPost(c, rootPostId, mutedIds, rootLocked)));
  }

  // ── focal
  const focalPost: Post = focalIsRoot
    ? rootPost
    : commentToPost(focalComment!, rootPostId, mutedIds, rootLocked);

  // ── descendants: subtree under the focal, flattened chronologically.
  // (Flat chronological matches the playscript thread render — CLAUDE.md.)
  //
  // HIDDEN AUTHORS ARE DROPPED HERE, in the projector, and nowhere else (W2):
  // a comment by somebody the viewer muted, or with a block either way, is not
  // in the page, the cursor or `totalDescendants` — the article page's reply
  // tree renders nothing for the same flag, and a card cannot hide what the
  // projector counted without the count lying. The walk still runs over the
  // whole conversation first, so a hidden comment's replies keep their place
  // (the transcript is flat; they are not orphaned). The focal and its
  // ancestors are never dropped: the reader opened them on purpose, and an
  // ancestor chain with a hole in it is a thread that does not read.
  const subtree: CommentRow[] = collectDescendants(focalPostId, childrenOf).filter(
    (c) => c.deleted_at !== null || !mutedIds.has(c.author_id),
  );
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

  const descendants = page.map((c) => commentToPost(c, rootPostId, mutedIds, rootLocked));

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
        AND NOT ${externalAuthorBlockedSql("fi")}
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
        AND NOT ${externalAuthorBlockedSql("fi")}
      LIMIT 1`,
    [uri],
  );
  return rows[0] ? rowToExtNode(rows[0]) : null;
}

// Every direct reply to ANY of `parentUris` — one BFS LEVEL per query (CA-G4).
// The walk used to ask once per node, so a 500-reply thread was ~500 serial
// round-trips on every page; per level it is one per generation of depth.
async function loadExternalRepliesTo(parentUris: string[]): Promise<ExtNode[]> {
  if (parentUris.length === 0) return [];
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${EXT_NODE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE ei.source_reply_uri = ANY($1::text[]) AND fi.item_type = 'external' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}`,
    [parentUris],
  );
  return rows.map(rowToExtNode);
}

/** The most external descendants one thread read will walk (CA-G4). Every page
 *  loads the whole subtree to sort and slice it, so an unbounded walk is an
 *  unbounded read per page; past this the walk stops and says so in the log. */
const MAX_EXTERNAL_THREAD_NODES = 2000;

async function loadExternalNodeByItemId(itemId: string): Promise<ExtNode | null> {
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${EXT_NODE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.external_item_id = $1 AND fi.item_type = 'external' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}
      LIMIT 1`,
    [itemId],
  );
  return rows[0] ? rowToExtNode(rows[0]) : null;
}

// =============================================================================
// A NATIVE NOTE ANSWERING AN EXTERNAL POST IS PART OF THAT POST'S THREAD
// (CROSS-NETWORK-ROUNDTRIP-ADR F1/A2).
//
// `POST /external-items/:id/reply` writes a native note carrying
// `notes.external_parent_id`, and until A2 no projection read it: opening the
// member's reply showed the reply alone, and opening the post it answered
// showed every reply but theirs. Both halves are the same edge, so the external
// assembly admits it in both directions — a note whose parent is in the node
// set is a descendant, and a note focal anchors the walk on its parent.
//
// THE NOTE BRINGS ITS OWN CONVERSATION. Members who answer the note on
// all.haus write `comments` keyed on the note's event id, which the external
// walk never reads; a splice without them made those replies vanish the moment
// the thread was opened from the external side. Hidden authors are dropped
// exactly as the native projector drops them (the notes as well as the
// comments), and the focal never is.
// =============================================================================
interface SplicedNote {
  post: Post;
  noteId: string; // notes uuid (cursor id)
  eventId: string; // the note's event id — the root its comments target
  authorId: string;
}

function rowToSplicedNote(r: any): SplicedNote {
  return {
    post: feedItemToPost(r),
    noteId: r.splice_note_id,
    eventId: r.nostr_event_id,
    authorId: r.author_id,
  };
}

const SPLICE_COLS = `, n.id AS splice_note_id`;

async function loadSplicedNotes(parentItemIds: string[]): Promise<SplicedNote[]> {
  if (parentItemIds.length === 0) return [];
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${SPLICE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE n.external_parent_id = ANY($1::uuid[])
        AND fi.item_type = 'note' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}`,
    [parentItemIds],
  );
  return rows.map(rowToSplicedNote);
}

async function loadNotesByIds(noteIds: string[]): Promise<SplicedNote[]> {
  if (noteIds.length === 0) return [];
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${SPLICE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE n.id = ANY($1::uuid[])
        AND fi.item_type = 'note' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}`,
    [noteIds],
  );
  return rows.map(rowToSplicedNote);
}

// A note focal that belongs to an EXTERNAL thread: it answers an external
// post (A2), or its cross-post came back as an echo this viewer sees it in
// (rung B), or both. Null when neither holds — the native branch answers then.
interface NoteFocal {
  note: SplicedNote;
  parent: ExtNode | null;
  echoes: ExtNode[];
}

async function loadNoteFocal(
  postId: string,
  viewerId: string | null,
): Promise<NoteFocal | null> {
  const { rows } = await pool.query<any>(
    `SELECT ${FEED_SELECT}${POST_SELECT}${SPLICE_COLS}
       FROM feed_items fi
       ${FEED_JOINS}
       ${POST_JOINS}
      WHERE fi.post_id = $1 AND fi.item_type = 'note' AND fi.deleted_at IS NULL
        AND NOT ${externalAuthorBlockedSql("fi")}
      LIMIT 1`,
    [postId],
  );
  if (!rows[0]) return null;
  const note = rowToSplicedNote(rows[0]);
  const parent = rows[0].external_parent_id
    ? await loadExternalNodeByItemId(rows[0].external_parent_id)
    : null;
  const echoes: ExtNode[] = [];
  for (const e of await loadNoteEchoUris(note.eventId, note.authorId)) {
    if (!e.disclosed && note.authorId !== viewerId) continue;
    const node = await loadExternalByUri(e.sourceItemUri);
    if (node && node.protocol === e.protocol) echoes.push(node);
  }
  return parent || echoes.length > 0 ? { note, parent, echoes } : null;
}

// Walk source_reply_uri up from `from` through ingested items; root-first,
// `from` itself excluded.
async function loadExternalAncestors(from: ExtNode): Promise<ExtNode[]> {
  const seenUris = new Set<string>([from.sourceItemUri]);
  let cur: ExtNode | null = from;
  const chain: ExtNode[] = [];
  while (cur?.sourceReplyUri && !seenUris.has(cur.sourceReplyUri)) {
    seenUris.add(cur.sourceReplyUri);
    const parent: ExtNode | null = await loadExternalByUri(cur.sourceReplyUri);
    if (!parent) break; // ancestor not ingested — stop (live walk lives elsewhere)
    chain.push(parent);
    cur = parent;
  }
  return chain.reverse();
}

// An external chain as this viewer reads it: every echo this viewer sees as
// a member's note is drawn as the note (rung B). A hidden author's note stays
// in the chain flagged `isMuted`, as a native ancestor does — the chain must
// not break. The block acts only where the note is DRAWN: hiding an echo the
// viewer cannot see as the member's would tell them whose account it is.
async function projectExternalChain(
  chain: ExtNode[],
  mutedIds: ReadonlySet<string>,
  viewerId: string | null,
): Promise<{ posts: Post[]; noteByEchoPostId: Map<string, string> }> {
  const echoes = await loadEchoNotes(chain);
  const wanted = new Map<ExtNode, EchoNote>();
  for (const n of chain) {
    const e = echoes.get(echoKey(n.protocol, n.sourceItemUri));
    if (e && substitutes(e, viewerId)) wanted.set(n, e);
  }
  const notes = new Map(
    (await loadNotesByIds([...new Set([...wanted.values()].map((e) => e.noteId))])).map(
      (n) => [n.noteId, n],
    ),
  );
  const posts: Post[] = [];
  const noteByEchoPostId = new Map<string, string>();
  for (const n of chain) {
    const e = wanted.get(n);
    const note = e ? notes.get(e.noteId) : undefined;
    if (note) {
      noteByEchoPostId.set(n.post.id, note.post.id);
      posts.push(mutedIds.has(note.authorId) ? { ...note.post, isMuted: true } : note.post);
    } else {
      posts.push(n.post);
    }
  }
  return { posts: reparentOntoNotes(posts, noteByEchoPostId), noteByEchoPostId };
}

// One descendant of any kind, flattened for the keyset page. `cursorId` is the
// node's own uuid — external_items, notes or comments — all stable per node.
interface ThreadDescendant {
  post: Post;
  cursorId: string;
}

type ExternalFocal =
  | { kind: "external"; node: ExtNode }
  | ({ kind: "note" } & NoteFocal);

async function assembleExternalThread(
  focal: ExternalFocal,
  mutedIds: ReadonlySet<string>,
  viewerId: string | null,
  replyLimit: number,
  replyCursor: ReplyCursor | undefined,
): Promise<{
  posts: Post[];
  focalId: string;
  replyCursor?: string;
  totalDescendants: number;
}> {
  // ancestors: walk source_reply_uri up through ingested items, root-first —
  // and, for a note focal, the external post it answers.
  const chain: ExtNode[] =
    focal.kind === "external"
      ? await loadExternalAncestors(focal.node)
      : focal.parent
        ? [...(await loadExternalAncestors(focal.parent)), focal.parent]
        : [];
  const { posts: ancestors, noteByEchoPostId } = await projectExternalChain(
    chain,
    mutedIds,
    viewerId,
  );
  const focalPost = focal.kind === "external" ? focal.node.post : focal.note.post;
  const focalNoteId = focal.kind === "note" ? focal.note.noteId : null;

  // descendants: BFS over ingested replies, flattened chronologically. A note
  // focal's replies from elsewhere hang off its ECHOES, so the walk starts
  // there (rung B) — the thread of a note that was never echoed has none.
  const roots = focal.kind === "external" ? [focal.node] : focal.echoes;
  if (focal.kind === "note") {
    for (const e of focal.echoes) noteByEchoPostId.set(e.post.id, focal.note.post.id);
  }
  const extNodes: ExtNode[] = [];
  let level: string[] = roots.map((n) => n.sourceItemUri);
  const visited = new Set<string>([...level, ...chain.map((n) => n.sourceItemUri)]);
  while (level.length && extNodes.length < MAX_EXTERNAL_THREAD_NODES) {
    const replies = await loadExternalRepliesTo(level);
    // Children in the order of the parents that named them, so the walk visits
    // what the per-node BFS did (the subtree is re-sorted by date below).
    const order = new Map(level.map((uri, i) => [uri, i]));
    replies.sort(
      (a, b) => (order.get(a.sourceReplyUri!) ?? 0) - (order.get(b.sourceReplyUri!) ?? 0),
    );
    const next: string[] = [];
    for (const rep of replies) {
      if (visited.has(rep.sourceItemUri)) continue;
      if (extNodes.length >= MAX_EXTERNAL_THREAD_NODES) break;
      visited.add(rep.sourceItemUri);
      extNodes.push(rep);
      next.push(rep.sourceItemUri);
    }
    level = next;
  }
  if (extNodes.length >= MAX_EXTERNAL_THREAD_NODES) {
    logger.warn(
      { focalPostId: focalPost.id, cap: MAX_EXTERNAL_THREAD_NODES },
      "External thread walk stopped at its node cap — descendants past it are not shown",
    );
  }

  // Which descendants are a member's echo, drawn as their note for this
  // viewer? Their notes join the spliced ones (a cross-posted reply is BOTH:
  // its note answers the parent, and its echo sits beside it), once each.
  const echoes = await loadEchoNotes(extNodes);
  const drawnAsNote = new Map<ExtNode, EchoNote>();
  for (const n of extNodes) {
    const e = echoes.get(echoKey(n.protocol, n.sourceItemUri));
    if (e && substitutes(e, viewerId)) drawnAsNote.set(n, e);
  }
  const [echoedNotes, spliced] = await Promise.all([
    loadNotesByIds([...new Set([...drawnAsNote.values()].map((e) => e.noteId))]),
    loadSplicedNotes([...roots, ...extNodes].map((n) => n.itemId)),
  ]);
  const notesById = new Map<string, SplicedNote>();
  for (const n of [...echoedNotes, ...spliced]) {
    if (n.noteId !== focalNoteId) notesById.set(n.noteId, n);
  }

  const subtree: ThreadDescendant[] = [];
  for (const n of extNodes) {
    const e = drawnAsNote.get(n);
    const notePostId =
      e?.noteId === focalNoteId
        ? focalPost.id
        : e
          ? notesById.get(e.noteId)?.post.id
          : undefined;
    if (notePostId) {
      // The echo is never drawn; its children re-parent onto the note.
      noteByEchoPostId.set(n.post.id, notePostId);
      continue;
    }
    subtree.push({ post: n.post, cursorId: n.itemId });
  }
  for (const n of notesById.values()) {
    if (!mutedIds.has(n.authorId)) subtree.push({ post: n.post, cursorId: n.noteId });
  }
  const notes: SplicedNote[] = [
    ...(focal.kind === "note" ? [focal.note] : []),
    ...notesById.values(),
  ];

  // Each spliced note's own conversation, projected exactly as the native
  // branch projects it — a note is never gated, so its root is not locked.
  const notePostIdByEvent = new Map(notes.map((n) => [n.eventId, n.post.id]));
  const comments = await loadConversationsComments([...notePostIdByEvent.keys()]);
  for (const c of comments) {
    if (c.deleted_at === null && mutedIds.has(c.author_id)) continue;
    const rootPostId = notePostIdByEvent.get(c.target_event_id);
    if (!rootPostId) continue;
    subtree.push({
      post: commentToPost(c, rootPostId, mutedIds, false),
      cursorId: c.id,
    });
  }

  subtree.sort(
    (a, b) =>
      a.post.publishedAt - b.post.publishedAt ||
      (a.cursorId < b.cursorId ? -1 : 1),
  );

  const totalDescendants = subtree.length;
  const after = replyCursor;
  const pageSource = after
    ? subtree.filter(
        (n) =>
          n.post.publishedAt > after.ts ||
          (n.post.publishedAt === after.ts && n.cursorId > after.id),
      )
    : subtree;
  const page = pageSource.slice(0, replyLimit);
  const last = page[page.length - 1];
  const nextReplyCursor =
    last && page.length < pageSource.length
      ? `${last.post.publishedAt}:${last.cursorId}`
      : undefined;

  return {
    posts: reparentOntoNotes(
      [...ancestors, focalPost, ...page.map((n) => n.post)],
      noteByEchoPostId,
    ),
    focalId: focalPost.id,
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

// Is the conversation's ROOT paywalled against this viewer (D5)? Keyed on the
// root THING, never the focal: a viewer deep-linking to a comment inside a
// gated article must still get the access check, else a paying reader is
// wrongly locked out of the thread. Shared by /thread and /thread/:id/top.
async function isRootLocked(rootPost: Post, viewerId: string | null): Promise<boolean> {
  if (rootPost.accessMode !== "gated") return false;
  if (!viewerId) return true;
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
  if (!a.rows[0]) return true;
  const access = await checkArticleAccess(
    viewerId,
    a.rows[0].id,
    a.rows[0].writer_id,
    a.rows[0].publication_id,
  );
  return !access.hasAccess;
}

export async function postThreadRoutes(app: FastifyInstance) {
  app.get<{
    Params: { postId: string };
    Querystring: { replyLimit?: string; replyCursor?: string };
  }>("/thread/:postId", { preHandler: optionalAuth }, async (req, reply) => {
    const { postId } = req.params;
    const viewerId = req.session?.sub ?? null;
    const replyLimit = parseLimit(req.query.replyLimit, DEFAULT_REPLY_LIMIT, MAX_REPLY_LIMIT);
    const replyCursor = parseReplyCursor(req.query.replyCursor);

    if (!POST_ID_RE.test(postId)) {
      return reply.status(404).send({ error: "We couldn't find that conversation." });
    }

    try {
      const focalFeedItem = await loadFeedItemPost(postId);

      // A native note answering an external post reads as part of THAT
      // post's thread (A2), anchored on the parent; a note whose cross-post
      // came back reads with the replies its echoes drew (rung B).
      let noteFocal: NoteFocal | null =
        focalFeedItem?.type === "note" && focalFeedItem.origin.protocol === "nostr"
          ? await loadNoteFocal(postId, viewerId)
          : null;

      // ── external branch ───────────────────────────────────────────────────
      if (
        noteFocal ||
        (focalFeedItem && focalFeedItem.origin.protocol !== "nostr")
      ) {
        const node = noteFocal ? null : await loadExternalNode(postId);
        if (!noteFocal && !node) return reply.status(404).send({ error: "We couldn't find that conversation." });
        // Opening an ECHO this viewer sees as a member's note opens the note:
        // the projector answers with the note as focal, which the client
        // takes on a first load (rung B).
        if (node) {
          const echo = (await loadEchoNotes([node])).get(
            echoKey(node.protocol, node.sourceItemUri),
          );
          if (echo && substitutes(echo, viewerId)) {
            noteFocal = await loadNoteFocal(echo.notePostId, viewerId);
          }
        }
        // What the live source is asked about: the external focal, or every
        // echo of a note focal (they carry its replies), else what it answers.
        const hydrateNodes: ExtNode[] = noteFocal
          ? noteFocal.echoes.length > 0
            ? noteFocal.echoes
            : [noteFocal.parent!]
          : [node!];
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
          const jobs = hydrateNodes
            .map((n) =>
              willHydrateThread(n.itemId, n.protocol)
                ? hydrateExternalThreadContext({
                    id: n.itemId,
                    source_id: n.sourceId,
                    protocol: n.protocol,
                    source_item_uri: n.sourceItemUri,
                    interaction_data: n.interactionData,
                  })
                : getInFlightHydration(n.itemId),
            )
            .filter((j): j is Promise<boolean> => j !== undefined);
          const settled = await awaitHydrationWithinBudget(
            jobs.length === 0
              ? undefined
              : jobs.length === 1
                ? jobs[0]
                : Promise.all(jobs).then((r) => r.every(Boolean)),
            THREAD_HYDRATE_SYNC_BUDGET_MS,
          );
          hydrating = !settled;
        }
        const result = await assembleExternalThread(
          noteFocal
            ? { kind: "note", ...noteFocal }
            : { kind: "external", node: node! },
          await loadHiddenAuthorIds(viewerId),
          viewerId,
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
        // Through the comment's own card (migration 232: every comment has a
        // `feed_items` row, `item_type = 'comment'`, written in the comment's
        // transaction and minted from its event id — the address derived here
        // before). Filtering `comments` on the derivation hashed every row on
        // the table per request, there being no expression index (CA-G5). The
        // operator-block predicate is a no-op on a native card (no external
        // author) and is here because EVERY feed_items read in this projector
        // carries it — `npub-block-reach.test.ts` counts them.
        const { rows } = await pool.query<{ target_event_id: string }>(
          `SELECT c.target_event_id
             FROM feed_items fi
             JOIN comments c ON c.id = fi.comment_id
            WHERE fi.post_id = $1 AND fi.item_type = 'comment'
              AND NOT ${externalAuthorBlockedSql("fi")}
            LIMIT 1`,
          [postId],
        );
        rootEventId = rows[0]?.target_event_id ?? null;
        if (!rootEventId)
          return reply.status(404).send({ error: "We couldn't find that conversation." });
        // The root THING lives in feed_items keyed by its nostr_event_id → post_id.
        const rootRes = await pool.query<{ post_id: string }>(
          `SELECT post_id FROM feed_items
            WHERE nostr_event_id = $1 AND deleted_at IS NULL
              AND item_type <> 'comment' LIMIT 1`,
          [rootEventId],
        );
        const rootThingPostId = rootRes.rows[0]?.post_id;
        if (rootThingPostId) rootPost = await loadFeedItemPost(rootThingPostId);
      }

      if (!rootPost || !rootEventId)
        return reply.status(404).send({ error: "We couldn't find that conversation." });

      // THE CONVERSATION IS PUBLIC; THE ARTICLE IS NOT.
      // ARTICLE-HEADED-CONVERSATIONS-ADR D3. A comment on a paywalled article is
      // the commenter's own speech ABOUT a piece, not the piece, and the
      // discussion is the best argument the piece has: a reader who follows a
      // reply back to the article, reads what four other people said and cannot
      // read the article is a reader with a reason to buy it. So a locked viewer
      // gets the whole conversation — the article card at its head carrying only
      // `content_free` (D4, and that is a property of the mapper, not a
      // redaction step here) — and what they LOSE is the ability to join it:
      // every node ships `rootLocked: true` and the card suppresses reply, quote
      // and vote on it (D6). The write path is closed independently, server-side
      // (D7, POST /replies).
      //
      // This branch used to return the root alone with `paywallLocked: true` and
      // no comments. That flag is gone with it (D8) — per NODE is what the
      // profile's Replies log needs, where a comment card renders outside any
      // conversation envelope, and one field serves both surfaces.
      const rootLocked = await isRootLocked(rootPost, viewerId);
      // The ROOT is stamped here and not in the mapper: it arrives from
      // `loadFeedItemPost` -> `feedItemToPost`, which takes no viewer, so this
      // is the one place that knows. Without it the head article card reads a
      // field nothing sets and keeps affordances the rest of the conversation
      // has lost (D5, D6).
      if (rootLocked) rootPost = { ...rootPost, rootLocked: true };

      const [comments, mutedIds] = await Promise.all([
        loadConversationComments(rootEventId),
        loadHiddenAuthorIds(viewerId),
      ]);

      // A PROJECTOR NEVER RETURNS A FOCAL IT DID NOT SEND (D9). If the focal was
      // a comment, it must actually exist in this conversation — otherwise the
      // response would carry a `focalId` absent from its own `posts`,
      // `deriveThreadView` would return null and PostThread would render
      // "Loading thread…" for ever: not an error, not a gate, a spinner with no
      // end, which is why the gated branch above wore one unreported for its
      // whole life. 404 is the honest answer; a malformed thread is not.
      const focalPostId = focalFeedItem ? rootPost.id : postId;
      if (
        focalPostId !== rootPost.id &&
        !comments.some((c) => c.derived_post_id === focalPostId)
      ) {
        return reply.status(404).send({ error: "We couldn't find that conversation." });
      }

      const result = assembleNativeThread(
        rootPost,
        comments,
        focalPostId,
        mutedIds,
        replyLimit,
        replyCursor,
        rootLocked,
      );
      // A remark under a note that answers an external post: the thread above
      // the note is the external one (A2), so the ancestors continue up it.
      // No hydration here — the note's own open does that; this reads what is
      // already ingested.
      if (focalPostId !== rootPost.id && rootPost.type === "note") {
        const rootNote = await loadNoteFocal(rootPost.id, viewerId);
        if (rootNote?.parent) {
          const chain = await projectExternalChain(
            [...(await loadExternalAncestors(rootNote.parent)), rootNote.parent],
            mutedIds,
            viewerId,
          );
          result.posts.unshift(...chain.posts);
          result.posts = reparentOntoNotes(result.posts, chain.noteByEchoPostId);
        }
      }
      const repostEdges = await fetchRepostEdges(result.posts.map((p) => p.id));
      return reply.send({ ...result, repostEdges });
    } catch (err) {
      logger.error({ err, postId }, "Thread fetch failed");
      return reply.status(500).send({ error: "Couldn't load this conversation. Please try again." });
    }
  });

  // ===========================================================================
  // GET /thread/:postId/top?limit=10&offset=0&focusComment=<comments.id>
  //
  // The article foot's RESTING shape (operator, 2026-09-27): the conversation's
  // direct replies, ranked by how much conversation hangs off each, each with
  // its first two replies as previews and its subtree count. Opening any one
  // of them reads the ordinary /thread from that node, so this route only ever
  // answers the rest state. Native article/note roots only — the one host is
  // the native article reader.
  //
  //   → { rootId, posts, topLevel: [{ id, count, previewIds }], nextOffset?,
  //       totalTopLevel, totalReplies, focus: { postId, topLevelId } | null,
  //       repostEdges }
  //
  // `focusComment` is an ERRAND (a notification, a `#reply-<id>` address, the
  // reader's own just-published reply): on the first page the slice is widened
  // through the reply that carries it, so the client never pages to find it.
  // ===========================================================================
  app.get<{
    Params: { postId: string };
    Querystring: { limit?: string; offset?: string; focusComment?: string };
  }>("/thread/:postId/top", { preHandler: optionalAuth }, async (req, reply) => {
    const { postId } = req.params;
    const viewerId = req.session?.sub ?? null;
    const limit = parseLimit(req.query.limit, TOP_LEVEL_PAGE, MAX_REPLY_LIMIT);
    const rawOffset = parseInt(req.query.offset ?? "0", 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const focusComment =
      req.query.focusComment && UUID_RE.test(req.query.focusComment)
        ? req.query.focusComment
        : null;

    if (!POST_ID_RE.test(postId)) return reply.status(404).send({ error: "We couldn't find that conversation." });

    try {
      let rootPost = await loadFeedItemPost(postId);
      const rootEventId = rootPost?.origin.uri || null;
      if (!rootPost || rootPost.origin.protocol !== "nostr" || !rootEventId)
        return reply.status(404).send({ error: "We couldn't find that conversation." });

      const rootLocked = await isRootLocked(rootPost, viewerId);
      if (rootLocked) rootPost = { ...rootPost, rootLocked: true };

      const [comments, mutedIds] = await Promise.all([
        loadConversationComments(rootEventId),
        loadHiddenAuthorIds(viewerId),
      ]);

      const rootPostId = rootPost.id;
      const byPostId = new Map<string, CommentRow>();
      const childrenOf = new Map<string, CommentRow[]>();
      for (const c of comments) byPostId.set(c.derived_post_id, c);
      for (const c of comments) {
        const parentId = c.parent_post_id ?? rootPostId;
        (childrenOf.get(parentId) ?? childrenOf.set(parentId, []).get(parentId)!).push(c);
      }

      // The projector's own membership test (see assembleNativeThread), and
      // the stricter one for what may stand alone at rest.
      const counted = (c: CommentRow) => c.deleted_at !== null || !mutedIds.has(c.author_id);
      const shown = (c: CommentRow) => !mutedIds.has(c.author_id);
      const ranked = rankTopLevel(rootPostId, childrenOf, counted, shown, TOP_LEVEL_PREVIEWS);

      // The errand: walk the comment up to the reply that stands at the top.
      let focus: { postId: string; topLevelId: string } | null = null;
      if (focusComment) {
        let cur = comments.find((c) => c.id === focusComment);
        const focusPostId = cur?.derived_post_id;
        const seen = new Set<string>();
        while (cur?.parent_post_id && !seen.has(cur.parent_post_id)) {
          seen.add(cur.parent_post_id);
          cur = byPostId.get(cur.parent_post_id);
        }
        if (focusPostId && cur && !cur.parent_post_id) {
          focus = { postId: focusPostId, topLevelId: cur.derived_post_id };
        }
      }
      const focusIndex = focus
        ? ranked.findIndex((r) => r.node.derived_post_id === focus.topLevelId)
        : -1;
      const end =
        offset === 0 && focusIndex >= 0
          ? Math.max(limit, focusIndex + 1)
          : offset + limit;
      const page = ranked.slice(offset, end);

      const toPost = (c: CommentRow) => commentToPost(c, rootPostId, mutedIds, rootLocked);
      const posts: Post[] = [];
      for (const r of page) posts.push(toPost(r.node), ...r.previews.map(toPost));

      const repostEdges = await fetchRepostEdges(posts.map((p) => p.id));
      return reply.send({
        rootId: rootPostId,
        posts,
        topLevel: page.map((r) => ({
          id: r.node.derived_post_id,
          count: r.count,
          previewIds: r.previews.map((c) => c.derived_post_id),
        })),
        nextOffset: end < ranked.length ? end : undefined,
        totalTopLevel: ranked.length,
        totalReplies: comments.filter(counted).length,
        focus,
        repostEdges,
      });
    } catch (err) {
      logger.error({ err, postId }, "Top-level thread fetch failed");
      return reply.status(500).send({ error: "Couldn't load this conversation. Please try again." });
    }
  });
}
