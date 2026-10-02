import type { FastifyInstance } from "fastify";
import { verifyEvent } from "nostr-tools";
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
import {
  eventIdIsTaken,
  resolveEventTarget,
} from "../lib/event-target.js";
import { resolveMentionedAccountIds } from "../lib/mentions.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";

// =============================================================================
// Note Routes
//
// POST   /notes                    — Index a published note
// DELETE /notes/:nostrEventId      — Delete a note (author only)
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
  // 'quote' must carry sourceItemId; 'original' (top-level broadcast) omits it.
  // Each entry produces an outbound_posts row + worker job.
  //
  // NOT 'reply' (CROSS-NETWORK-ROUNDTRIP-ADR F1/A1). A reply to an external
  // post is POST /external-items/:id/reply, which writes the note's
  // external_parent_id — the column the projection reads its parent edge
  // from. This route never wrote it, so a reply indexed here was a note with
  // no parent on every surface while its cross-post threaded correctly
  // elsewhere. Nothing sends it; refusing is the whole fix.
  crossPosts: z
    .array(
      z
        .object({
          linkedAccountId: z.string().uuid(),
          sourceItemId: z.string().uuid().optional(),
          actionType: z.enum(["quote", "original"]),
        })
        .refine(
          (v) =>
            v.actionType === "original"
              ? v.sourceItemId === undefined
              : v.sourceItemId !== undefined,
          {
            message: "sourceItemId required for quote, forbidden for original",
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
      return reply.status(400).send(zodValidationError(parsed.error));
    }

    const authorId = req.session!.sub;
    const data = parsed.data;

    try {
      const { noteId, duplicate, squatted } = await withTransaction(async (client) => {
        // STOP THE MINTING (MIRROR-AUDIT §2.7, layer 1). `nostrEventId` is
        // client-supplied and this route has no signer check, so a caller can
        // index a note under an id that already names an ARTICLE or a COMMENT
        // and thereby plant a second row for one id. That is what let a reply or
        // a vote declaring `targetKind: 1` reach a paywalled article's
        // conversation with the guard skipped, and it also pollutes
        // `feed_items.nostr_event_id`, whose root resolution is a `LIMIT 1` with
        // no `ORDER BY` — so whichever row wins decides whether `rootLocked` is
        // stamped. The routes that read an id now resolve it against the row
        // (`lib/event-target.ts`), which closes the bypass; this closes the
        // minting, and both are needed — the resolver cannot un-plant a row that
        // a projector may still pick.
        //
        // IN THE SAME TRANSACTION AS THE INSERT, not before it: checked outside,
        // the check and the insert are two statements a concurrent squat can
        // interleave between. The durable answer is for the server to MINT the
        // id rather than accept one (§0e); this is the refusal until then.
        if (await eventIdIsTaken(client, data.nostrEventId)) {
          return { noteId: null, duplicate: false, squatted: true };
        }

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
          return { noteId: null, duplicate: true, squatted: false };
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

        return { noteId: nId, duplicate: false, squatted: false };
      });

      if (squatted) {
        logger.warn(
          { authorId, nostrEventId: data.nostrEventId },
          "Note refused: event id already names an article or a reply",
        );
        return reply.status(409).send({
          error: "event_id_taken",
          message: "That event id already belongs to other content.",
        });
      }

      if (duplicate) {
        return reply.status(200).send({ ok: true, duplicate: true });
      }

      logger.info(
        { noteId, authorId, nostrEventId: data.nostrEventId },
        "Note indexed",
      );

      // Notify quoted content author (fire-and-forget).
      //
      // THROUGH THE ONE HOME, WHICH IS WHAT MAKES A QUOTED COMMENT COUNT. This
      // read notes, then articles, and never `comments` — so quoting somebody's
      // REPLY notified nobody, silently, while the Quote button sits on every
      // thread card the product draws. It was also the §2.7 search order
      // upside down: `notes` is the one table whose `nostr_event_id` is
      // attacker-chosen, and it was being asked first, so a note planted under
      // an article's event id decided who got told they had been quoted.
      // `resolveEventTarget` answers both — articles, then comments, then the
      // squattable table last — and carries `authorId` for all three.
      //
      // THE LOOKUP IS INSIDE THE TRY, like the mention block below and for the
      // same reason: it sat outside, under the route's own catch, so a failure
      // of this read answered 500 for a note that was already indexed and
      // already published to the relay. "Fire-and-forget" in the comment,
      // load-bearing in the code.
      if (data.isQuoteComment && data.quotedEventId) {
        try {
          const quoted = await resolveEventTarget(pool, data.quotedEventId);
          const quotedAuthorId = quoted?.authorId;
          if (quotedAuthorId && quotedAuthorId !== authorId) {
            await pool.query(
              `INSERT INTO notifications (recipient_id, actor_id, type, note_id)
               VALUES ($1, $2, 'new_quote', $3)
               ON CONFLICT DO NOTHING`,
              [quotedAuthorId, authorId, noteId],
            );
          }
        } catch (err) {
          logger.warn({ err }, "Failed to insert new_quote notification");
        }
      }

      // Notify @mentioned users (fire-and-forget, batched). The scan and the
      // handle walk live in `lib/mentions.ts`, which is where the agreement
      // with USERNAME_RE is kept — this route and `POST /replies` had a copy
      // each and both were wrong about hyphens.
      //
      // The LOOKUP is inside the try as well as the insert. It was outside,
      // under the route's own catch, so a failure of the notification read
      // answered 500 for a note that had already been indexed and published —
      // "fire-and-forget" in the comment and load-bearing in the code.
      try {
        const mentionedIds = await resolveMentionedAccountIds(
          pool,
          data.content,
          authorId,
        );
        if (mentionedIds.length > 0) {
          const values: string[] = [];
          const params: string[] = [noteId!];
          mentionedIds.forEach((id, i) => {
            values.push(`($${i * 2 + 2}, $${i * 2 + 3}, 'new_mention', $1)`);
            params.push(id, authorId);
          });
          await pool.query(
            `INSERT INTO notifications (recipient_id, actor_id, type, note_id)
             VALUES ${values.join(", ")}
             ON CONFLICT DO NOTHING`,
            params,
          );
        }
      } catch (err) {
        logger.warn({ err }, "Failed to insert mention notifications");
      }

      // Outbound: if this note quotes an external Nostr item and the frontend
      // passed the signed event, enqueue an outbound publish job. The worker
      // (feed-ingest/outbound_cross_post) replays the signed event onto the
      // source's relays and writes the result to outbound_posts.
      //
      // The web quotes an external post by its POST ID (it has no native event
      // to name) and q-tags the Nostr event it carries (CA-I13, 2026-09-30) —
      // that is the arm every client quote takes. The `quotedEventId` arm is for
      // a caller that names the hex id directly; a quote of a NATIVE post has
      // no external item to find, so the native tables answer first and the
      // unindexed `interaction_data->>'id'` scan runs only for what is not ours
      // (CA-G6a).
      //
      // WHAT IS REPLAYED MUST BE THE NOTE BEING INDEXED, SIGNED BY ITS AUTHOR.
      // `signedEvent` is client-supplied and the worker publishes it verbatim
      // onto third-party relays, so anything else — another member's event, an
      // event with a different body, a forged signature — is dropped here and
      // the note stays indexed without its cross-post.
      const replayable =
        data.signedEvent &&
        data.signedEvent.id === data.nostrEventId &&
        data.signedEvent.pubkey === req.session!.pubkey &&
        data.signedEvent.kind === 1 &&
        verifyEvent(data.signedEvent);
      if (data.signedEvent && !replayable) {
        logger.warn(
          { noteId, nostrEventId: data.nostrEventId },
          "Signed event does not match the note or its author — not replayed",
        );
      }
      if (replayable && (data.quotedPostId || data.quotedEventId)) {
        try {
          const RELAYED = `xs.protocol = 'nostr_external'
               AND xs.relay_urls IS NOT NULL
               AND array_length(xs.relay_urls, 1) > 0`;
          let rows: { id: string }[] = [];
          if (data.quotedPostId) {
            ({ rows } = await pool.query<{ id: string }>(
              `SELECT ei.id
               FROM feed_items fi
               JOIN external_items ei ON ei.id = fi.external_item_id
               JOIN external_sources xs ON xs.id = ei.source_id
               WHERE fi.post_id = $1 AND ${RELAYED}
               LIMIT 1`,
              [data.quotedPostId],
            ));
          } else if (data.quotedEventId && !(await resolveEventTarget(pool, data.quotedEventId))) {
            ({ rows } = await pool.query<{ id: string }>(
              `SELECT ei.id
               FROM external_items ei
               JOIN external_sources xs ON xs.id = ei.source_id
               WHERE ei.interaction_data->>'id' = $1 AND ${RELAYED}
               LIMIT 1`,
              [data.quotedEventId],
            ));
          }
          if (rows.length > 0) {
            await enqueueNostrOutbound({
              accountId: authorId,
              sourceItemId: rows[0].id,
              nostrEventId: data.nostrEventId,
              bodyText: data.content,
              signedEvent: data.signedEvent!,
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
      return reply.status(500).send({ error: "Couldn't post that. Please try again." });
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
            .send({ error: "We couldn't find that note, or it isn't yours." });
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
            .send({ error: "We couldn't find that note, or it isn't yours." });
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
        return reply.status(500).send({ error: "Couldn't delete that. Please try again." });
      }
    },
  );
}
