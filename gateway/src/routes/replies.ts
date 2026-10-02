import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { checkArticleAccess } from "../services/article-access/index.js";
import { resolveEventTarget, replyEventIdIsTaken } from "../lib/event-target.js";
import { signEvent } from "../lib/key-custody-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import { resolveMentionedAccountIds } from "../lib/mentions.js";
import { blockExistsBetween, loadHiddenAuthorIds } from "../lib/blocks.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { isUuid } from "../lib/request-inputs.js";

// =============================================================================
// Reply Routes
//
// POST   /replies                      — Index a published reply
// GET    /replies/:targetEventId       — Fetch threaded replies for content
// DELETE /replies/:replyId             — Soft-delete a reply
// (Replies on an article are toggled by `PATCH /articles/:id`; a note has no
// toggle — CA-I4 deleted the two uncalled PATCH …/replies routes.)
// =============================================================================

const REPLY_CHAR_LIMIT = 2000;

// `GET /replies/:targetEventId` returned EVERY comment on a piece, with no
// bound of any kind, and builds a two-level tree out of them in memory. One
// popular article — or one automated flood under any article, since a reply
// costs an account and nothing else — is an unbounded row count and an
// unbounded response on a route `optionalAuth` serves to anybody.
//
// A time-ordered prefix is the safe cut, and that is not an accident: a reply
// is published after the comment it replies to, so `ORDER BY published_at ASC`
// puts every parent before its child and any prefix of it is closed under
// parenthood. Truncating the tail therefore drops leaves and can never orphan
// a comment it keeps. (The assembly below re-parents an orphan to the top
// level anyway, which is the belt to this braces.)
const REPLY_TREE_LIMIT = 500;

const IndexReplySchema = z.object({
  nostrEventId: z.string().min(1),
  targetEventId: z.string().min(1),
  targetKind: z.number().int(),
  parentCommentId: z.string().uuid().nullable().optional(),
  content: z.string().min(1).max(REPLY_CHAR_LIMIT),
});

export async function replyRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /replies — index a published reply
  // ---------------------------------------------------------------------------

  app.post("/replies", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexReplySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error));
    }

    const authorId = req.session!.sub;
    const data = parsed.data;

    try {
      // WHAT THE ID NAMES DECIDES, NOT WHAT THE REQUEST CLAIMS (MIRROR-AUDIT
      // §2.7). This route used to pick its table from `data.targetKind`, so a
      // note minted under a paywalled article's event id — which `POST /notes`
      // accepts, the id being client-supplied — plus `targetKind: 1` sent the
      // lookup into `notes`, and the guard below, which keys on the ARTICLE
      // row, never ran. The resolver searches articles first and the squattable
      // table last; see its header for the order and why a disagreeing kind is
      // ignored rather than refused.
      const target = await resolveEventTarget(
        pool,
        data.targetEventId,
        data.targetKind,
      );

      if (!target) {
        return reply.status(404).send({ error: "We couldn't find what you're replying to." });
      }

      // A COMMENT IS NOT A REPLY TARGET, and this is the one place the resolver
      // finds something this route must still refuse. `comments.target_event_id`
      // is the CONVERSATION'S ROOT — replies-to-replies share it and nest via
      // `parentCommentId`, which the parent check below enforces — so accepting
      // a comment here would mint a row whose target is not a root and quietly
      // break every reader that assumes one. Nesting is `parentCommentId`.
      if (target.kind === 1111) {
        return reply.status(400).send({
          error: "target_is_reply",
          message:
            "Reply to the conversation's root and nest with parentCommentId.",
        });
      }

      if (!target.commentsEnabled) {
        return reply
          .status(403)
          .send({ error: "Replies are turned off for this post." });
      }

      // A block between the replier and the content's author, EITHER way
      // (W2, 2026-09-24) — through the one home, with the one neutral refusal.
      // It asked one direction only; a blocker could go on commenting under
      // the work of the member they had blocked, in a conversation that member
      // could no longer answer in.
      const contentAuthorId = target.authorId;
      if (await blockExistsBetween(contentAuthorId, authorId)) {
        return reply
          .status(403)
          .send({ error: "You can't reply to this." });
      }

      // A comment on a piece you cannot read is a write into a conversation the
      // paywall holds, so the WRITE path carries the same guard the GET does
      // (:270-291 below). It had none for as long as the route has existed; the
      // rule was enforced only by the article page declining to draw a composer,
      // which is a UI rule and a UI rule is not an access control.
      //
      // GUARD, NOT A BARE CALL. `checkArticleAccess` carries no access_mode term
      // — for a free article by somebody else it returns {hasAccess: false}
      // exactly as it does for an unpaid paywalled one — so called
      // unconditionally it would 403 EVERY comment on EVERY free article on the
      // site. The `access_mode === "paywalled"` branch is what makes it a gate
      // rather than a wall. Own content is covered inside the checker
      // (readerId === writerId), so an author commenting under their own
      // paywalled piece is unaffected.
      // ARTICLE-HEADED-CONVERSATIONS-ADR D7.
      // Narrowed by the RESOLVED kind, never by `data.targetKind`: the
      // discriminator lives on the request and the union lives on the row, and
      // trusting the request here was the §2.7 bypass itself.
      if (target.kind === 30023 && target.accessMode === "paywalled") {
        const access = await checkArticleAccess(
          authorId,
          target.articleId,
          target.authorId,
          target.publicationId,
        );
        if (!access.hasAccess) {
          return reply
            .status(403)
            .send({ error: "Unlock this article to reply" });
        }
      }

      // If replying to another reply, verify parent exists and references same
      // target. `author_id` comes off THIS read and not a second one: it is the
      // person being replied to, and the guard has already proved the row is
      // live and in this conversation, which is exactly what makes them a
      // recipient. A later lookup would be a second chance to read a row that
      // has changed underneath the first.
      let parentAuthorId: string | null = null;
      if (data.parentCommentId) {
        const parentCheck = await pool.query<{
          target_event_id: string;
          author_id: string;
        }>(
          `SELECT target_event_id, author_id FROM comments WHERE id = $1 AND deleted_at IS NULL`,
          [data.parentCommentId],
        );
        if (parentCheck.rows.length === 0) {
          return reply.status(404).send({ error: "We couldn't find the reply you're answering." });
        }
        if (parentCheck.rows[0].target_event_id !== data.targetEventId) {
          return reply
            .status(400)
            .send({ error: "Parent reply references different content" });
        }
        parentAuthorId = parentCheck.rows[0].author_id;
        // THE PERSON BEING REPLIED TO IS ASKED TOO (CA-B8, 2026-09-29). The
        // guard above asks the CONTENT's author; a reply to a comment puts
        // words under somebody else's remark, and a block between the replier
        // and THAT member ran unasked — a blocked member could go on answering
        // the blocker's comments (the projector hides the parent from them,
        // which is a UI rule, and a UI rule is not an access control). Same
        // home, same neutral refusal; the root author is not re-asked.
        if (
          parentAuthorId !== contentAuthorId &&
          (await blockExistsBetween(parentAuthorId, authorId))
        ) {
          return reply
            .status(403)
            .send({ error: "You can't reply to this." });
        }
      }

      // A NATIVE REPLY IS A POST, SO IT GETS ITS TIMELINE ROW — in the SAME
      // TRANSACTION as the comment, like every other dual-write on the site
      // (`POST /notes`, the article publishers). Until migration 232 a comment
      // had no `feed_items` row at all, which is the whole of why a reply could
      // never reach a feed however its author's followers had composed one,
      // while EXTERNAL replies have been arriving throughout.
      //
      // `is_reply` is TRUE by construction, and that is the only thing the
      // reader's "no replies" chip needs: `feed_sources.exclude_replies` is
      // already asked of `fi.is_reply` inside the feed's source arms, so this
      // one column makes the setting govern native replies with no new
      // predicate anywhere.
      //
      // Everything else about the card — its body, its conversation, who it
      // answers — is read back through the `comments` join by the shared
      // projection, so nothing here is a second copy of the reply's content
      // except `content_preview`, which exists for the surfaces that only have
      // the row (the moderation snapshot).
      const { commentId, duplicate, squatted } = await withTransaction(async (client) => {
        // A COMMENT MUST NOT SHADOW AN ARTICLE OR A NOTE (CA-B2): the unique
        // index refuses only a second comment. Asked in the same transaction
        // as the INSERT, as `POST /notes` asks its twin, so a concurrent
        // plant cannot slip between the check and the write.
        if (await replyEventIdIsTaken(client, data.nostrEventId)) {
          return { commentId: null, duplicate: false, squatted: true };
        }
        const result = await client.query<{ id: string }>(
          `INSERT INTO comments (
             author_id, nostr_event_id, target_event_id, target_kind,
             parent_comment_id, content, published_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (nostr_event_id) DO NOTHING
           RETURNING id`,
          [
            authorId,
            data.nostrEventId,
            data.targetEventId,
            // The RESOLVED kind is what gets persisted. `comments.target_kind` is
            // read as a fact about the row it points at, so storing the client's
            // claim would record the squat's version of events forever.
            target.kind,
            data.parentCommentId ?? null,
            data.content,
          ],
        );

        if (result.rows.length === 0) return { commentId: null, duplicate: true, squatted: false };
        const cId = result.rows[0].id;

        const {
          rows: [author],
        } = await client.query<{
          display_name: string | null;
          avatar_blossom_url: string | null;
          username: string | null;
        }>(
          `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
          [authorId],
        );

        await client.query(
          `INSERT INTO feed_items (
             item_type, comment_id, author_id,
             author_name, author_avatar, author_username,
             content_preview, nostr_event_id,
             published_at, is_reply
           ) VALUES (
             'comment', $1, $2,
             $3, $4, $5,
             $6, $7,
             now(), TRUE
           )
           ON CONFLICT (comment_id) WHERE comment_id IS NOT NULL DO UPDATE SET
             content_preview = EXCLUDED.content_preview,
             author_name = EXCLUDED.author_name,
             author_avatar = EXCLUDED.author_avatar,
             author_username = EXCLUDED.author_username`,
          [
            cId,
            authorId,
            author?.display_name ?? author?.username ?? "Unknown",
            author?.avatar_blossom_url ?? null,
            author?.username ?? null,
            truncatePreview(data.content),
            data.nostrEventId,
          ],
        );

        return { commentId: cId, duplicate: false, squatted: false };
      });

      // `commentId === null` is the same fact as `duplicate` and is spelled
      // out so the narrowing is the compiler's rather than a reader's: a
      // destructured union does not carry its discriminant.
      if (squatted) {
        logger.warn(
          { authorId, nostrEventId: data.nostrEventId },
          "Reply refused: event id already names an article or a note",
        );
        return reply.status(409).send({
          error: "event_id_taken",
          message: "That event id already belongs to other content.",
        });
      }
      if (duplicate || commentId === null) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      // Record in feed_engagement for ranking
      await pool
        .query(
          `INSERT INTO feed_engagement (actor_id, target_nostr_event_id, target_author_id, engagement_type)
         VALUES ($1, $2, $3, 'reply')`,
          [authorId, data.targetEventId, contentAuthorId],
        )
        .catch((err) =>
          logger.warn({ err }, "Failed to insert reply feed_engagement"),
        );

      // The notification's reference columns come off the RESOLVED target,
      // never off a second lookup keyed on `data.targetKind`. That second
      // lookup was the §2.7 branch-on-kind surviving one statement past the
      // fix (S25): for the honest mismatch the resolver tolerates — a native
      // reply projected as `type: "note"` replying with kind 1 on an article —
      // it read `notes`, found nothing, and wrote the notification with BOTH
      // `article_id` and `note_id` NULL. Right recipient, no link. The 1111 arm
      // was refused above, so what remains is exactly an article or a note.
      const notificationArticleId =
        target.kind === 30023 ? target.articleId : null;
      const notificationNoteId = target.kind === 1 ? target.noteId : null;

      // A REPLY IS TO SOMEBODY, AND UNTIL 2026-09-18 IT TOLD THE WRONG PERSON.
      // This notified the RESOLVED target's author and nobody else — so
      // replying to a comment told the author of the article or note, while the
      // person actually replied to learned nothing and had no way to find out
      // that the conversation they were in had continued. Two people have a
      // claim on a nested reply and they are told different things:
      //
      //   the parent comment's author  "X replied to your comment"
      //   the root's author            "X replied to <your piece>"
      //
      // WHICH IS WHICH IS `parent_comment_id`, BOUND ON ONE ROW AND NOT THE
      // OTHER (migration 230). The two rows are otherwise identical — same
      // actor, same article/note, and the same `comment_id`, which on BOTH is
      // the NEW reply, because that is what the panel renders and what
      // `focus_post_id` opens. Without a column to tell them apart the client is
      // holding two indistinguishable rows and has to guess the sentence.
      // `recipient_id` separates them in `idx_notifications_dedup`, so they do
      // not collapse; the new column is deliberately not in that index and the
      // migration says why.
      //
      // ONE PERSON, ONE ROW, AND THE SPECIFIC SENTENCE WINS. Where the parent's
      // author IS the root's author — a writer answered under their own piece
      // and somebody replied to them — they get a single notification, the one
      // naming their comment. Two rows for one person, one of them vaguer,
      // would be the pub_* collapse in reverse.
      //
      // SELF IS DROPPED LAST, not by an early return: replying to your own
      // comment under somebody else's piece still owes THAT writer a
      // notification, and a guard placed at the top would have swallowed it.
      const recipients: Array<{ id: string; parentCommentId: string | null }> =
        [];
      if (parentAuthorId) {
        recipients.push({
          id: parentAuthorId,
          parentCommentId: data.parentCommentId ?? null,
        });
      }
      if (contentAuthorId !== parentAuthorId) {
        recipients.push({ id: contentAuthorId, parentCommentId: null });
      }

      // ONE STATEMENT EACH, never one INSERT with two VALUES rows: a partial
      // outcome is not a total one, and a single statement makes the two
      // recipients share a fate they have no reason to share.
      for (const recipient of recipients) {
        if (recipient.id === authorId) continue;
        pool
          .query(
            `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id, comment_id, parent_comment_id)
           VALUES ($1, $2, 'new_reply', $3, $4, $5, $6)
           ON CONFLICT DO NOTHING`,
            [
              recipient.id,
              authorId,
              notificationArticleId,
              notificationNoteId,
              commentId,
              recipient.parentCommentId,
            ],
          )
          .catch((err) =>
            logger.warn({ err }, "Failed to insert new_reply notification"),
          );
      }

      logger.info(
        {
          replyId: commentId,
          authorId,
          targetEventId: data.targetEventId,
        },
        "Reply indexed",
      );

      // Notify @mentioned users (fire-and-forget). The scan and the handle walk
      // live in `lib/mentions.ts` — see that header for why the greedy token is
      // not the handle. The LOOKUP is caught here too: it sat under the route's
      // own catch, so a failure of it answered 500 for a reply already written.
      let mentionedIds: string[] = [];
      try {
        mentionedIds = await resolveMentionedAccountIds(
          pool,
          data.content,
          authorId,
        );
      } catch (err) {
        logger.warn({ err }, "Failed to resolve mentions");
      }
      for (const mentionedId of mentionedIds) {
        pool
          .query(
            // BINDS THE COMMENT THE MENTION IS IN (migration 198's other
            // half; the column was already in the dedup index). Bound to the
            // article or note alone, two mentions of the same person by the
            // same author in two different comments on ONE article were one
            // notification, and the second was silently dropped — which for a
            // mention is somebody being told about a conversation they were
            // named in and not told about the next one.
            `INSERT INTO notifications (recipient_id, actor_id, type, article_id, note_id, comment_id)
           VALUES ($1, $2, 'new_mention', $3, $4, $5)
           ON CONFLICT DO NOTHING`,
            [
              mentionedId,
              authorId,
              notificationArticleId,
              notificationNoteId,
              commentId,
            ],
          )
          .catch((err) =>
            logger.warn({ err }, "Failed to insert mention notification"),
          );
      }

      return reply.status(201).send({ commentId });
    } catch (err) {
      logger.error({ err, authorId }, "Reply indexing failed");
      return reply.status(500).send({ error: "Couldn't post your reply. Please try again." });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /replies/:targetEventId — fetch threaded replies
  // ---------------------------------------------------------------------------

  app.get<{ Params: { targetEventId: string } }>(
    "/replies/:targetEventId",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { targetEventId } = req.params;
      const currentUserId = req.session?.sub ?? null;

      // Check if replies are enabled on target
      const articleCheck = await pool.query<{ comments_enabled: boolean }>(
        `SELECT comments_enabled FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
        [targetEventId],
      );
      const noteCheck =
        articleCheck.rows.length > 0
          ? articleCheck
          : await pool.query<{ comments_enabled: boolean }>(
              `SELECT comments_enabled FROM notes WHERE nostr_event_id = $1`,
              [targetEventId],
            );

      const repliesEnabled = noteCheck.rows[0]?.comments_enabled ?? true;

      // If target is a paywalled article, check that the reader has access
      if (articleCheck.rows.length > 0) {
        const articleRow = await pool.query<{
          id: string;
          access_mode: string;
          writer_id: string;
          publication_id: string | null;
        }>(
          `SELECT id, access_mode, writer_id, publication_id
           FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
          [targetEventId],
        );
        const art = articleRow.rows[0];
        if (art && art.access_mode === "paywalled") {
          let hasAccess = false;
          if (currentUserId) {
            const access = await checkArticleAccess(
              currentUserId,
              art.id,
              art.writer_id,
              art.publication_id,
            );
            hasAccess = access.hasAccess;
          }
          if (!hasAccess) {
            return reply.status(200).send({
              comments: [],
              totalCount: 0,
              repliesEnabled,
              commentsEnabled: repliesEnabled,
              paywallLocked: true,
            });
          }
        }
      }

      // Fetch all replies for this target
      const { rows } = await pool.query<{
        id: string;
        nostr_event_id: string;
        parent_comment_id: string | null;
        content: string;
        published_at: Date;
        deleted_at: Date | null;
        author_id: string;
        author_username: string | null;
        author_display_name: string | null;
        author_pip_status: "known" | "partial" | "unknown" | "contested" | null;
      }>(
        `SELECT c.id, c.nostr_event_id, c.parent_comment_id,
                c.content, c.published_at, c.deleted_at,
                c.author_id,
                a.username AS author_username,
                a.display_name AS author_display_name,
                tl.pip_status AS author_pip_status
         FROM comments c
         JOIN accounts a ON a.id = c.author_id
         LEFT JOIN trust_layer1 tl ON tl.user_id = c.author_id
         WHERE c.target_event_id = $1
         ORDER BY c.published_at ASC
         LIMIT $2`,
        [targetEventId, REPLY_TREE_LIMIT],
      );

      // The TOTAL is a fact about `comments`, not about what the cap left — the
      // standing rule this repo keeps arriving at (an empty denominator, a
      // truncated sample, the reading log's `hasMore`): a signal about a source
      // is computed from the source, never from the rows a downstream filter
      // returned. Counted here rather than folded into the page query as a
      // window function, which would count only the window it is computed over
      // and so be the same mistake one level in.
      const { rows: countRows } = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM comments
          WHERE target_event_id = $1 AND deleted_at IS NULL`,
        [targetEventId],
      );
      const totalCount = Number(countRows[0]?.n ?? 0);

      // Authors hidden from this viewer: muted by them, or a block either way
      // (lib/blocks.ts). Still called `isMuted` on the wire — it is the flag
      // the reply renders nothing for, and it means "hidden", not "muted".
      const mutedIds = await loadHiddenAuthorIds(currentUserId ?? null);

      // Build threaded tree (max 2 levels)
      interface ReplyNode {
        id: string;
        nostrEventId: string;
        author: {
          id: string;
          username: string | null;
          displayName: string | null;
          pipStatus: "known" | "partial" | "unknown" | "contested";
        };
        parentCommentId: string | null;
        content: string;
        publishedAt: string;
        isDeleted: boolean;
        isMuted: boolean;
        replies: ReplyNode[];
      }

      const replyMap = new Map<string, ReplyNode>();
      const topLevel: ReplyNode[] = [];

      for (const r of rows) {
        const node: ReplyNode = {
          id: r.id,
          nostrEventId: r.nostr_event_id,
          author: {
            id: r.author_id,
            username: r.author_username,
            displayName: r.author_display_name,
            pipStatus: r.author_pip_status ?? "unknown",
          },
          parentCommentId: r.parent_comment_id,
          content: r.deleted_at ? "[deleted]" : r.content,
          publishedAt: r.published_at.toISOString(),
          isDeleted: !!r.deleted_at,
          isMuted: mutedIds.has(r.author_id),
          replies: [],
        };
        replyMap.set(r.id, node);

        if (!r.parent_comment_id) {
          topLevel.push(node);
        } else {
          const parent = replyMap.get(r.parent_comment_id);
          if (parent) {
            parent.replies.push(node);
          } else {
            topLevel.push(node);
          }
        }
      }

      return reply.status(200).send({
        comments: topLevel,
        totalCount,
        // A capped tree that reads as a whole one is the absence this repo
        // treats as the bug. Say so rather than letting `comments.length <
        // totalCount` be inferred — deleted rows are counted out of the total
        // and in to the page, so the two do not subtract cleanly.
        truncated: rows.length >= REPLY_TREE_LIMIT,
        repliesEnabled,
        commentsEnabled: repliesEnabled, // backwards-compat alias
      });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /replies/:replyId — soft-delete
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { replyId: string } }>(
    "/replies/:replyId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = req.session!.sub;
      const { replyId } = req.params;
      if (!isUuid(replyId)) {
        return reply.status(404).send({ error: "We couldn't find that reply." });
      }

      const { rows } = await pool.query<{
        author_id: string;
        target_event_id: string;
        target_kind: number;
        nostr_event_id: string | null;
        deleted_at: Date | null;
      }>(
        "SELECT author_id, target_event_id, target_kind, nostr_event_id, deleted_at FROM comments WHERE id = $1",
        [replyId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that reply." });
      }

      const replyRow = rows[0];

      // Check permission: reply author OR content author
      let isContentAuthor = false;
      if (replyRow.target_kind === 30023) {
        const check = await pool.query(
          "SELECT 1 FROM articles WHERE nostr_event_id = $1 AND writer_id = $2",
          [replyRow.target_event_id, userId],
        );
        isContentAuthor = check.rows.length > 0;
      } else {
        const check = await pool.query(
          "SELECT 1 FROM notes WHERE nostr_event_id = $1 AND author_id = $2",
          [replyRow.target_event_id, userId],
        );
        isContentAuthor = check.rows.length > 0;
      }

      if (replyRow.author_id !== userId && !isContentAuthor) {
        return reply
          .status(403)
          .send({ error: "You can only delete your own replies, or replies to something you wrote." });
      }

      // THE RELAY IS TOLD TOO (CA-B1, 2026-09-29). A reply IS a relay event:
      // the web signs it as kind 1 and `POST /sign-and-publish` enqueues it
      // before this route indexes it, so a soft delete here alone left the
      // kind-1 on the relay and every mirror for ever — `DELETE /notes` sends
      // a kind-5 and this did not. The tombstone is signed as the REPLY'S
      // AUTHOR whoever pressed delete (the content author may remove a reply
      // under their piece, and a kind-5 from any other pubkey is ignored under
      // NIP-09), signed BEFORE the transaction as the note route does (key-
      // custody down fails cleanly, nothing half-done), and enqueued as
      // `note_deletion` — the event is a kind 1 and `relay_outbox`'s type
      // CHECK has no comment kind, exactly as moderation's removal enqueues
      // it. A reply that never reached the relay (no event id) or is already
      // deleted gets no second tombstone.
      let tombstone: SignedNostrEvent | null = null;
      if (replyRow.nostr_event_id && replyRow.deleted_at === null) {
        tombstone = (await signEvent(replyRow.author_id, {
          kind: 5,
          content: "",
          tags: [["e", replyRow.nostr_event_id]],
          created_at: Math.floor(Date.now() / 1000),
        })) as SignedNostrEvent;
      }

      // THE CARD GOES WITH THE COMMENT, in the same transaction that soft-
      // deletes it. Feed reads filter on `feed_items.deleted_at` and nothing
      // else, so a comment soft-deleted without this stays in every feed it had
      // reached — the §0k.1 shape, one table over. The thread still renders the
      // node as "[deleted]" (that is `comments.deleted_at`, which the projector
      // reads); what this removes is the standalone card.
      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          "UPDATE comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
          [replyId],
        );
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
            WHERE comment_id = $1 AND deleted_at IS NULL`,
          [replyId],
        );
        // Inside the caller's transaction, like every publish (posts.md), and
        // only where THIS call did the deleting — a repeat press sends nothing.
        if (tombstone && (rowCount ?? 0) > 0) {
          await enqueueRelayPublish(client, {
            entityType: "note_deletion",
            entityId: replyId,
            signedEvent: tombstone,
          });
        }
      });

      logger.info({ replyId, userId }, "Reply soft-deleted");
      return reply.status(200).send({ ok: true });
    },
  );
}
