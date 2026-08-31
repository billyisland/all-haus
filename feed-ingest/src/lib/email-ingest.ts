import type { PoolClient } from "pg";
import type { NormalisedEmailItem } from "../adapters/email.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";

// =============================================================================
// Email dual-write — external_items + feed_items with cross-source dedup.
// Mirrors the activitypub-ingest pattern. Two dedup layers catch
// newsletter-to-RSS overlap before insertion.
// =============================================================================

interface EmailIngestSource {
  id: string;
  source_uri: string;
  display_name: string | null;
  avatar_url: string | null;
}

export async function insertEmailItem(
  client: PoolClient,
  source: EmailIngestSource,
  item: NormalisedEmailItem,
): Promise<boolean> {
  // ── Dedup layer 1: canonical URL match across the user's sources ───
  if (item.canonicalUrl) {
    const { rowCount: canonicalMatch } = await client.query(
      `
      SELECT 1 FROM external_items ei
      JOIN external_subscriptions es ON es.source_id = ei.source_id
      WHERE ei.canonical_url = $1
        AND es.subscriber_id IN (
          SELECT subscriber_id FROM external_subscriptions WHERE source_id = $2
        )
      LIMIT 1
      `,
      [item.canonicalUrl, source.id],
    );
    if (canonicalMatch && canonicalMatch > 0) return false;
  }

  // ── Dedup layer 2: title + date fuzzy match ────────────────────────
  if (!item.canonicalUrl && item.title) {
    const { rowCount: fuzzyMatch } = await client.query(
      `
      SELECT 1 FROM external_items ei
      JOIN external_subscriptions es ON es.source_id = ei.source_id
      WHERE ei.title = $1
        AND ei.published_at BETWEEN $2 - interval '1 hour' AND $2 + interval '1 hour'
        AND es.subscriber_id IN (
          SELECT subscriber_id FROM external_subscriptions WHERE source_id = $3
        )
      LIMIT 1
      `,
      [item.title, item.publishedAt, source.id],
    );
    if (fuzzyMatch && fuzzyMatch > 0) return false;
  }

  // ── Insert external_items ──────────────────────────────────────────
  const { rows, rowCount } = await client.query<{ id: string }>(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri, title,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html,
      media, canonical_url,
      source_reply_uri, source_quote_uri, is_repost,
      published_at
    ) VALUES (
      $1, 'email', 'tier4',
      $2, $3,
      $4, $5, NULL, NULL,
      $6, $7,
      $8, $9,
      NULL, NULL, FALSE,
      $10
    )
    ON CONFLICT (protocol, source_item_uri) DO NOTHING
    RETURNING id
    `,
    [
      source.id,
      item.sourceItemUri,
      item.title,
      item.authorName || source.display_name || null,
      item.authorHandle,
      item.contentText,
      item.contentHtml,
      JSON.stringify(item.media),
      item.canonicalUrl,
      item.publishedAt,
    ],
  );

  if (!rowCount || rowCount === 0) return false;

  // ── Insert feed_items ──────────────────────────────────────────────
  await client.query(
    `
    INSERT INTO feed_items (
      item_type, external_item_id,
      author_name, author_avatar,
      title, content_preview,
      published_at,
      source_protocol, source_item_uri, source_id, media,
      is_reply
    ) VALUES (
      'external', $1,
      $2, $3,
      $4, $5,
      $6,
      'email', $7, $8, $9,
      FALSE
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO NOTHING
    `,
    [
      rows[0].id,
      // The author's own name or NULL — never the source's (migration 184,
      // BYLINE-AND-PROVENANCE D9 ⟂). normaliseEmail yields '' with no From.
      item.authorName || null,
      source.avatar_url,
      item.title,
      truncatePreview(item.contentText),
      item.publishedAt,
      item.sourceItemUri,
      source.id,
      JSON.stringify(item.media),
    ],
  );

  return true;
}
