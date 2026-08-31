import type { PoolClient } from "pg";
import type { NormalisedActivityPubItem } from "../adapters/activitypub.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";

// =============================================================================
// ActivityPub dual-write — external_items + feed_items.
// Mirrors the atproto-ingest pattern: the ON CONFLICT is promotion-gated
// (EXTERNAL-AUTHOR-HISTORY-ADR §4.2) — a context-only hydration row is
// promoted on real ingest (flags cleared, source_id re-homed, deleted_at
// cleared), while a real existing row keeps the old DO NOTHING semantics
// (WHERE false ⇒ no row ⇒ caller returns false), so the occasional overlap
// between backfill and steady-state polling stays safe.
// =============================================================================

interface ActivityPubIngestSource {
  id: string;
  source_uri: string;
  display_name: string | null;
  avatar_url: string | null;
}

export async function insertActivityPubItem(
  client: PoolClient,
  source: ActivityPubIngestSource,
  item: NormalisedActivityPubItem,
): Promise<boolean> {
  const { rows, rowCount } = await client.query<{ id: string }>(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri, title,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html, language,
      media,
      source_reply_uri, source_quote_uri, is_repost,
      interaction_data,
      content_warning,
      published_at
    ) VALUES (
      $1, 'activitypub', 'tier3',
      $2, $3,
      $4, $5, $6, $7,
      $8, $9, $10,
      $11,
      $12, $16, FALSE,
      $13,
      $14,
      $15
    )
    ON CONFLICT (protocol, source_item_uri) DO UPDATE SET
      is_context_only = FALSE,
      is_profile_hydrated = FALSE,
      source_id = EXCLUDED.source_id,
      deleted_at = NULL
    WHERE external_items.is_context_only IS TRUE
    RETURNING id
  `,
    [
      source.id,
      item.sourceItemUri,
      item.title,
      item.authorName ?? source.display_name ?? null,
      item.authorHandle,
      item.authorAvatarUrl ?? source.avatar_url ?? null,
      item.authorUri,
      item.contentText,
      item.contentHtml,
      item.language,
      JSON.stringify(item.media),
      item.sourceReplyUri,
      JSON.stringify(item.interactionData),
      item.contentWarning,
      item.publishedAt,
      item.sourceQuoteUri,
    ],
  );

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
      $4, $5,
      $6,
      'activitypub', $7, $8, $9,
      $10
    )
    ON CONFLICT (external_item_id) WHERE external_item_id IS NOT NULL DO UPDATE SET
      source_id = EXCLUDED.source_id,
      author_name = EXCLUDED.author_name,
      author_avatar = EXCLUDED.author_avatar,
      title = EXCLUDED.title,
      content_preview = EXCLUDED.content_preview,
      published_at = EXCLUDED.published_at,
      media = EXCLUDED.media,
      is_reply = EXCLUDED.is_reply,
      deleted_at = NULL
  `,
    [
      rows[0].id,
      // The author's own name or NULL — never the source's (migration 184,
      // BYLINE-AND-PROVENANCE D9 ⟂). The avatar keeps its source fallback:
      // that is the ADR's open Q2, not this change.
      item.authorName || null,
      item.authorAvatarUrl ?? source.avatar_url,
      item.title,
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

// =============================================================================
// Per-instance success/failure counters — drive the admin health view and
// inform the ADR's "30% failure → inbox delivery" acceleration decision.
// =============================================================================

export async function recordInstanceSuccess(
  client: PoolClient,
  host: string,
): Promise<void> {
  await client.query(
    `
    INSERT INTO activitypub_instance_health (host, success_count, last_success_at)
    VALUES ($1, 1, now())
    ON CONFLICT (host) DO UPDATE SET
      success_count   = activitypub_instance_health.success_count + 1,
      last_success_at = now(),
      updated_at      = now()
  `,
    [host],
  );
}

export async function recordInstanceFailure(
  client: PoolClient,
  host: string,
  error: string,
): Promise<void> {
  await client.query(
    `
    INSERT INTO activitypub_instance_health (host, failure_count, last_failure_at, last_error)
    VALUES ($1, 1, now(), $2)
    ON CONFLICT (host) DO UPDATE SET
      failure_count   = activitypub_instance_health.failure_count + 1,
      last_failure_at = now(),
      last_error      = $2,
      updated_at      = now()
  `,
    [host, error.slice(0, 500)],
  );
}
