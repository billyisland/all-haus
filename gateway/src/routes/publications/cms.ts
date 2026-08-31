import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePublicationPermission } from "../../middleware/publication-auth.js";
import { signEvent } from "../../lib/key-custody-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import {
  publishToPublication,
  approveAndPublishArticle,
  PublicationPaywallUnsupportedError,
} from "../../services/publication-publisher.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";

// =============================================================================
// Publication CMS — author-facing article management inside a publication
//
// GET    /publications/:id/articles                          — List
// POST   /publications/:id/articles                          — Submit / publish
// PATCH  /publications/:id/articles/:articleId               — Edit metadata
// DELETE /publications/:id/articles/:articleId               — Soft-delete
// POST   /publications/:id/articles/:articleId/publish       — Approve + publish
// POST   /publications/:id/articles/:articleId/unpublish     — Pull article
// =============================================================================

const SubmitArticleSchema = z.object({
  title: z.string().min(1).max(500),
  summary: z.string().max(500).optional(),
  content: z.string().min(1),
  fullContent: z.string().min(1),
  accessMode: z.enum(["public", "paywalled"]).default("public"),
  pricePence: z.number().int().min(0).optional(),
  gatePositionPct: z.number().int().min(1).max(99).optional(),
  showOnWriterProfile: z.boolean().default(true),
  existingDTag: z.string().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
  commentsEnabled: z.boolean().optional(), // "allow replies" toggle (M19/§0f-7)
});

const EditArticleSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(500).nullable().optional(),
  pricePence: z.number().int().min(0).optional(),
  showOnWriterProfile: z.boolean().optional(),
  coverImageUrl: z.string().url().nullable().optional(),
});

export async function publicationCmsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /publications/:id/articles — CMS article list
  // ---------------------------------------------------------------------------

  app.get<{
    Params: { id: string };
    Querystring: { status?: string; limit?: string; offset?: string };
  }>(
    "/publications/:id/articles",
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const { id } = req.params;
      const member = req.publicationMember!;
      const status = (req.query as any).status;
      const limit = Math.min(
        parseInt((req.query as any).limit ?? "50", 10),
        100,
      );
      const offset = parseInt((req.query as any).offset ?? "0", 10);

      let statusFilter = "";
      const values: any[] = [id];

      // Contributors only see their own articles
      const isContributorOnly =
        member.role === "contributor" && !member.can_edit_others;
      if (isContributorOnly) {
        values.push(member.account_id);
      }

      if (status) {
        values.push(status);
        statusFilter = `AND a.publication_article_status = $${values.length}`;
      }

      const writerFilter = isContributorOnly ? `AND a.writer_id = $2` : "";

      const { rows } = await pool.query(
        `SELECT a.id, a.title, a.slug, a.nostr_d_tag AS d_tag, a.access_mode,
                a.price_pence, a.publication_article_status AS status,
                a.published_at, a.created_at, a.show_on_writer_profile,
                acc.username AS author_username, acc.display_name AS author_display_name
         FROM articles a
         JOIN accounts acc ON acc.id = a.writer_id
         WHERE a.publication_id = $1 AND a.deleted_at IS NULL
           ${writerFilter} ${statusFilter}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values,
      );

      return reply.send({ articles: rows });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles — Submit or publish an article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string } }>(
    "/publications/:id/articles",
    { preHandler: [requireAuth, requirePublicationPermission()] },
    async (req, reply) => {
      const parsed = SubmitArticleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const { id } = req.params;
      const member = req.publicationMember!;
      const userId = req.session!.sub;
      const userPubkey = req.session!.pubkey;

      // The publication pipeline has no vault step — a paywalled submission
      // would charge readers for content that was never stored. Refuse with
      // a clear message rather than let the deeper guard 500.
      if (parsed.data.accessMode === "paywalled") {
        return reply.status(400).send({
          error: "publication_paywall_unsupported",
          message: new PublicationPaywallUnsupportedError().message,
        });
      }

      const result = await publishToPublication({
        publicationId: id,
        authorId: userId,
        authorPubkey: userPubkey,
        canPublish: member.can_publish,
        ...parsed.data,
      });

      return reply.status(201).send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /publications/:id/articles/:articleId — Edit article metadata
  // ---------------------------------------------------------------------------

  app.patch<{ Params: { id: string; articleId: string } }>(
    "/publications/:id/articles/:articleId",
    {
      preHandler: [
        requireAuth,
        requirePublicationPermission("can_edit_others"),
      ],
    },
    async (req, reply) => {
      const parsed = EditArticleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send(zodValidationError(parsed.error));
      }

      const { id, articleId } = req.params;
      const data = parsed.data;

      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;

      const fields: Record<string, string> = {
        title: "title",
        summary: "summary",
        pricePence: "price_pence",
        showOnWriterProfile: "show_on_writer_profile",
        coverImageUrl: "cover_image_url",
      };

      for (const [jsKey, dbCol] of Object.entries(fields)) {
        const val = (data as any)[jsKey];
        if (val !== undefined) {
          setClauses.push(`${dbCol} = $${idx}`);
          values.push(val);
          idx++;
        }
      }

      if (setClauses.length === 0) {
        return reply.status(400).send({ error: "No fields to update" });
      }

      values.push(articleId, id);

      await withTransaction(async (client) => {
        const { rowCount } = await client.query(
          `UPDATE articles SET ${setClauses.join(", ")}
           WHERE id = $${idx} AND publication_id = $${idx + 1}`,
          values,
        );
        if (rowCount === 0) {
          throw Object.assign(new Error("not_found"), { statusCode: 404 });
        }

        if (data.title !== undefined) {
          await client.query(
            `UPDATE feed_items SET title = $1 WHERE article_id = $2`,
            [data.title, articleId],
          );
        }

        if (data.coverImageUrl !== undefined) {
          const mediaJson = data.coverImageUrl
            ? JSON.stringify([{ type: "image", url: data.coverImageUrl }])
            : null;
          await client.query(
            `UPDATE feed_items SET media = $1 WHERE article_id = $2`,
            [mediaJson, articleId],
          );
        }
      }).catch((err) => {
        if (err.statusCode === 404) {
          return reply
            .status(404)
            .send({ error: "Article not found in this publication" });
        }
        throw err;
      });

      return reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /publications/:id/articles/:articleId — Soft-delete article
  // ---------------------------------------------------------------------------

  app.delete<{ Params: { id: string; articleId: string } }>(
    "/publications/:id/articles/:articleId",
    {
      preHandler: [
        requireAuth,
        requirePublicationPermission("can_edit_others"),
      ],
    },
    async (req, reply) => {
      const { id, articleId } = req.params;

      const articleResult = await pool.query<{
        nostr_event_id: string;
        nostr_d_tag: string;
        nostr_pubkey: string;
      }>(
        `SELECT nostr_event_id, nostr_d_tag,
           (SELECT nostr_pubkey FROM publications WHERE id = $2) AS nostr_pubkey
         FROM articles
         WHERE id = $1 AND publication_id = $2 AND deleted_at IS NULL`,
        [articleId, id],
      );

      if (articleResult.rows.length === 0) {
        return reply.status(404).send({ error: "Article not found" });
      }
      const article = articleResult.rows[0];

      const deletionEvent = await signEvent(
        id,
        {
          kind: 5,
          content: "",
          tags: [
            ["e", article.nostr_event_id],
            ["a", `30023:${article.nostr_pubkey}:${article.nostr_d_tag}`],
          ],
          created_at: Math.floor(Date.now() / 1000),
        },
        "publication",
      );

      const result = await withTransaction(async (client) => {
        const updateResult = await client.query(
          `UPDATE articles SET deleted_at = now(), publication_article_status = 'unpublished'
           WHERE id = $1 AND publication_id = $2 AND deleted_at IS NULL`,
          [articleId, id],
        );

        if (updateResult.rowCount === 0) return null;

        // Remove from every workspace feed, mirroring unpublish above (the
        // §0f-1/M6 bug class): feed queries filter only on
        // feed_items.deleted_at, so without this the deleted article's card
        // lingers until the daily reconcile's deleted_at repair pass — up to
        // 24h. Unscoped by publication, so it must only run when the
        // publication-scoped UPDATE above matched (same guard as unpublish).
        await client.query(`DELETE FROM feed_items WHERE article_id = $1`, [
          articleId,
        ]);

        await enqueueRelayPublish(client, {
          entityType: "article_deletion",
          entityId: articleId,
          signedEvent: deletionEvent as SignedNostrEvent,
        });

        return { deletionEventId: deletionEvent.id };
      });

      if (!result) {
        return reply.status(404).send({ error: "Article not found" });
      }

      logger.info(
        { articleId, deletionEventId: result.deletionEventId },
        "Publication article soft-deleted and kind-5 enqueued",
      );

      return reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/publish — Approve + publish
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    "/publications/:id/articles/:articleId/publish",
    { preHandler: [requireAuth, requirePublicationPermission("can_publish")] },
    async (req, reply) => {
      const { id, articleId } = req.params;
      const editorId = req.session!.sub;

      try {
        const result = await approveAndPublishArticle(id, articleId, editorId);
        return reply.send(result);
      } catch (err) {
        if (err instanceof PublicationPaywallUnsupportedError) {
          return reply.status(400).send({
            error: "publication_paywall_unsupported",
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /publications/:id/articles/:articleId/unpublish — Pull article
  // ---------------------------------------------------------------------------

  app.post<{ Params: { id: string; articleId: string } }>(
    "/publications/:id/articles/:articleId/unpublish",
    { preHandler: [requireAuth, requirePublicationPermission("can_publish")] },
    async (req, reply) => {
      const { id, articleId } = req.params;

      const found = await withTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE articles SET publication_article_status = 'unpublished', published_at = NULL
           WHERE id = $1 AND publication_id = $2`,
          [articleId, id],
        );
        // The DELETE below must only run when the UPDATE matched: it is
        // unscoped by publication, so running it on a 0-row UPDATE would let a
        // member of any publication strip an arbitrary article's cards sitewide.
        if (updated.rowCount === 0) return false;
        // Remove from every workspace feed (M6). Feed queries filter only on
        // feed_items.deleted_at, never published_at, and the daily reconcile is
        // ON CONFLICT DO NOTHING — so without this the pulled article's card
        // lingers in feeds indefinitely (personal unpublish deletes them too).
        await client.query(`DELETE FROM feed_items WHERE article_id = $1`, [articleId]);
        return true;
      });

      if (!found) {
        return reply.status(404).send({ error: "article_not_found" });
      }

      return reply.send({ ok: true });
    },
  );
}
