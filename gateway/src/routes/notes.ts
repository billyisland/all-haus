import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../middleware/auth.js";
import { signEvent } from "../lib/key-custody-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import {
  enqueueCrossPost,
  enqueueNostrOutbound,
} from "../lib/outbound-enqueue.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Note Routes
//
// POST   /notes                    — Index a published note
// DELETE /notes/:nostrEventId      — Delete a note (author only)
// GET    /content/resolve          — Resolve an event ID to preview metadata
// GET    /feed/global              — Global "For you" feed (all articles + notes + new users)
// =============================================================================

const NOTE_CHAR_LIMIT = 1000;

// The quoted-post snapshot (notes.quoted_excerpt / quoted_title) is a frozen
// DISPLAY copy of what was quoted, rendered straight into the inset — so it is
// bounded here rather than left to whatever a client posts. It CLAMPS, never
// rejects: the web caps it at the same 1000 (web/src/lib/post/quote-preview.ts),
// but the article-highlight path sends a passage the reader dragged out by hand,
// and a 400 there would lose the note they had just written over a preview
// nobody would miss the tail of.
const QUOTED_EXCERPT_LIMIT = 1000;
const QUOTED_TITLE_LIMIT = 500;
const clampTo = (n: number) => (v: string) => (v.length > n ? v.slice(0, n) : v);

const IndexNoteSchema = z.object({
  nostrEventId: z.string().min(1),
  content: z.string().min(1).max(NOTE_CHAR_LIMIT),
  isQuoteComment: z.boolean().optional(),
  quotedEventId: z.string().optional(),
  quotedEventKind: z.number().int().optional(),
  quotedExcerpt: z.string().transform(clampTo(QUOTED_EXCERPT_LIMIT)).optional(),
  quotedTitle: z.string().transform(clampTo(QUOTED_TITLE_LIMIT)).optional(),
  quotedAuthor: z.string().optional(),
  // External quote-note (quoting a Bluesky/Mastodon/etc. post): the quoted thing
  // has no nostr event id, so quotedEventId/Kind stay unset and these carry the
  // reference (deterministic post_id + public URL + origin label). Migration 102.
  quotedPostId: z.string().optional(),
  // Rendered as an <a href> on the quoted mini (QuotedEmbed). React does not
  // strip javascript:/data: URIs from href, so an http(s)-only guard here is the
  // primary defence against a stored-XSS payload POSTed straight to this route.
  quotedUrl: z
    .string()
    .refine((u) => /^https?:\/\//i.test(u), {
      message: "quotedUrl must be an http(s) URL",
    })
    .optional(),
  quotedSource: z.string().optional(),
  // Optional: full signed Nostr event for outbound relay publishing (Phase 2)
  signedEvent: z
    .object({
      id: z.string(),
      pubkey: z.string(),
      created_at: z.number(),
      kind: z.number(),
      tags: z.array(z.array(z.string())),
      content: z.string(),
      sig: z.string(),
    })
    .optional(),
  // Optional: cross-post this note to one or more linked external accounts.
  // 'reply' / 'quote' must carry sourceItemId; 'original' (top-level broadcast)
  // omits it. Each entry produces an outbound_posts row + worker job.
  crossPosts: z
    .array(
      z
        .object({
          linkedAccountId: z.string().uuid(),
          sourceItemId: z.string().uuid().optional(),
          actionType: z.enum(["reply", "quote", "original"]),
        })
        .refine(
          (v) =>
            v.actionType === "original"
              ? v.sourceItemId === undefined
              : v.sourceItemId !== undefined,
          {
            message:
              "sourceItemId required for reply/quote, forbidden for original",
          },
        ),
    )
    .optional(),
});

export async function noteRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /notes — index a published note
  // ---------------------------------------------------------------------------

  app.post("/notes", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = IndexNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const authorId = req.session!.sub;
    const data = parsed.data;

    try {
      const { noteId, duplicate } = await withTransaction(async (client) => {
        const result = await client.query<{ id: string }>(
          `INSERT INTO notes (
             author_id, nostr_event_id, content, char_count, tier, published_at,
             is_quote_comment, quoted_event_id, quoted_event_kind,
             quoted_excerpt, quoted_title, quoted_author,
             quoted_post_id, quoted_url, quoted_source
           ) VALUES ($1, $2, $3, $4, 'tier1', now(), $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (nostr_event_id) DO NOTHING
           RETURNING id`,
          [
            authorId,
            data.nostrEventId,
            data.content,
            data.content.length,
            data.isQuoteComment ?? false,
            data.quotedEventId ?? null,
            data.quotedEventKind ?? null,
            data.quotedExcerpt ?? null,
            data.quotedTitle ?? null,
            data.quotedAuthor ?? null,
            data.quotedPostId ?? null,
            data.quotedUrl ?? null,
            data.quotedSource ?? null,
          ],
        );

        if (result.rows.length === 0) {
          return { noteId: null, duplicate: true };
        }

        const nId = result.rows[0].id;

        // Dual-write: insert feed_items row in same transaction
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
          `
          INSERT INTO feed_items (
            item_type, note_id, author_id,
            author_name, author_avatar, author_username,
            content_preview, nostr_event_id,
            published_at, is_reply
          ) VALUES (
            'note', $1, $2,
            $3, $4, $5,
            $6, $7,
            now(), $8
          )
          ON CONFLICT (note_id) WHERE note_id IS NOT NULL DO UPDATE SET
            content_preview = EXCLUDED.content_preview,
            author_name = EXCLUDED.author_name,
            author_avatar = EXCLUDED.author_avatar,
            author_username = EXCLUDED.author_username
        `,
          [
            nId,
            authorId,
            author?.display_name ?? author?.username ?? "Unknown",
            author?.avatar_blossom_url ?? null,
            author?.username ?? null,
            truncatePreview(data.content),
            data.nostrEventId,
            data.signedEvent?.tags?.some((t: string[]) => t[0] === "e") ??
              false,
          ],
        );

        return { noteId: nId, duplicate: false };
      });

      if (duplicate) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      logger.info(
        { noteId, authorId, nostrEventId: data.nostrEventId },
        "Note indexed",
      );

      // Notify quoted content author (fire-and-forget)
      if (data.isQuoteComment && data.quotedEventId) {
        const quotedNote = await pool.query<{ author_id: string }>(
          `SELECT author_id FROM notes WHERE nostr_event_id = $1`,
          [data.quotedEventId],
        );
        const quotedArticle =
          quotedNote.rows.length === 0
            ? await pool.query<{ author_id: string }>(
                `SELECT writer_id AS author_id FROM articles WHERE nostr_event_id = $1 AND deleted_at IS NULL`,
                [data.quotedEventId],
              )
            : quotedNote;
        const quotedAuthorId = quotedArticle.rows[0]?.author_id;
        if (quotedAuthorId && quotedAuthorId !== authorId) {
          try {
            await pool.query(
              `INSERT INTO notifications (recipient_id, actor_id, type, note_id)
               VALUES ($1, $2, 'new_quote', $3)
               ON CONFLICT DO NOTHING`,
              [quotedAuthorId, authorId, noteId],
            );
          } catch (err) {
            logger.warn({ err }, "Failed to insert new_quote notification");
          }
        }
      }

      // Notify @mentioned users (fire-and-forget, batched)
      const mentionMatches = data.content.matchAll(
        /(?<![a-zA-Z0-9.])@([a-zA-Z0-9_]+)/g,
      );
      const mentionedUsernames = [
        ...new Set([...mentionMatches].map((m) => m[1])),
      ];
      if (mentionedUsernames.length > 0) {
        const { rows: mentionedUsers } = await pool.query<{ id: string }>(
          `SELECT id FROM accounts WHERE username = ANY($1) AND status = 'active' AND id != $2`,
          [mentionedUsernames, authorId],
        );
        if (mentionedUsers.length > 0) {
          const values: string[] = [];
          const params: string[] = [noteId!];
          mentionedUsers.forEach((mentioned, i) => {
            values.push(`($${i * 2 + 2}, $${i * 2 + 3}, 'new_mention', $1)`);
            params.push(mentioned.id, authorId);
          });
          try {
            await pool.query(
              `INSERT INTO notifications (recipient_id, actor_id, type, note_id)
               VALUES ${values.join(", ")}
               ON CONFLICT DO NOTHING`,
              params,
            );
          } catch (err) {
            logger.warn({ err }, "Failed to insert mention notifications");
          }
        }
      }

      // Outbound: if this note references an external Nostr item and the
      // frontend passed the signed event, enqueue an outbound publish job.
      // The worker (feed-ingest/outbound_cross_post) replays the signed event
      // onto the source's relays and writes the result to outbound_posts.
      if (data.signedEvent && data.quotedEventId) {
        try {
          const { rows } = await pool.query<{ id: string }>(
            `SELECT ei.id
             FROM external_items ei
             JOIN external_sources xs ON xs.id = ei.source_id
             WHERE xs.protocol = 'nostr_external'
               AND ei.interaction_data->>'id' = $1
               AND xs.relay_urls IS NOT NULL
               AND array_length(xs.relay_urls, 1) > 0
             LIMIT 1`,
            [data.quotedEventId],
          );
          if (rows.length > 0) {
            await enqueueNostrOutbound({
              accountId: authorId,
              sourceItemId: rows[0].id,
              nostrEventId: data.nostrEventId,
              bodyText: data.content,
              signedEvent: data.signedEvent,
              actionType: "quote",
            });
          }
        } catch (err) {
          logger.warn(
            { err, noteId },
            "Failed to enqueue outbound Nostr publish",
          );
        }
      }

      // Outbound: enqueue cross-post job(s) if requested (Phase 5).
      // Each entry is a separate target; failures are isolated and non-fatal —
      // the native note is already indexed.
      if (data.crossPosts && data.crossPosts.length > 0 && noteId) {
        for (const target of data.crossPosts) {
          try {
            await enqueueCrossPost({
              accountId: authorId,
              linkedAccountId: target.linkedAccountId,
              sourceItemId: target.sourceItemId,
              actionType: target.actionType,
              nostrEventId: data.nostrEventId,
              bodyText: data.content,
            });
          } catch (err) {
            logger.warn(
              { err, noteId, target },
              "Failed to enqueue outbound cross-post",
            );
          }
        }
      }

      return reply.status(201).send({ noteId });
    } catch (err) {
      logger.error({ err, authorId }, "Note indexing failed");
      return reply.status(500).send({ error: "Indexing failed" });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /notes/:nostrEventId — delete a note
  //
  // Only the note's author can delete it. Removes from the platform DB index
  // and publishes a kind 5 deletion event to the relay so the note is filtered
  // from Nostr feeds.
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { nostrEventId: string } }>(
    "/notes/:nostrEventId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const authorId = req.session!.sub;
      const { nostrEventId } = req.params;

      try {
        const { rowCount } = await pool.query(
          `SELECT 1 FROM notes WHERE nostr_event_id = $1 AND author_id = $2`,
          [nostrEventId, authorId],
        );
        if (rowCount === 0) {
          return reply
            .status(404)
            .send({ error: "Note not found or not yours" });
        }

        const deletionEvent = await signEvent(authorId, {
          kind: 5,
          content: "",
          tags: [["e", nostrEventId]],
          created_at: Math.floor(Date.now() / 1000),
        });

        const deleted = await withTransaction(async (client) => {
          const result = await client.query<{ id: string }>(
            `DELETE FROM notes
             WHERE nostr_event_id = $1 AND author_id = $2
             RETURNING id`,
            [nostrEventId, authorId],
          );
          if (result.rowCount === 0) return null;

          await enqueueRelayPublish(client, {
            entityType: "note_deletion",
            entityId: result.rows[0].id,
            signedEvent: deletionEvent as SignedNostrEvent,
          });
          return result.rows[0].id;
        });

        if (!deleted) {
          return reply
            .status(404)
            .send({ error: "Note not found or not yours" });
        }

        logger.info(
          {
            nostrEventId,
            noteId: deleted,
            deletionEventId: deletionEvent.id,
            authorId,
          },
          "Note deleted and kind-5 enqueued",
        );

        return reply
          .status(200)
          .send({ ok: true, deletedNostrEventId: nostrEventId });
      } catch (err) {
        logger.error({ err, nostrEventId, authorId }, "Note deletion failed");
        return reply.status(500).send({ error: "Deletion failed" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /content/resolve?eventId=xxx
  //
  // Resolves a Nostr event ID to preview metadata for quote cards.
  // Checks notes first, then articles. Returns author info + content snippet.
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: { eventId?: string } }>(
    "/content/resolve",
    async (req, reply) => {
      const { eventId } = req.query;
      if (!eventId)
        return reply.status(400).send({ error: "eventId required" });

      try {
        // Check notes table first
        const noteResult = await pool.query(
          `SELECT n.nostr_event_id, n.content, n.published_at,
                  a.username, a.display_name, a.avatar_blossom_url AS avatar
           FROM notes n
           JOIN accounts a ON a.id = n.author_id
           WHERE n.nostr_event_id = $1`,
          [eventId],
        );

        if (noteResult.rows.length > 0) {
          const row = noteResult.rows[0];
          return reply.send({
            type: "note",
            eventId: row.nostr_event_id,
            content: row.content,
            publishedAt: Math.floor(
              new Date(row.published_at).getTime() / 1000,
            ),
            author: {
              username: row.username,
              displayName: row.display_name,
              avatar: row.avatar,
            },
          });
        }

        // Check articles table
        const articleResult = await pool.query(
          `SELECT ar.nostr_event_id, ar.title, ar.nostr_d_tag, ar.summary,
                  ar.content_free, ar.access_mode, ar.published_at,
                  a.username, a.display_name, a.avatar_blossom_url AS avatar
           FROM articles ar
           JOIN accounts a ON a.id = ar.writer_id
           WHERE ar.nostr_event_id = $1 AND ar.deleted_at IS NULL AND ar.published_at IS NOT NULL`,
          [eventId],
        );

        if (articleResult.rows.length > 0) {
          const row = articleResult.rows[0];
          const contentSnippet = row.summary
            ? row.summary.slice(0, 200)
            : (row.content_free ?? "")
                .replace(/^#{1,6}\s+.*/gm, "")
                .replace(/!\[.*?\]\(.*?\)/g, "")
                .replace(/\*\*?(.+?)\*\*?/g, "$1")
                .replace(/\n+/g, " ")
                .trim()
                .slice(0, 200);
          return reply.send({
            type: "article",
            eventId: row.nostr_event_id,
            title: row.title,
            dTag: row.nostr_d_tag,
            accessMode: row.access_mode,
            isPaywalled: row.access_mode === "paywalled",
            content: contentSnippet,
            publishedAt: Math.floor(
              new Date(row.published_at).getTime() / 1000,
            ),
            author: {
              username: row.username,
              displayName: row.display_name,
              avatar: row.avatar,
            },
          });
        }

        return reply.status(404).send({ error: "Event not found" });
      } catch (err) {
        logger.error({ err, eventId }, "Content resolve failed");
        return reply.status(500).send({ error: "Resolve failed" });
      }
    },
  );
}
