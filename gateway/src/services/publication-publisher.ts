import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { signEvent } from "../lib/key-custody-client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { generateDTag } from "@platform-pub/shared/lib/slug.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { publicationsEnabled } from "@platform-pub/shared/lib/env.js";
export { generateDTag };

// =============================================================================
// Publication Publisher — server-side article publishing pipeline
//
// Orchestrates the full flow for publication articles:
//   1. Sign the NIP-23 event with the publication's custodial key
//   2. Index the article + feed_items row AND enqueue the signed event into
//      `relay_outbox` atomically in one transaction; the feed-ingest
//      `relay_publish` worker owns the relay publish with retry.
//
// Contributors without can_publish get their article saved as 'submitted'
// without any Nostr event being created.
// =============================================================================

interface PublishToPublicationInput {
  publicationId: string;
  authorId: string;
  authorPubkey: string;
  title: string;
  summary?: string;
  content: string; // full markdown (free content for paywalled, all content for free)
  fullContent: string; // complete content including paywall body
  accessMode: "public" | "paywalled";
  pricePence?: number;
  gatePositionPct?: number;
  showOnWriterProfile: boolean;
  canPublish: boolean;
  existingDTag?: string;
  coverImageUrl?: string | null;
  commentsEnabled?: boolean; // "allow replies" toggle (M19/§0f-7 — omitting it dropped the editor's choice)
}

interface PublishToPublicationResult {
  articleId: string;
  status: string;
  nostrEventId?: string;
  dTag: string;
}

/**
 * Thrown when a paywalled article is submitted to a publication. The
 * publication pipeline has NO vault step — it never encrypts or stores the
 * paywall body (fullContent is only used for word count), so a "paywalled"
 * publication article would take readers' money against content that does
 * not exist server-side. Publishing paywalled publication articles stays
 * blocked until the pipeline gains the vault call the personal scheduler
 * pipeline already has (scheduler.ts::createVault).
 */
export class PublicationPaywallUnsupportedError extends Error {
  constructor() {
    super(
      "Paywalled articles aren't supported in publications yet — publish on your personal profile, or remove the paywall gate.",
    );
    this.name = "PublicationPaywallUnsupportedError";
  }
}

/**
 * The whole publications system is SUSPENDED by operator directive 2026-08-31;
 * launch is solo author accounts only.
 *
 * Thrown here as well as 404ing at the routes because the SCHEDULER calls this
 * module directly rather than over HTTP, so the route gate does not cover it.
 * Defence in depth, not decoration. Operational detail + restore conditions:
 * shared/src/lib/env.ts. Reinstatement: PUBLICATIONS-SUSPENSION-PLAN.md §8.
 */
export class PublicationsSuspendedError extends Error {
  constructor() {
    super(
      "Publications are unavailable — publish on your personal profile instead.",
    );
    this.name = "PublicationsSuspendedError";
  }
}

export async function publishToPublication(
  input: PublishToPublicationInput,
): Promise<PublishToPublicationResult> {
  // Suspension gate — see PublicationsSuspendedError. Checked ahead of the
  // paywall block so a paywalled publication draft reports the reason that
  // actually applies while the system is dark.
  if (!publicationsEnabled()) {
    throw new PublicationsSuspendedError();
  }

  // Hard block — see PublicationPaywallUnsupportedError. Checked here (not
  // only at the routes) so every caller is covered: CMS submit, the web
  // editor path, and the scheduled-draft worker. Tested via a widened local
  // so TS doesn't narrow input.accessMode to "public" — the downstream
  // paywalled branches stay compilable for when the vault pipeline lands.
  const requestedAccessMode: string = input.accessMode;
  if (requestedAccessMode === "paywalled") {
    throw new PublicationPaywallUnsupportedError();
  }

  const dTag = input.existingDTag ?? generateDTag(input.title);

  // Fetch publication for its nostr pubkey and pricing config
  const { rows: pubs } = await pool.query<{
    nostr_pubkey: string;
    default_article_price_pence: number;
    article_price_mode: string;
  }>(
    "SELECT nostr_pubkey, default_article_price_pence, article_price_mode FROM publications WHERE id = $1",
    [input.publicationId],
  );
  if (pubs.length === 0) throw new Error("Publication not found");
  const pub = pubs[0];

  const wordCount = input.fullContent.split(/\s+/).length;

  function resolveDefaultPrice(): number {
    if (pub.article_price_mode === "per_1000_words") {
      return Math.floor(wordCount / 1000) * pub.default_article_price_pence;
    }
    return pub.default_article_price_pence;
  }

  const pricePence =
    input.pricePence ??
    (input.accessMode === "paywalled" ? resolveDefaultPrice() : null);

  // If the author can't publish, save as submitted (no Nostr event)
  if (!input.canPublish) {
    const slug = dTag;

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO articles (
         writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
         content_free, word_count, tier,
         access_mode, price_pence, gate_position_pct,
         publication_id, publication_article_status, show_on_writer_profile,
         cover_image_url, comments_enabled, published_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'tier1',
         $9, $10, $11, $12, 'submitted', $13, $14, $15, NULL
       )
       RETURNING id`,
      [
        input.authorId,
        `pending-${dTag}`, // placeholder event ID — replaced on publish
        dTag,
        input.title,
        slug,
        input.summary || null,
        input.content,
        wordCount,
        input.accessMode,
        pricePence,
        input.gatePositionPct || null,
        input.publicationId,
        input.showOnWriterProfile,
        input.coverImageUrl ?? null,
        input.commentsEnabled ?? true,
      ],
    );

    // Notify members with can_publish
    await pool.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, article_id)
       SELECT pm.account_id, $1, 'pub_article_submitted', $2
       FROM publication_members pm
       WHERE pm.publication_id = $3 AND pm.can_publish = TRUE
         AND pm.removed_at IS NULL AND pm.account_id != $1
       ON CONFLICT DO NOTHING`,
      [input.authorId, rows[0].id, input.publicationId],
    );

    logger.info(
      {
        publicationId: input.publicationId,
        articleId: rows[0].id,
        author: input.authorId,
      },
      "Article submitted for review",
    );
    return { articleId: rows[0].id, status: "submitted", dTag };
  }

  // Author can publish — full pipeline
  const tags: string[][] = [
    ["d", dTag],
    ["title", input.title],
    ["published_at", String(Math.floor(Date.now() / 1000))],
    ["p", input.authorPubkey, "", "author"],
    ["p", pub.nostr_pubkey, "", "publisher"],
  ];

  if (input.summary) {
    tags.push(["summary", input.summary]);
  }

  if (input.coverImageUrl) {
    tags.push(["image", input.coverImageUrl]);
  }

  if (input.accessMode === "paywalled" && pricePence) {
    tags.push(
      ["price", String(pricePence), "GBP"],
      ["gate", String(input.gatePositionPct ?? 50)],
    );
  }

  const eventTemplate = {
    kind: 30023,
    content: input.content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };

  // Sign with the publication's key (IO to key-custody — stays outside the txn)
  const signed = await signEvent(
    input.publicationId,
    eventTemplate,
    "publication",
  );

  // Index in DB + dual-write feed_items + enqueue relay publish atomically
  const slug = dTag;

  const articleId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (
         writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
         content_free, word_count, tier,
         access_mode, price_pence, gate_position_pct,
         publication_id, publication_article_status, show_on_writer_profile,
         cover_image_url, comments_enabled, published_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'tier1',
         $9, $10, $11, $12, 'published', $13, $14, $15, now()
       )
       ON CONFLICT (writer_id, nostr_d_tag) WHERE deleted_at IS NULL DO UPDATE SET
         nostr_event_id = EXCLUDED.nostr_event_id,
         title = EXCLUDED.title,
         summary = EXCLUDED.summary,
         content_free = EXCLUDED.content_free,
         word_count = EXCLUDED.word_count,
         access_mode = EXCLUDED.access_mode,
         price_pence = EXCLUDED.price_pence,
         gate_position_pct = EXCLUDED.gate_position_pct,
         cover_image_url = EXCLUDED.cover_image_url,
         comments_enabled = EXCLUDED.comments_enabled,
         publication_article_status = 'published',
         published_at = now()
       RETURNING id`,
      [
        input.authorId,
        signed.id,
        dTag,
        input.title,
        slug,
        input.summary || null,
        input.content,
        wordCount,
        input.accessMode,
        pricePence,
        input.gatePositionPct || null,
        input.publicationId,
        input.showOnWriterProfile,
        input.coverImageUrl ?? null,
        input.commentsEnabled ?? true,
      ],
    );

    const artId = rows[0].id;

    // Dual-write: upsert feed_items
    const {
      rows: [author],
    } = await client.query<{
      display_name: string | null;
      avatar_blossom_url: string | null;
      username: string | null;
    }>(
      `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
      [input.authorId],
    );
    const mediaJson = input.coverImageUrl
      ? JSON.stringify([{ type: "image", url: input.coverImageUrl }])
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
        input.authorId,
        author?.display_name ?? author?.username ?? "Unknown",
        author?.avatar_blossom_url ?? null,
        author?.username ?? null,
        input.title,
        truncatePreview(input.content),
        signed.id,
        mediaJson,
      ],
    );

    await enqueueRelayPublish(client, {
      entityType: "article",
      entityId: artId,
      signedEvent: signed as SignedNostrEvent,
    });

    return artId;
  });

  logger.info(
    {
      publicationId: input.publicationId,
      articleId,
      nostrEventId: signed.id,
      author: input.authorId,
    },
    "Publication article published",
  );

  return {
    articleId,
    status: "published",
    nostrEventId: signed.id,
    dTag,
  };
}

// =============================================================================
// Approve and publish a submitted article
// =============================================================================

export async function approveAndPublishArticle(
  publicationId: string,
  articleId: string,
  editorId: string,
): Promise<{ nostrEventId: string }> {
  // Same suspension gate as publishToPublication — approval publishes, so it is
  // a write path and darks with the rest.
  if (!publicationsEnabled()) {
    throw new PublicationsSuspendedError();
  }

  // Fetch the article and publication
  const { rows: articles } = await pool.query<{
    writer_id: string;
    title: string;
    summary: string | null;
    content_free: string;
    access_mode: string;
    price_pence: number | null;
    gate_position_pct: number | null;
    nostr_d_tag: string;
    show_on_writer_profile: boolean;
    cover_image_url: string | null;
  }>(
    `SELECT writer_id, title, summary, content_free, access_mode, price_pence,
            gate_position_pct, nostr_d_tag, show_on_writer_profile, cover_image_url
     FROM articles WHERE id = $1 AND publication_id = $2`,
    [articleId, publicationId],
  );
  if (articles.length === 0) throw new Error("Article not found");
  const article = articles[0];

  // Same block as publishToPublication: a submitted paywalled article has no
  // vault (its paywall body was never stored), so approving it would put a
  // charge-for-nothing article live.
  if (article.access_mode === "paywalled") {
    throw new PublicationPaywallUnsupportedError();
  }

  const { rows: pubs } = await pool.query<{ nostr_pubkey: string }>(
    "SELECT nostr_pubkey FROM publications WHERE id = $1",
    [publicationId],
  );
  const pub = pubs[0];

  const { rows: authors } = await pool.query<{
    nostr_pubkey: string;
    display_name: string | null;
    avatar_blossom_url: string | null;
    username: string | null;
  }>(
    "SELECT nostr_pubkey, display_name, avatar_blossom_url, username FROM accounts WHERE id = $1",
    [article.writer_id],
  );
  const authorAccount = authors[0];
  const authorPubkey = authorAccount.nostr_pubkey;

  // Build and sign event
  const tags: string[][] = [
    ["d", article.nostr_d_tag],
    ["title", article.title],
    ["published_at", String(Math.floor(Date.now() / 1000))],
    ["p", authorPubkey, "", "author"],
    ["p", pub.nostr_pubkey, "", "publisher"],
  ];

  if (article.summary) tags.push(["summary", article.summary]);
  if (article.cover_image_url) tags.push(["image", article.cover_image_url]);
  if (article.access_mode === "paywalled" && article.price_pence) {
    tags.push(
      ["price", String(article.price_pence), "GBP"],
      ["gate", String(article.gate_position_pct ?? 50)],
    );
  }

  const signed = await signEvent(
    publicationId,
    {
      kind: 30023,
      content: article.content_free ?? "",
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    "publication",
  );

  // Update DB + dual-write feed_items + enqueue relay publish atomically
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE articles
       SET nostr_event_id = $1, publication_article_status = 'published', published_at = now()
       WHERE id = $2`,
      [signed.id, articleId],
    );

    // Dual-write: upsert feed_items
    const mediaJson = article.cover_image_url
      ? JSON.stringify([{ type: "image", url: article.cover_image_url }])
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
        media = EXCLUDED.media,
        published_at = EXCLUDED.published_at
    `,
      [
        articleId,
        article.writer_id,
        authorAccount.display_name ?? authorAccount.username ?? "Unknown",
        authorAccount.avatar_blossom_url ?? null,
        authorAccount.username ?? null,
        article.title,
        truncatePreview(article.content_free),
        signed.id,
        mediaJson,
      ],
    );

    // Notify the author
    await client.query(
      `INSERT INTO notifications (recipient_id, actor_id, type, article_id)
       VALUES ($1, $2, 'pub_article_published', $3)
       ON CONFLICT DO NOTHING`,
      [article.writer_id, editorId, articleId],
    );

    await enqueueRelayPublish(client, {
      entityType: "article",
      entityId: articleId,
      signedEvent: signed as SignedNostrEvent,
    });
  });

  logger.info(
    { publicationId, articleId, nostrEventId: signed.id, editor: editorId },
    "Submitted article approved and published",
  );
  return { nostrEventId: signed.id };
}
