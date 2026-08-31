import type { FastifyInstance } from "fastify";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  enqueueCrossPost,
  enqueueLike,
  enqueueRepost,
  enqueuePollVote,
  enqueueNostrOutbound,
} from "../../lib/outbound-enqueue.js";
import { signEvent } from "../../lib/key-custody-client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { type ExternalItemRow } from "../../lib/external-items-shared.js";

export function registerInteractionRoutes(app: FastifyInstance) {
  // =========================================================================
  // POST /external-items/:id/like — like/favourite on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/like",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId } = req.body ?? {};
      const accountId = req.session!.sub;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }

      // Load item
      const { rows: items } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "Likes are not supported for RSS items" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
        lifecycle_state: string;
      }>(
        `SELECT protocol, is_valid, lifecycle_state FROM network_presences
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (la[0].lifecycle_state !== "active" || !la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      try {
        if (item.protocol === "nostr_external") {
          // Sign a kind 7 reaction event and enqueue via Nostr outbound
          const signed = await signEvent(accountId, {
            kind: 7,
            content: "+",
            tags: [["e", item.source_item_uri]],
            created_at: Math.floor(Date.now() / 1000),
          });
          await enqueueNostrOutbound({
            accountId,
            sourceItemId: id,
            nostrEventId: signed.id,
            bodyText: "",
            signedEvent: signed,
            actionType: "like",
          });
        } else {
          await enqueueLike({
            accountId,
            linkedAccountId,
            sourceItemId: id,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg, itemId: id, accountId }, "Like enqueue failed");
        return reply.status(500).send({ error: "Failed to enqueue like" });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/repost — repost/boost on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/repost",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId } = req.body ?? {};
      const accountId = req.session!.sub;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }

      // Load item
      const { rows: items } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss" || item.protocol === "nostr_external") {
        return reply
          .status(422)
          .send({ error: "Reposts are not supported for this protocol" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
        lifecycle_state: string;
      }>(
        `SELECT protocol, is_valid, lifecycle_state FROM network_presences
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (la[0].lifecycle_state !== "active" || !la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      try {
        await enqueueRepost({
          accountId,
          linkedAccountId,
          sourceItemId: id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: msg, itemId: id, accountId },
          "Repost enqueue failed",
        );
        return reply.status(500).send({ error: "Failed to enqueue repost" });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/poll-vote — vote on Mastodon poll
  // =========================================================================
  app.post<{
    Params: { id: string };
    Body: { linkedAccountId: string; choices: number[] };
  }>(
    "/external-items/:id/poll-vote",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId, choices } = req.body ?? {};
      const accountId = req.session!.sub;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }
      if (!Array.isArray(choices) || choices.length === 0) {
        return reply.status(400).send({ error: "choices array is required" });
      }

      const { rows: items } = await pool.query<ExternalItemRow>(
        `SELECT id, source_id, protocol, source_item_uri, source_reply_uri,
                like_count, reply_count, repost_count, interaction_data
         FROM external_items WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol !== "activitypub") {
        return reply
          .status(422)
          .send({ error: "Poll voting is only supported for Mastodon items" });
      }

      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
        lifecycle_state: string;
      }>(
        `SELECT protocol, is_valid, lifecycle_state FROM network_presences
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (la[0].lifecycle_state !== "active" || !la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== "activitypub") {
        return reply.status(422).send({
          error: "Linked account must be a Mastodon account",
        });
      }

      try {
        await enqueuePollVote({
          accountId,
          linkedAccountId,
          sourceItemId: id,
          choices,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: msg, itemId: id, accountId },
          "Poll vote enqueue failed",
        );
        return reply.status(500).send({ error: "Failed to enqueue poll vote" });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/reply — reply on source platform + create note
  // =========================================================================
  const NOTE_CHAR_LIMIT = 1000;

  app.post<{
    Params: { id: string };
    Body: { linkedAccountId: string; content: string };
  }>(
    "/external-items/:id/reply",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params;
      const { linkedAccountId, content } = req.body ?? {};
      const accountId = req.session!.sub;

      if (!linkedAccountId) {
        return reply.status(400).send({ error: "linkedAccountId is required" });
      }
      if (
        !content ||
        typeof content !== "string" ||
        content.trim().length === 0
      ) {
        return reply.status(400).send({ error: "content is required" });
      }
      if (content.length > NOTE_CHAR_LIMIT) {
        return reply
          .status(400)
          .send({ error: `content exceeds ${NOTE_CHAR_LIMIT} characters` });
      }

      // Load item + source relay URLs (needed for nostr_external outbound)
      const { rows: items } = await pool.query<
        ExternalItemRow & { relay_urls: string[] | null }
      >(
        `SELECT ei.id, ei.source_id, ei.protocol, ei.source_item_uri,
                ei.source_reply_uri, ei.like_count, ei.reply_count,
                ei.repost_count, ei.interaction_data,
                xs.relay_urls
         FROM external_items ei
         JOIN external_sources xs ON xs.id = ei.source_id
         WHERE ei.id = $1 AND ei.deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "Item not found" });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "Replies are not supported for RSS items" });
      }

      // Validate linked account ownership + protocol match
      const { rows: la } = await pool.query<{
        protocol: string;
        is_valid: boolean;
        lifecycle_state: string;
      }>(
        `SELECT protocol, is_valid, lifecycle_state FROM network_presences
         WHERE id = $1 AND account_id = $2`,
        [linkedAccountId, accountId],
      );
      if (la.length === 0) {
        return reply.status(403).send({ error: "Linked account not found" });
      }
      if (la[0].lifecycle_state !== "active" || !la[0].is_valid) {
        return reply
          .status(422)
          .send({ error: "Linked account is invalid — reconnect in settings" });
      }
      if (la[0].protocol !== item.protocol) {
        return reply.status(422).send({
          error: `Linked account protocol (${la[0].protocol}) does not match item protocol (${item.protocol})`,
        });
      }

      const trimmed = content.trim();

      // Build Nostr kind 1 event tags
      const tags: string[][] = [];
      if (item.protocol === "nostr_external") {
        tags.push(["e", item.source_item_uri, "", "root"]);
        const authorPubkey = (item.interaction_data as Record<string, unknown>)
          ?.pubkey;
        if (typeof authorPubkey === "string") {
          tags.push(["p", authorPubkey]);
        }
      }

      // Sign kind 1 Nostr event via key-custody
      let signed: Awaited<ReturnType<typeof signEvent>>;
      try {
        signed = await signEvent(accountId, {
          kind: 1,
          content: trimmed,
          tags,
          created_at: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        logger.error({ err, accountId }, "Failed to sign reply event");
        return reply.status(500).send({ error: "Failed to sign event" });
      }

      // Create note + feed_items + enqueue relay publish in one transaction
      let noteId: string;
      try {
        const result = await withTransaction(async (client) => {
          // Fetch author metadata for feed_items denormalisation
          const {
            rows: [author],
          } = await client.query<{
            display_name: string | null;
            avatar_blossom_url: string | null;
            username: string | null;
          }>(
            `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
            [accountId],
          );

          const { rows: noteRows } = await client.query<{ id: string }>(
            `INSERT INTO notes (
               author_id, nostr_event_id, content, char_count, tier,
               published_at, external_parent_id
             ) VALUES ($1, $2, $3, $4, 'tier1', now(), $5)
             ON CONFLICT (nostr_event_id) DO NOTHING
             RETURNING id`,
            [accountId, signed.id, trimmed, trimmed.length, id],
          );

          if (noteRows.length === 0) {
            return { noteId: null, duplicate: true };
          }

          const nId = noteRows[0].id;

          await client.query(
            `INSERT INTO feed_items (
               item_type, note_id, author_id,
               author_name, author_avatar, author_username,
               content_preview, nostr_event_id,
               published_at
             ) VALUES (
               'note', $1, $2,
               $3, $4, $5,
               $6, $7,
               now()
             )
             ON CONFLICT (note_id) WHERE note_id IS NOT NULL DO UPDATE SET
               content_preview = EXCLUDED.content_preview,
               author_name = EXCLUDED.author_name,
               author_avatar = EXCLUDED.author_avatar,
               author_username = EXCLUDED.author_username`,
            [
              nId,
              accountId,
              author?.display_name ?? author?.username ?? "Unknown",
              author?.avatar_blossom_url ?? null,
              author?.username ?? null,
              truncatePreview(trimmed),
              signed.id,
            ],
          );

          await enqueueRelayPublish(client, {
            entityType: "note",
            entityId: nId,
            signedEvent: signed as SignedNostrEvent,
          });

          return { noteId: nId, duplicate: false };
        });

        if (result.duplicate || !result.noteId) {
          return reply.status(200).send({ ok: true, duplicate: true });
        }
        noteId = result.noteId;
      } catch (err) {
        logger.error({ err, accountId }, "Reply note creation failed");
        return reply.status(500).send({ error: "Failed to create reply note" });
      }

      // Best-effort: enqueue outbound cross-post
      try {
        if (item.protocol === "nostr_external") {
          await enqueueNostrOutbound({
            accountId,
            sourceItemId: id,
            nostrEventId: signed.id,
            bodyText: trimmed,
            signedEvent: signed,
            actionType: "reply",
          });
        } else {
          await enqueueCrossPost({
            accountId,
            linkedAccountId,
            sourceItemId: id,
            actionType: "reply",
            nostrEventId: signed.id,
            bodyText: trimmed,
          });
        }
      } catch (err) {
        logger.warn(
          { err, noteId, itemId: id, accountId },
          "Reply cross-post enqueue failed (note created successfully)",
        );
      }

      logger.info(
        { noteId, nostrEventId: signed.id, itemId: id, accountId },
        "External reply note created",
      );

      return reply.status(201).send({ noteId, nostrEventId: signed.id });
    },
  );
}
