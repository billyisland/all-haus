import type { PoolClient } from "pg";
import type { NormalisedAtprotoItem } from "../adapters/atproto.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { CONTEXT_INTERACTION_MERGE_SQL } from "@platform-pub/shared/lib/context-persist.js";
import { recordServed } from "./item-membership.js";

// =============================================================================
// Shared atproto ingest write path — used by both the Jetstream listener and
// the backfill job. Dual-writes external_items + feed_items; either caller can
// safely rewrite the same post without producing duplicate rows.
//
// The ON CONFLICT is promotion-GATED (EXTERNAL-AUTHOR-HISTORY-ADR §4.2): a row
// first persisted context-only by thread/profile hydration is promoted to
// first-class on real ingest — flags cleared, source_id re-homed from the
// hydrating focal's source to the author's own (deletion matching keys on
// source_id; feed membership is external_item_sources, CA-C4), deleted_at
// cleared. A REAL existing row
// makes the WHERE false, no row returns, and the caller sees the exact old
// DO NOTHING semantics. The feed_items conflict can only fire in the promotion
// case (a fresh external_items insert mints a fresh id), so its DO UPDATE is
// the promotion refresh of the row the hydration dual-write left behind.
//
// Returns true if an external_items row was inserted or promoted (i.e. not a
// dedupe hit), so callers can count newly-ingested items.
// =============================================================================

interface AtprotoIngestSource {
  id: string;
  source_uri: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

export interface EngagementCounts {
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
}

export async function insertAtprotoItem(
  client: PoolClient,
  source: AtprotoIngestSource,
  item: NormalisedAtprotoItem,
  counts?: EngagementCounts,
): Promise<boolean> {
  // Resolve the post author's identity. A live Jetstream commit carries only
  // the DID, so item.authorHandle/authorName are undefined there — fall back to
  // the source's stored handle/display_name (one atproto source = one author;
  // the source is enriched with its handle by the backfill task). Never leave
  // both name and handle null: that is the byline that renders as "EXTERNAL".
  const authorHandle = item.authorHandle ?? source.handle ?? null;
  const authorName =
    item.authorName ??
    source.display_name ??
    (authorHandle ? `@${authorHandle}` : null);
  // The author's profile URI (their DID). Was previously the source's DID; now
  // the post author's DID, which for a single-author source is identical.
  const authorUri = item.authorDid ?? source.source_uri;

  const { rows, rowCount } = await client.query<{ id: string }>(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html, language,
      media,
      source_reply_uri, source_quote_uri, is_repost,
      interaction_data,
      like_count, reply_count, repost_count,
      published_at
    ) VALUES (
      $1, 'atproto', 'tier3',
      $2,
      $3, $4, $5, $6,
      $7, $8, $9,
      $10,
      $11, $12, FALSE,
      $13,
      $14, $15, $16,
      $17
    )
    ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
      is_context_only = FALSE,
      is_profile_hydrated = FALSE,
      source_id = EXCLUDED.source_id,
      -- A PROMOTION TAKES THE REAL PAYLOAD (CA-C8). A context row is the
      -- THIN write — the parent prefetch stores media = '[]' and the
      -- client-API hydrators carry no poll or content warning — and
      -- FEED_SELECT renders COALESCE(ei.media, fi.media), so a promoted post
      -- kept the empty media it was hydrated with while its feed_items twin
      -- was refreshed underneath it: images gone, a CW post uncovered.
      content_text = EXCLUDED.content_text,
      content_html = EXCLUDED.content_html,
      language = EXCLUDED.language,
      media = EXCLUDED.media,
      source_reply_uri = COALESCE(EXCLUDED.source_reply_uri, external_items.source_reply_uri),
      source_quote_uri = COALESCE(EXCLUDED.source_quote_uri, external_items.source_quote_uri),
      -- Counts are monotonic here as in the engagement refresh: a live
      -- commit carries none, and a context fetch may have read fresher ones.
      like_count = GREATEST(external_items.like_count, EXCLUDED.like_count),
      reply_count = GREATEST(external_items.reply_count, EXCLUDED.reply_count),
      repost_count = GREATEST(external_items.repost_count, EXCLUDED.repost_count),
      -- MERGED, newcomer last: real ingest's strong refs win, and the keys
      -- only a context fetch knows (grandparent, thread root) survive.
      ${CONTEXT_INTERACTION_MERGE_SQL},
      deleted_at = NULL
    WHERE external_items.is_context_only IS TRUE
    RETURNING id
  `,
    [
      source.id,
      item.sourceItemUri,
      authorName,
      authorHandle,
      source.avatar_url ?? null,
      authorUri,
      item.contentText,
      item.contentHtml,
      item.language,
      JSON.stringify(item.media),
      item.sourceReplyUri,
      item.sourceQuoteUri,
      JSON.stringify(item.interactionData),
      counts?.likeCount ?? 0,
      counts?.replyCount ?? 0,
      counts?.repostCount ?? 0,
      item.publishedAt,
    ],
  );

  // This source served it, whether the row is new, promoted or already real
  // under another source (CA-C4) — and it is seen now (CA-G10b).
  await recordServed(client, source.id, "atproto", [item.sourceItemUri]);

  if (!rowCount || rowCount === 0) return false;

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
      NULL, $4,
      $5,
      'atproto', $6, $7, $8,
      $9
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO UPDATE SET
      source_id = EXCLUDED.source_id,
      author_name = EXCLUDED.author_name,
      author_avatar = EXCLUDED.author_avatar,
      content_preview = EXCLUDED.content_preview,
      published_at = EXCLUDED.published_at,
      media = EXCLUDED.media,
      is_reply = EXCLUDED.is_reply,
      deleted_at = NULL
  `,
    [
      rows[0].id,
      // authorName has already walked the per-post → source handle chain
      // above; if that produced nothing the column is NULL, not a label
      // (migration 184). "Bluesky user" is the FRONTEND's last resort, and
      // the atproto backfill's repair filter accepts NULL.
      authorName || null,
      source.avatar_url,
      truncatePreview(item.contentText),
      item.publishedAt,
      item.sourceItemUri,
      source.id,
      JSON.stringify(item.media),
      item.sourceReplyUri != null,
    ],
  );

  return true;
}
