import type { FastifyInstance, FastifyRequest } from "fastify";
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
import { nostrTargetTag } from "../../lib/nostr-thread.js";
import { isUuid } from "../../lib/request-inputs.js";

// =============================================================================
// Per-member budgets for the four routes that WRITE to a third-party network
// (MIRROR-AUDIT §3 *Security*, S16).
//
// Every route here posts in the MEMBER'S OWN NAME on somebody else's platform:
// a like, a repost, a poll vote, or a reply that mints a note, a relay-outbox
// row and an outbound job per call. They carried no budget at all, so a runaway
// client — or a hostile one holding a session — could spend a member's Bluesky
// or Mastodon account straight into that platform's own abuse limits, and the
// bill for it lands on the member, not on us.
//
// `hook: 'preHandler'` is load-bearing and is the S15 lesson: @fastify/rate-limit
// defaults to `onRequest`, which runs BEFORE `requireAuth`, so `req.session` is
// undefined, every request falls through to `req.ip` — one nginx, one bucket,
// the whole platform in it — and it reads as working. The plugin appends its
// hook to the route's existing preHandler chain, so at `preHandler` the session
// is there.
//
// WRITE is the tighter budget: a reply is a post, and nobody composes 30 of
// them a minute. Like/repost/poll-vote sit above it because flicking through a
// feed genuinely produces bursts.
const interactionLimit = (max: number) => ({
  rateLimit: {
    max,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => req.session?.sub ?? req.ip,
  },
});

const REACT_LIMIT = interactionLimit(60);
const COMPOSE_LIMIT = interactionLimit(20);

// The member's linked account for an interact-back: theirs (403 otherwise),
// usable (422 while it needs reconnecting) and on the protocol the act needs
// (422, worded by the caller). `null` means go ahead. One home for the four
// routes' copies (CA-H3).
async function linkedAccountRefusal(
  linkedAccountId: string,
  accountId: string,
  protocol: string,
  mismatch: (actual: string) => string,
): Promise<{ status: number; error: string } | null> {
  const { rows } = await pool.query<{
    protocol: string;
    is_valid: boolean;
    lifecycle_state: string;
  }>(
    `SELECT protocol, is_valid, lifecycle_state FROM network_presences
     WHERE id = $1 AND account_id = $2`,
    [linkedAccountId, accountId],
  );
  const la = rows[0];
  if (!la) return { status: 403, error: "We couldn't find that linked account." };
  if (la.lifecycle_state !== "active" || !la.is_valid) {
    return {
      status: 422,
      error: "That account needs reconnecting. You can do that in Settings.",
    };
  }
  if (la.protocol !== protocol) return { status: 422, error: mismatch(la.protocol) };
  return null;
}

export function registerInteractionRoutes(app: FastifyInstance) {
  // =========================================================================
  // POST /external-items/:id/like — like/favourite on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/like",
    { preHandler: requireAuth, config: REACT_LIMIT },
    async (req, reply) => {
      const { id } = req.params;
      if (!isUuid(id)) {
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
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
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "You can't like a post from an RSS feed." });
      }

      const refusal = await linkedAccountRefusal(linkedAccountId, accountId, item.protocol, (p) =>
        `Linked account protocol (${p}) does not match item protocol (${item.protocol})`,
      );
      if (refusal) return reply.status(refusal.status).send({ error: refusal.error });

      // The reference tag for a nostr target — `e` with the HEX event id, or
      // `a` for an addressable kind (S17). Resolved before the try so a uri we
      // cannot reference is a 422 rather than a signed event no client can
      // follow; non-null here is exactly "this item is nostr_external".
      let nostrTag: string[] | null = null;
      if (item.protocol === "nostr_external") {
        nostrTag = nostrTargetTag(item.source_item_uri);
        if (!nostrTag) {
          return reply
            .status(422)
            .send({ error: "We can't point to this post on Nostr, so you can't act on it there." });
        }
      }

      try {
        if (nostrTag) {
          // Sign a kind 7 reaction event and enqueue via Nostr outbound
          const signed = await signEvent(accountId, {
            kind: 7,
            content: "+",
            tags: [nostrTag],
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
        return reply.status(500).send({ error: "Couldn't send your like. Please try again." });
      }

      return reply.status(202).send({ status: "accepted" });
    },
  );

  // =========================================================================
  // POST /external-items/:id/repost — repost/boost on source platform
  // =========================================================================
  app.post<{ Params: { id: string }; Body: { linkedAccountId: string } }>(
    "/external-items/:id/repost",
    { preHandler: requireAuth, config: REACT_LIMIT },
    async (req, reply) => {
      const { id } = req.params;
      if (!isUuid(id)) {
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
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
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
      const item = items[0];

      if (item.protocol === "rss" || item.protocol === "nostr_external") {
        return reply
          .status(422)
          .send({ error: "You can't repost from this network." });
      }

      const refusal = await linkedAccountRefusal(linkedAccountId, accountId, item.protocol, (p) =>
        `Linked account protocol (${p}) does not match item protocol (${item.protocol})`,
      );
      if (refusal) return reply.status(refusal.status).send({ error: refusal.error });

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
        return reply.status(500).send({ error: "Couldn't send your repost. Please try again." });
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
    { preHandler: requireAuth, config: REACT_LIMIT },
    async (req, reply) => {
      const { id } = req.params;
      if (!isUuid(id)) {
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
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
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
      const item = items[0];

      if (item.protocol !== "activitypub") {
        return reply
          .status(422)
          .send({ error: "You can only vote in Mastodon polls from here." });
      }

      const refusal = await linkedAccountRefusal(linkedAccountId, accountId, "activitypub", () =>
        "Linked account must be a Mastodon account",
      );
      if (refusal) return reply.status(refusal.status).send({ error: refusal.error });

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
        return reply.status(500).send({ error: "Couldn't send your vote. Please try again." });
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
    { preHandler: requireAuth, config: COMPOSE_LIMIT },
    async (req, reply) => {
      const { id } = req.params;
      if (!isUuid(id)) {
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
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
        return reply.status(400).send({ error: "Please write something first." });
      }
      if (content.length > NOTE_CHAR_LIMIT) {
        return reply
          .status(400)
          .send({ error: `That's longer than ${NOTE_CHAR_LIMIT} characters. Please shorten it.` });
      }

      // Load item + source relay URLs (needed for nostr_external outbound)
      const { rows: items } = await pool.query<
        ExternalItemRow & {
          relay_urls: string[] | null;
          canonical_url: string | null;
        }
      >(
        `SELECT ei.id, ei.source_id, ei.protocol, ei.source_item_uri,
                ei.source_reply_uri, ei.like_count, ei.reply_count,
                ei.repost_count, ei.interaction_data, ei.canonical_url,
                xs.relay_urls
         FROM external_items ei
         JOIN external_sources xs ON xs.id = ei.source_id
         WHERE ei.id = $1 AND ei.deleted_at IS NULL`,
        [id],
      );
      if (items.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that post." });
      }
      const item = items[0];

      if (item.protocol === "rss") {
        return reply
          .status(422)
          .send({ error: "You can't reply to a post from an RSS feed." });
      }

      const refusal = await linkedAccountRefusal(linkedAccountId, accountId, item.protocol, (p) =>
        `Linked account protocol (${p}) does not match item protocol (${item.protocol})`,
      );
      if (refusal) return reply.status(refusal.status).send({ error: refusal.error });

      const trimmed = content.trim();

      // Build Nostr kind 1 event tags. The root reference is `e` with the HEX
      // event id, or `a` for an addressable kind (S17) — never the stored
      // bech32 uri, which no client can resolve.
      const tags: string[][] = [];
      if (item.protocol === "nostr_external") {
        const rootTag = nostrTargetTag(item.source_item_uri, "root");
        if (!rootTag) {
          return reply
            .status(422)
            .send({ error: "You can't reply to this post on Nostr." });
        }
        tags.push(rootTag);
        const authorPubkey = (item.interaction_data as Record<string, unknown>)
          ?.pubkey;
        if (typeof authorPubkey === "string") {
          tags.push(["p", authorPubkey]);
        }
      } else {
        // THE NOSTR COPY SAYS WHAT IT ANSWERS (CROSS-NETWORK-ROUNDTRIP-ADR
        // F7/A6). A Bluesky/Mastodon parent has no event to e-tag, and this
        // note went to our relay with no tags at all — a context-free
        // top-level note, the F5 shape on our own relay. NIP-73 names an
        // external thing by `i` (+ its `k` kind, `web` for a URL); `r` beside
        // it for clients that read only the older URL reference.
        const parentUrl = externalParentWebUrl(item);
        if (parentUrl) {
          tags.push(["i", parentUrl], ["k", "web"], ["r", parentUrl]);
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
        return reply.status(500).send({ error: "Couldn't sign that. Please try again." });
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
            // `is_reply` TRUE, because this note IS one — it carries
            // `notes.external_parent_id` and exists only as an answer to
            // somebody's Bluesky/Mastodon/nostr post. It was written with the
            // column default (FALSE) until 2026-09-18, which made it the one
            // native reply that could already reach a feed and the one the
            // reader's "no replies" chip could not hide: `exclude_replies` is
            // asked of this column alone. Migration 232 backfills the rows
            // already written.
            `INSERT INTO feed_items (
               item_type, note_id, author_id,
               author_name, author_avatar, author_username,
               content_preview, nostr_event_id,
               published_at, is_reply
             ) VALUES (
               'note', $1, $2,
               $3, $4, $5,
               $6, $7,
               now(), TRUE
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
        return reply.status(500).send({ error: "Couldn't post your reply. Please try again." });
      }

      // Best-effort: enqueue outbound cross-post. The note is indexed and
      // published either way, so a failure here is still a 201 — but it is
      // SAID (A7): `crossPost` tells the composer the reply exists here and did
      // not go to the network it was written for, which it otherwise has no
      // way to learn. The worker's own later failures reach the member as a
      // `cross_post_failed` notification.
      let crossPost: "queued" | "not_sent" = "queued";
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
        crossPost = "not_sent";
        logger.warn(
          { err, noteId, itemId: id, accountId },
          "Reply cross-post enqueue failed (note created successfully)",
        );
      }

      logger.info(
        { noteId, nostrEventId: signed.id, itemId: id, accountId },
        "External reply note created",
      );

      return reply
        .status(201)
        .send({ noteId, nostrEventId: signed.id, crossPost });
    },
  );
}

// The public web address of an atproto/activitypub parent, for the Nostr
// copy's tags (A6). The ingester's canonical_url first — activitypub stores
// the permalink there; atproto declares none, so its at:// identity is
// rewritten to the bsky.app URL (web/src/lib/post/origin-url.ts, the same
// rewrite). An http(s) identity passes through. Anything else is no URL.
export function externalParentWebUrl(item: {
  protocol: string;
  source_item_uri: string;
  canonical_url?: string | null;
}): string | null {
  if (item.canonical_url && /^https?:\/\//.test(item.canonical_url))
    return item.canonical_url;
  const at = item.source_item_uri.match(
    /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/,
  );
  if (at) return `https://bsky.app/profile/${at[1]}/post/${at[2]}`;
  if (/^https?:\/\//.test(item.source_item_uri)) return item.source_item_uri;
  return null;
}
