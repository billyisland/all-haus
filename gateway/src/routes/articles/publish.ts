import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { requireAuth, optionalAuth } from "../../middleware/auth.js";
import { requireWriter } from "../../lib/writer-gate.js";
import { publicationsEnabled, internalSecret } from "@platform-pub/shared/lib/env.js";
import { matchDriveForPublish, queueDriveFulfilment } from "../drives.js";
import { sendPublishNotifications } from "@platform-pub/shared/lib/publish-emails.js";
import { slugify } from "@platform-pub/shared/lib/slug.js";
import { zodValidationError } from "@platform-pub/shared/lib/validation.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { KEY_SERVICE_URL } from "./shared.js";
import { keyServiceHeaders } from "../../lib/key-service-client.js";
import { rekeyArticleEvent } from "../../lib/article-event-rekey.js";
import {
  writerTermsOutstanding,
  WRITER_TERMS_REQUIRED,
} from "../../lib/terms-gate.js";

// =============================================================================
// Article publishing + public reads
//
// POST /articles                            — Index a published article in the DB
// GET  /articles/:dTag                      — Fetch article metadata by d-tag
// GET  /articles/by-event/:nostrEventId     — Fetch article by Nostr event ID
// =============================================================================

/** Thrown inside the index transaction when the d-tag is live under another
 *  writer (CA-B4); the route answers 409 and nothing was written. */
class DTagTakenError extends Error {
  constructor() {
    super("d-tag already live under another writer");
    this.name = "DTagTakenError";
  }
}

const IndexArticleSchema = z
  .object({
    nostrEventId: z.string().min(1),
    dTag: z.string().min(1),
    title: z.string().min(1),
    summary: z.string().optional(),
    content: z.string(), // free section content
    accessMode: z
      .enum(["public", "paywalled", "invitation_only"])
      .default("public"),
    pricePence: z.number().int().min(0).max(999999),
    gatePositionPct: z.number().int().min(0).max(99),
    vaultEventId: z.string().optional(),
    coverImageUrl: z.string().url().nullable().optional(),
    // draftId links the article to its working draft for pledge-drive
    // fulfilment. The paywalled pipeline sends it ONLY on the final (v2)
    // index call — a drive matched at the v1 step would charge pledgers
    // before the vault seals, and a vault failure would leave them charged
    // for a never-published article.
    draftId: z.string().optional(),
    commentsEnabled: z.boolean().optional(), // writer's "allow replies" toggle (default true)
    sendEmail: z.boolean().optional(), // writer opt-in/out for publish notification email
    // Set by the paywalled pipeline's final (v2) index call when the step-2
    // v1 index reported isNew: the v2 upsert is never isNew itself, but the
    // article IS new and subscribers should hear about it — only now, after
    // the vault sealed and v2 is live (a step-2 email would link a soft-
    // deleted 404 if the vault failed).
    emailAsNew: z.boolean().optional(),
  })
  // Keep the paywall rules in lockstep with the key-service PublishVaultSchema
  // (price positive, gate 1..99). The old min(0) here let a price-0 paywalled
  // article index cleanly and then fail vault encryption with a 400 — leaving
  // a live paywalled article with no vault key.
  .superRefine((data, ctx) => {
    if (data.accessMode !== "paywalled") return;
    if (data.pricePence < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pricePence"],
        message: "A paywalled article needs a price of at least 1 pence",
      });
    }
    if (data.gatePositionPct < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gatePositionPct"],
        message: "A paywalled article needs a gate position between 1 and 99",
      });
    }
  });

export async function articlePublishRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /articles — index a published article in the platform database
  //
  // Called by the publishing pipeline after the NIP-23 event is on the relay.
  // Creates the app-layer index row used for feed assembly, search, billing.
  // ---------------------------------------------------------------------------

  // `requireWriter` BEFORE the Writer Agreement question below, and for every
  // piece rather than the paywalled ones: asking a reader to accept the
  // agreement for an act they cannot perform is a button that cannot do its
  // job (READER-WRITER-SPLIT-ADR §2). The web's first writer call is the
  // kind-30023 signature (`routes/signing.ts`), which asks the same question.
  app.post("/articles", { preHandler: [requireAuth, requireWriter] }, async (req, reply) => {
    const parsed = IndexArticleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error));
    }

    const writerId = req.session!.sub;
    const data = parsed.data;

    // THE WRITER AGREEMENT IS WHAT PAID ACCESS IS SOLD UNDER (A3), so the
    // first paywalled publish is where it is accepted — before Connect
    // onboarding, because the code sells access long before a payout exists.
    //
    // Refused here rather than in the three publish-side validators beside it:
    // those three are in lockstep about PRICE AND GATE POSITION, and neither
    // the editor nor the key service can know what version an account has
    // accepted. A free publish is untouched — it is not a sale.
    //
    // Paired with the throw in `publishPersonalArticle`, which covers the
    // scheduler's path; this route is only the web's.
    if (data.accessMode === "paywalled" && (await writerTermsOutstanding(writerId))) {
      return reply.status(403).send({
        error: WRITER_TERMS_REQUIRED,
        message:
          "Before publishing paid access, please accept the all.haus Writer Agreement.",
      });
    }

    const slug = slugify(data.title, 120);

    // Count words
    const wordCount = data.content.split(/\s+/).filter(Boolean).length;

    try {
      const isGated = data.accessMode === "paywalled";

      const { articleId, isNew, driveId, rekeyed } = await withTransaction(async (client) => {
        // THE OLD EVENT ID, READ BEFORE THE UPSERT OVERWRITES IT (§2.8).
        // A NIP-23 edit signs a NEW event, and this upsert writes its id over
        // the old one — orphaning every comment, vote, tally, engagement row and
        // report that points at the piece. `xmax = 0` below only says AFTERWARDS
        // whether a row existed, which is too late to have kept the value, so
        // the read has to happen here. `FOR UPDATE` because the re-key and the
        // rewrite must be one indivisible move: a concurrent publish of the same
        // d-tag would otherwise interleave and re-key onto the loser's id.
        const priorRow = await client.query<{ nostr_event_id: string }>(
          `SELECT nostr_event_id FROM articles
            WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [writerId, data.dTag],
        );
        const priorEventId = priorRow.rows[0]?.nostr_event_id ?? null;

        // A D-TAG LIVE UNDER ANOTHER WRITER IS REFUSED (CA-B4). The unique
        // index is per writer, and GET /articles/:dTag addresses by d-tag
        // alone, so a chosen collision would put one writer's piece at
        // another's address. The d-tag is client-minted (slug + base36 time),
        // so an honest collision is improbable and a chosen one is the case.
        // Thrown inside the transaction so nothing below it is written.
        if (!priorEventId) {
          const { rows: held } = await client.query(
            `SELECT 1 FROM articles
              WHERE nostr_d_tag = $1 AND writer_id <> $2 AND deleted_at IS NULL
              LIMIT 1`,
            [data.dTag, writerId],
          );
          if (held.length > 0) throw new DTagTakenError();
        }

        const result = await client.query<{ id: string; is_new: boolean }>(
          `INSERT INTO articles (
             writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
             content_free, word_count, tier,
             access_mode, price_pence, gate_position_pct, vault_event_id,
             cover_image_url, comments_enabled, published_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tier1', $9, $10, $11, $12, $13, $14, now())
           ON CONFLICT (writer_id, nostr_d_tag) WHERE deleted_at IS NULL DO UPDATE SET
             nostr_event_id = EXCLUDED.nostr_event_id,
             title = EXCLUDED.title,
             slug = EXCLUDED.slug,
             summary = EXCLUDED.summary,
             content_free = EXCLUDED.content_free,
             word_count = EXCLUDED.word_count,
             access_mode = EXCLUDED.access_mode,
             price_pence = EXCLUDED.price_pence,
             gate_position_pct = EXCLUDED.gate_position_pct,
             vault_event_id = EXCLUDED.vault_event_id,
             cover_image_url = EXCLUDED.cover_image_url,
             comments_enabled = EXCLUDED.comments_enabled,
             updated_at = now()
           RETURNING id, (xmax = 0) AS is_new`,
          [
            writerId,
            data.nostrEventId,
            data.dTag,
            data.title,
            slug,
            data.summary ?? null,
            data.content,
            wordCount,
            data.accessMode,
            isGated ? data.pricePence : null,
            isGated ? data.gatePositionPct : null,
            data.vaultEventId ?? null,
            data.coverImageUrl ?? null,
            data.commentsEnabled ?? true,
          ],
        );

        const artId = result.rows[0].id;

        // Carry the conversation across the edit. Guarded on the PRIOR row
        // rather than on `is_new`: nothing to move when there was no row, and a
        // stray match on an empty old id would capture another article's
        // conversation.
        const rekeyed = priorEventId
          ? await rekeyArticleEvent(client, priorEventId, data.nostrEventId)
          : {};

        // Dual-write: upsert feed_items row in same transaction
        const {
          rows: [author],
        } = await client.query<{
          display_name: string | null;
          avatar_blossom_url: string | null;
          username: string | null;
        }>(
          `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
          [writerId],
        );
        const mediaJson = data.coverImageUrl
          ? JSON.stringify([{ type: "image", url: data.coverImageUrl }])
          : null;
        await client.query(
          `
          INSERT INTO feed_items (
            item_type, article_id, author_id,
            author_name, author_avatar, author_username,
            title, content_preview, nostr_event_id,
            media, published_at, is_reply
          ) VALUES (
            'article', $1, $2,
            $3, $4, $5,
            $6, $7, $8,
            $9, now(), FALSE
          )
          ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO UPDATE SET
            title = EXCLUDED.title,
            content_preview = EXCLUDED.content_preview,
            nostr_event_id = EXCLUDED.nostr_event_id,
            author_name = EXCLUDED.author_name,
            author_avatar = EXCLUDED.author_avatar,
            media = EXCLUDED.media
        `,
          [
            artId,
            writerId,
            author?.display_name ?? author?.username ?? "Unknown",
            author?.avatar_blossom_url ?? null,
            author?.username ?? null,
            data.title,
            truncatePreview(data.content),
            data.nostrEventId,
            mediaJson,
          ],
        );

        // Pledge-drive match/stamp INSIDE the index txn: if it fails, the
        // whole index rolls back and the client keeps the draft (retry
        // re-matches). Committing the index with the match silently failed
        // is the orphaned-drive bug — the client deletes the draft right
        // after this response, which SET NULLs pledge_drives.draft_id, the
        // sole match key. Pledge charging stays async (queued post-commit).
        const matchedDriveId = await matchDriveForPublish(
          client,
          writerId,
          artId,
          data.draftId ?? null,
        );

        return { articleId: artId, isNew: result.rows[0].is_new, driveId: matchedDriveId, rekeyed };
      });

      logger.info(
        // `rekeyed` is what an edit carried across with it — empty on a first
        // publish and on an edit of a piece nobody has engaged with. Logged
        // because it is otherwise invisible: the failure it replaces was a
        // conversation quietly ceasing to exist.
        { articleId, writerId, nostrEventId: data.nostrEventId, isNew, rekeyed },
        "Article indexed",
      );

      queueDriveFulfilment(driveId);

      // Notify subscribers via email on first publish (not on edits).
      // emailAsNew: the paywalled pipeline defers the new-article email to
      // its final v2 index call (see the schema comment).
      if ((isNew || data.emailAsNew === true) && data.sendEmail !== false) {
        sendPublishNotifications(
          writerId,
          articleId,
          data.title,
          data.dTag,
          data.summary,
          data.content,
        ).catch((err) => {
          logger.error(
            { err, articleId, writerId },
            "Publish notification emails failed",
          );
        });
      }

      return reply.status(201).send({ articleId, isNew });
    } catch (err) {
      if (err instanceof DTagTakenError) {
        logger.warn({ writerId, dTag: data.dTag }, "Article refused: d-tag live under another writer");
        return reply.status(409).send({
          error: "d_tag_taken",
          message: "That address already belongs to another writer's piece.",
        });
      }
      logger.error({ err, writerId }, "Article indexing failed");
      return reply.status(500).send({ error: "Couldn't publish that. Please try again." });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /articles/:dTag — fetch article metadata by d-tag
  //
  // Public endpoint for the article reader page. Returns metadata from the
  // DB index; the full content comes from the relay (NIP-23 event).
  // ---------------------------------------------------------------------------

  app.get<{ Params: { dTag: string } }>(
    "/articles/:dTag",
    { preHandler: optionalAuth },
    async (req, reply) => {
      const { dTag } = req.params;

      const { rows } = await pool.query<{
        id: string;
        post_id: string;
        writer_id: string;
        nostr_event_id: string;
        nostr_d_tag: string;
        title: string;
        slug: string;
        summary: string | null;
        content_free: string | null;
        word_count: number | null;
        access_mode: string;
        price_pence: number | null;
        gate_position_pct: number | null;
        vault_event_id: string | null;
        cover_image_url: string | null;
        published_at: Date | null;
        writer_username: string;
        writer_display_name: string | null;
        writer_avatar: string | null;
        writer_pubkey: string;
        writer_subscription_price_pence: number;
        publication_id: string | null;
        publication_slug: string | null;
        publication_name: string | null;
        publication_status: string | null;
        publication_subscription_price_pence: number | null;
        deleted_at: Date | null;
      }>(
        `SELECT a.id, article_post_id(a.id) AS post_id, a.deleted_at,
                a.writer_id, a.nostr_event_id, a.nostr_d_tag,
                a.title, a.slug, a.summary, a.content_free, a.word_count,
                a.access_mode, a.price_pence, a.gate_position_pct,
                a.vault_event_id, a.cover_image_url, a.published_at,
                w.username AS writer_username,
                w.display_name AS writer_display_name,
                w.avatar_blossom_url AS writer_avatar,
                w.nostr_pubkey AS writer_pubkey,
                w.subscription_price_pence AS writer_subscription_price_pence,
                a.publication_id,
                p.slug AS publication_slug,
                p.name AS publication_name,
                p.status AS publication_status,
                p.subscription_price_pence AS publication_subscription_price_pence
         FROM articles a
         JOIN accounts w ON w.id = a.writer_id
         LEFT JOIN publications p ON p.id = a.publication_id
         WHERE a.nostr_d_tag = $1 AND a.published_at IS NOT NULL
         -- THE LIVE ROW FIRST (CA-B4, 2026-09-29). idx_articles_unique_live is
         -- partial on deleted_at IS NULL, so a withdrawn row and its live
         -- re-publish coexist under one d-tag, and an unordered rows[0] served
         -- whichever the planner found -- a public 404 for a live piece. The
         -- withdrawn arm below stays: it is reached only when no live row exists.
         ORDER BY (a.deleted_at IS NULL) DESC, a.published_at DESC
         LIMIT 1`,
        [dTag],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that article." });
      }

      const r = rows[0];

      // A WITHDRAWN PIECE IS STILL THE READER'S WHO PAID FOR IT (Writer 3.4,
      // Writer 13.3; §0z item 18). Withdrawal — the writer's delete, their
      // closure, or a moderation rung — sets `deleted_at`, and this route
      // answered 404 to everyone, so the promise that readers keep what they
      // paid for was made by the text and kept by nothing. It is 404 to the
      // world (the page's server fetch is anonymous and cached across
      // viewers, so this is the answer the public and the crawlers get) and
      // the piece to a session that holds an `article_unlocks` row — the one
      // record that says this reader bought THIS piece; a live subscription is
      // access to what is on sale, and a withdrawn piece is not.
      if (r.deleted_at !== null) {
        const viewer = req.session?.sub;
        const unlocked = viewer
          ? await pool.query(
              `SELECT 1 FROM article_unlocks WHERE reader_id = $1 AND article_id = $2`,
              [viewer, r.id],
            )
          : { rows: [] };
        if (unlocked.rows.length === 0) {
          return reply.status(404).send({ error: "We couldn't find that article." });
        }
      }

      // If authenticated reader viewing a paywalled article, include their
      // monthly spend on this writer (for the gate's "a subscription is £X/mo"
      // note). The spend→subscription CONVERSION this once fed, and the
      // one-shot nudge log with it, were deleted 2026-09-29 (CA-I6): the route
      // was a documented money pump kept dark behind a do-not-flip flag, and
      // the gate's copy promised a conversion nothing performed.
      let writerSpendThisMonthPence: number | null = null;
      const readerId = req.session?.sub;
      if (
        readerId &&
        r.access_mode === "paywalled" &&
        readerId !== r.writer_id
      ) {
        // What the reader has actually PAID this writer this month. The gift
        // rule: a free-allowance penny is charged to nobody, so it is not spend
        // and must not inflate the "you would save by subscribing" nudge.
        const spendResult = await pool.query<{ total: string }>(
          `SELECT COALESCE(SUM(chargeable_pence), 0) AS total
           FROM read_events
           WHERE reader_id = $1 AND writer_id = $2
             AND read_at >= date_trunc('month', now())`,
          [readerId, r.writer_id],
        );
        writerSpendThisMonthPence = parseInt(spendResult.rows[0].total, 10);
      }

      return reply.status(200).send({
        id: r.id,
        // THE UNIFIED KEY, AND THIS IS ITS ONE RESOLUTION SITE for native
        // pieces (READING-LOG-AND-LIBRARY-ADR D8). The reader needs it to name
        // this piece to /reading-log and /reading-positions, and the external
        // readers already hold one — supplying it here is what lets all of
        // those routes take a single key rather than two shapes.
        //
        // `article_post_id()` READS feed_items.post_id where a row exists and
        // derives only where one does not. Never re-derive the naddr coord
        // inline: post_id is minted once and its native branch falls back to
        // ('nostr_article', article_id), so a re-derivation mints an id
        // matching no row in exactly those cases — and the symptom is a log
        // row that renders as nothing, which is indistinguishable from the
        // deleted piece the reader is meant to see nothing for.
        postId: r.post_id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        contentFree: r.content_free,
        wordCount: r.word_count,
        accessMode: r.access_mode,
        isPaywalled: r.access_mode === "paywalled",
        pricePence: r.price_pence,
        gatePositionPct: r.gate_position_pct,
        vaultEventId: r.vault_event_id,
        coverImageUrl: r.cover_image_url,
        publishedAt: r.published_at?.toISOString() ?? null,
        writerSpendThisMonthPence,
        // True only on the unlocked-reader answer above; the reader says why
        // the piece looks the way it does.
        withdrawn: r.deleted_at !== null,
        writer: {
          id: r.writer_id,
          username: r.writer_username,
          displayName: r.writer_display_name,
          avatar: r.writer_avatar,
          pubkey: r.writer_pubkey,
          subscriptionPricePence: r.writer_subscription_price_pence,
        },
        // The embed is the ONLY thing the reader surfaces (ReaderOverlay's bar,
        // the /article page masthead) know about the publication, so it is
        // gated HERE, once: absent while the publications system is suspended
        // (every /pub route 404s) and absent for a non-active publication
        // (its /pub surface 404s too) — a renderer holding the embed may link
        // it without a second check. Both consumers fall back to the writer's
        // own identity when it is null.
        publication:
          publicationsEnabled() &&
          r.publication_id &&
          r.publication_status === "active"
            ? {
                id: r.publication_id,
                slug: r.publication_slug,
                name: r.publication_name,
                subscriptionPricePence: r.publication_subscription_price_pence,
              }
            : null,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /articles/by-event/:nostrEventId — fetch article by Nostr event ID
  //
  // Used by the editor to load an article for editing when only the event ID
  // is known. This is the EDITOR's loader — it is requireAuth, it returns the
  // writer's own paywall content, and it does NOT carry `postId`: nothing here
  // reads or resumes, so there is no piece to name. (It once claimed "the same
  // shape as GET /articles/:dTag"; the shapes have never quite matched and now
  // differ by a field that matters.)
  // When the requester is the article's author and it's paywalled, also fetches
  // and includes the decrypted paywall content so the full article can be edited.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { nostrEventId: string } }>(
    "/articles/by-event/:nostrEventId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { nostrEventId } = req.params;
      const userId = req.session!.sub;

      const { rows } = await pool.query(
        `SELECT a.id, a.writer_id, a.nostr_event_id, a.nostr_d_tag,
                a.title, a.slug, a.summary, a.content_free, a.word_count,
                a.access_mode, a.price_pence, a.gate_position_pct,
                a.vault_event_id, a.cover_image_url, a.comments_enabled, a.published_at
         FROM articles a
         WHERE a.nostr_event_id = $1 AND a.deleted_at IS NULL
           AND (a.published_at IS NOT NULL OR a.writer_id = $2)`,
        [nostrEventId, userId],
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: "We couldn't find that article." });
      }

      const r = rows[0];
      let contentPaywall: string | null = null;

      if (r.writer_id === userId && r.access_mode === "paywalled") {
        try {
          const ksPath = `/api/v1/articles/${r.id}/paywall-content`;
          const res = await fetch(`${KEY_SERVICE_URL}${ksPath}`, {
            headers: keyServiceHeaders({
              method: "GET",
              path: ksPath,
              identity: { writerId: userId },
            }),
            signal: AbortSignal.timeout(15_000),
          });
          if (res.ok) {
            const body = (await res.json()) as { content?: string };
            contentPaywall = body.content ?? null;
          }
        } catch {
          // Non-fatal — editor will just load without paywall content
        }
      }

      return reply.status(200).send({
        id: r.id,
        nostrEventId: r.nostr_event_id,
        dTag: r.nostr_d_tag,
        title: r.title,
        slug: r.slug,
        summary: r.summary,
        contentFree: r.content_free,
        contentPaywall,
        wordCount: r.word_count,
        accessMode: r.access_mode,
        isPaywalled: r.access_mode === "paywalled",
        pricePence: r.price_pence,
        gatePositionPct: r.gate_position_pct,
        coverImageUrl: r.cover_image_url,
        commentsEnabled: r.comments_enabled,
        publishedAt: r.published_at?.toISOString() ?? null,
      });
    },
  );
}
