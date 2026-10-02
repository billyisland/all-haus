import type { PoolClient } from "pg";
import type { NormalisedActivityPubItem } from "../adapters/activitypub.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import { httpUrlOrNull } from "@platform-pub/shared/lib/sanitize.js";
import { CONTEXT_INTERACTION_MERGE_SQL } from "@platform-pub/shared/lib/context-persist.js";
import { recordServed } from "./item-membership.js";

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
  // Resolve the author's name ONCE and write the SAME value to both columns
  // (MIRROR-AUDIT §3, S17). An activitypub source is one actor, and the note
  // arrived through that actor's outbox (§2.9 is what makes that true), so the
  // source's display_name is the same person's name — resolving through it
  // names the author, not the source. What was wrong was writing the resolved
  // value to external_items and the UNRESOLVED one to feed_items:
  // feed_items_author_refresh repairs feed_items from NULLIF(ei.author_name,'')
  // every night and the next re-ingest put it back, so the two disagreed on a
  // nightly cycle for ever.
  const authorName = item.authorName ?? source.display_name ?? null;

  // AN ITEM'S IDENTITY IS NOT ITS PERMALINK. `source_item_uri` is the
  // federated ActivityPub id and dedups; `canonical_url` is the page a reader
  // opens, which the object declares separately as `url` and which is a
  // DIFFERENT string (`/users/alice/statuses/1` vs `/@alice/1`). Refused at the
  // write site, per the URL rule — and NULL here means "this object declared no
  // url", never "there is none", so the reader's derivation stays the fallback.
  const canonicalUrl = httpUrlOrNull(item.webUrl);

  const { rows, rowCount } = await client.query<{ id: string }>(
    `
    INSERT INTO external_items (
      source_id, protocol, tier,
      source_item_uri, canonical_url, title,
      author_name, author_handle, author_avatar_url, author_uri,
      content_text, content_html, language,
      media,
      source_reply_uri, source_quote_uri, is_repost,
      interaction_data,
      content_warning,
      published_at
    ) VALUES (
      $1, 'activitypub', 'tier3',
      $2, $17, $3,
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
      -- Fill only, never overwrite: a promoted context row may already hold a
      -- permalink, and a later fetch that has lost one must not take it away.
      canonical_url = COALESCE(external_items.canonical_url, EXCLUDED.canonical_url),
      -- A PROMOTION TAKES THE REAL PAYLOAD (CA-C8; the atproto writer says
      -- why): the context writers never carry a poll or a content warning,
      -- and the thin media they stored won the feed's COALESCE.
      title = EXCLUDED.title,
      content_text = EXCLUDED.content_text,
      content_html = EXCLUDED.content_html,
      language = EXCLUDED.language,
      media = EXCLUDED.media,
      content_warning = EXCLUDED.content_warning,
      source_reply_uri = COALESCE(EXCLUDED.source_reply_uri, external_items.source_reply_uri),
      source_quote_uri = COALESCE(EXCLUDED.source_quote_uri, external_items.source_quote_uri),
      ${CONTEXT_INTERACTION_MERGE_SQL},
      deleted_at = NULL
    WHERE external_items.is_context_only IS TRUE
    RETURNING id
  `,
    [
      source.id,
      item.sourceItemUri,
      item.title,
      authorName,
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
      canonicalUrl,
    ],
  );

  // This source served it, whether the row is new, promoted or already real
  // under another source — a Lemmy community and its poster's own account
  // carry the same object (CA-C4) — and it is seen now (CA-G10b).
  await recordServed(client, source.id, "activitypub", [item.sourceItemUri]);

  if (!rowCount || rowCount === 0) {
    // The row exists and is already REAL, so the promotion arm's WHERE refused
    // it and nothing above touched it. That is the entire historical corpus:
    // 58,686 activitypub rows carried no permalink at all, because this insert
    // never named the column while the adapter computed `webUrl` on both arms
    // and dropped it into `interaction_data` alone.
    //
    // Heal it here, beside the insert, the way the rss poll does — FILL ONLY,
    // so a source that later stops declaring a url cannot take one away. It
    // cannot become a `DO UPDATE` on the statement above: that WHERE is what
    // makes `rowCount` mean "this is new or newly promoted", and the dual-write
    // below keys off it.
    //
    // Unlike rss, an activitypub poll stops at the cursor and never re-offers
    // an old item, so this reaches only what a re-ingest happens to revisit —
    // migration 229 is what heals the corpus.
    if (canonicalUrl) {
      await client.query(
        `UPDATE external_items
            SET canonical_url = $2
          WHERE protocol = 'activitypub'
            AND source_item_uri = $1
            AND canonical_url IS NULL`,
        [item.sourceItemUri, canonicalUrl],
      );
    }
    return false;
  }

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
      // The same resolved value external_items got, byte for byte (S17). The
      // avatar keeps its source fallback: that is the ADR's open Q2, not this
      // change.
      authorName,
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
