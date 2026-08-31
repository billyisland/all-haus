import { withTransaction } from "@platform-pub/shared/db/client.js";
import {
  enqueueRelayPublish,
  type SignedNostrEvent,
} from "@platform-pub/shared/lib/relay-outbox.js";
import { signEvent } from "../lib/key-custody-client.js";
import { sendPublishNotifications } from "@platform-pub/shared/lib/publish-emails.js";
import { checkAndTriggerDriveFulfilment } from "../routes/drives.js";
import { slugify, generateDTag } from "@platform-pub/shared/lib/slug.js";
import { truncatePreview } from "@platform-pub/shared/lib/text.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Personal article publisher — the ONE server-side publish pipeline
//
// Extracted from gateway/src/workers/scheduler.ts (2026-08-08) so the scheduler
// is a caller rather than the owner. The archive importer is the second caller.
//
// Do NOT write a second bulk publisher alongside this one. Everything the
// paywall and relay invariants require is discharged here and only here:
//   - sign via key-custody (v1)
//   - articles + feed_items dual-write in ONE transaction
//   - enqueueRelayPublish INSIDE that transaction (free articles)
//   - vault seal, then the v2 swing + enqueue in a second transaction
// A copy of this loop that drops any one of those is the bug class the
// RELAY-OUTBOX and paywall-deliverability invariants exist to prevent.
//
// Spec: docs/adr/ARCHIVE-IMPORT-ADR.md §II (why one pipeline) and §III (dates).
// =============================================================================

export const PAYWALL_GATE_MARKER = "<!-- paywall-gate -->";

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? "http://localhost:3002";

/** What to publish. Field names mirror article_drafts, in camelCase. */
export interface PersonalArticleInput {
  writerId: string;
  title: string;
  dek: string | null;
  /** Full body; may carry PAYWALL_GATE_MARKER to split free from paywalled. */
  contentRaw: string;
  nostrDTag: string | null;
  gatePositionPct: number | null;
  pricePence: number | null;
  coverImageUrl: string | null;
  commentsEnabled: boolean | null;
}

/**
 * Every option defaults to the behaviour the scheduler had before this module
 * existed, so an omitted option can never change a scheduled publish.
 */
export interface PersonalArticleOptions {
  /**
   * First-publication date. Written to articles.published_at,
   * feed_items.published_at and the NIP-23 `published_at` tag.
   *
   * The event's own `created_at` is deliberately NOT derived from this — see
   * ADR §III. A backdated created_at is legal only inside strfry's
   * rejectEventsOlderThanSeconds window (ten years, relay/strfry.conf), past
   * which the article row indexes cleanly and the relay publish silently
   * fails. `created_at` is when this event was signed; `published_at` is when
   * the words were first published. For an import those are different dates
   * and NIP-23 already says so.
   *
   * Default: now.
   */
  publishedAt?: Date;
  /**
   * Email the writer's subscribers. Default true.
   *
   * An archive import MUST pass false: publishing 200 posts that were already
   * published elsewhere is not 200 things to tell a mailing list about, and
   * the send is irreversible.
   */
  sendEmail?: boolean;
  /**
   * Match and fulfil a pledge drive. Default true.
   *
   * Requires draftId — a drive's only match key is pledge_drives.draft_id.
   * An import has no working draft, so it passes false.
   */
  matchDrives?: boolean;
  /** The working draft this publish came from, for drive fulfilment. */
  draftId?: string | null;
}

export interface PersonalArticleResult {
  articleId: string;
  dTag: string;
  /** The canonical event id: v2 for paywalled articles, v1 for free ones. */
  eventId: string;
}

// =============================================================================
// Publish
// =============================================================================

export async function publishPersonalArticle(
  input: PersonalArticleInput,
  options: PersonalArticleOptions = {},
): Promise<PersonalArticleResult> {
  const publishedAt = options.publishedAt ?? new Date();
  const sendEmail = options.sendEmail !== false;
  const matchDrives = options.matchDrives !== false;
  const draftId = options.draftId ?? null;

  const { freeContent, paywallContent, fullContent } = splitContent(
    input.contentRaw,
  );
  const isPaywalled = !!paywallContent && (input.pricePence ?? 0) > 0;

  const dTag = input.nostrDTag ?? generateDTag(input.title || "untitled");
  const wordCount = fullContent.split(/\s+/).filter(Boolean).length;
  const slug = slugify(input.title || "untitled", 120);

  const baseTags: string[][] = [
    ["d", dTag],
    ["title", input.title || "Untitled"],
    // First publication, not signing time — backdated for an import.
    ["published_at", String(Math.floor(publishedAt.getTime() / 1000))],
  ];

  // NIP-23 summary tag from the draft's dek (M20) — was lost because
  // article_drafts never carried the dek, so scheduled articles published with
  // no standfirst and no summary tag.
  if (input.dek && input.dek.trim()) {
    baseTags.push(["summary", input.dek.trim()]);
  }

  if (input.coverImageUrl) {
    baseTags.push(["image", input.coverImageUrl]);
  }

  if (isPaywalled) {
    baseTags.push(
      ["price", String(input.pricePence), "GBP"],
      ["gate", String(input.gatePositionPct ?? 50)],
    );
  }

  const eventContent = isPaywalled ? freeContent : fullContent;

  // Sign v1. For free articles this is the canonical event that gets
  // enqueued for relay publish in the same txn as the article row. For
  // paywalled articles v1 is only the vault-ownership anchor the key
  // service matches against; the canonical v2 (with payload tag) is
  // enqueued once the vault is sealed.
  //
  // created_at is NOW even when publishedAt is backdated — see the option doc.
  const v1 = await signEvent(
    input.writerId,
    {
      kind: 30023,
      content: eventContent,
      tags: baseTags,
      created_at: Math.floor(Date.now() / 1000),
    },
    "account",
  );

  // Upsert articles + feed_items keyed on v1.id. For free drafts we enqueue
  // v1 to the relay outbox inside this same txn — article row and outbox
  // row commit together, the worker publishes. For paywalled drafts this
  // txn establishes the vault-ownership anchor; enqueue happens in the
  // second txn after the vault is sealed and v2 is signed.
  const articleId = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (
         writer_id, nostr_event_id, nostr_d_tag, title, slug, summary,
         content_free, word_count, tier,
         access_mode, price_pence, gate_position_pct,
         cover_image_url, comments_enabled, published_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'tier1', $9, $10, $11, $12, $13, $14)
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
         cover_image_url = EXCLUDED.cover_image_url,
         comments_enabled = EXCLUDED.comments_enabled,
         published_at = EXCLUDED.published_at
       RETURNING id`,
      [
        input.writerId,
        v1.id,
        dTag,
        input.title || "Untitled",
        slug,
        input.dek?.trim() || null,
        eventContent,
        wordCount,
        isPaywalled ? "paywalled" : "public",
        isPaywalled ? input.pricePence : null,
        isPaywalled ? (input.gatePositionPct ?? null) : null,
        input.coverImageUrl,
        input.commentsEnabled ?? true,
        publishedAt,
      ],
    );
    const artId = rows[0].id;

    const {
      rows: [author],
    } = await client.query<{
      display_name: string | null;
      avatar_blossom_url: string | null;
      username: string | null;
    }>(
      `SELECT display_name, avatar_blossom_url, username FROM accounts WHERE id = $1`,
      [input.writerId],
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
        media, published_at
      ) VALUES (
        'article', $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10
      )
      ON CONFLICT (article_id) WHERE article_id IS NOT NULL DO UPDATE SET
        title = EXCLUDED.title,
        content_preview = EXCLUDED.content_preview,
        nostr_event_id = EXCLUDED.nostr_event_id,
        author_name = EXCLUDED.author_name,
        author_avatar = EXCLUDED.author_avatar,
        media = EXCLUDED.media,
        -- Converges with the articles arm above. Both columns hold the SAME
        -- instant (ADR §III) and the INSERT arms write it from one variable, so
        -- an upsert that refreshed only one of them would split the article and
        -- profile surfaces from every follower's feed — silently, since neither
        -- row is wrong on its own. Invisible while the scheduler is the only
        -- caller (it passes now() to both), but ARCHIVE-IMPORT-ADR §VII designs
        -- re-runs to converge through exactly this upsert on a deterministic
        -- d-tag, which is where a corrected date arrives.
        published_at = EXCLUDED.published_at
    `,
      [
        artId,
        input.writerId,
        author?.display_name ?? author?.username ?? "Unknown",
        author?.avatar_blossom_url ?? null,
        author?.username ?? null,
        input.title || "Untitled",
        truncatePreview(eventContent),
        v1.id,
        mediaJson,
        publishedAt,
      ],
    );

    // For free articles v1 is the canonical event — enqueue alongside the
    // INSERT so the article row and the outbox row commit atomically. For
    // paywalled articles this is deferred until v2 is signed.
    if (!isPaywalled) {
      await enqueueRelayPublish(client, {
        entityType: "article",
        entityId: artId,
        signedEvent: v1 as SignedNostrEvent,
      });
    }

    return artId;
  });

  let canonicalEventId = v1.id;

  if (isPaywalled && paywallContent) {
    // Seal the vault (key-service validates ownership against v1.id on the
    // article row we just committed) then build the canonical v2 with the
    // payload tag. v1 is discarded — never enqueued, never reaches the
    // relay.
    const vault = await createVault(v1.id, articleId, dTag, input, paywallContent);

    const v2 = await signEvent(
      input.writerId,
      {
        kind: 30023,
        content: freeContent,
        tags: [...baseTags, ["payload", vault.ciphertext, vault.algorithm]],
        created_at: v1.created_at + 1,
      },
      "account",
    );

    // Swing articles + feed_items to v2.id and enqueue v2 in a single txn.
    // If any step throws the whole txn rolls back, the draft is retained
    // (caller's catch), and retry re-converges via the articles ON CONFLICT
    // upsert + the vault-key reuse path in key-service.
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE articles SET nostr_event_id = $1 WHERE id = $2",
        [v2.id, articleId],
      );
      await client.query(
        "UPDATE feed_items SET nostr_event_id = $1 WHERE article_id = $2",
        [v2.id, articleId],
      );
      await enqueueRelayPublish(client, {
        entityType: "article",
        entityId: articleId,
        signedEvent: v2 as SignedNostrEvent,
      });
    });

    canonicalEventId = v2.id;
  }

  if (sendEmail) {
    sendPublishNotifications(
      input.writerId,
      articleId,
      input.title || "Untitled",
      dTag,
      undefined,
      eventContent,
    ).catch((err) =>
      logger.error({ err, articleId }, "Publish notification email failed"),
    );
  }

  if (matchDrives) {
    // Awaited and NOT swallowed: the scheduler deletes the draft next, which
    // SET NULLs pledge_drives.draft_id — the drive's only match key. A
    // failure here must propagate so the caller's catch restores scheduled_at
    // and the whole publish retries (the upsert pipeline converges).
    await checkAndTriggerDriveFulfilment(input.writerId, articleId, draftId);
  }

  return { articleId, dTag, eventId: canonicalEventId };
}

// =============================================================================
// Helpers
// =============================================================================

export function splitContent(raw: string): {
  freeContent: string;
  paywallContent: string;
  fullContent: string;
} {
  const fullContent = raw.replace(PAYWALL_GATE_MARKER, "").trim();
  const markerIndex = raw.indexOf(PAYWALL_GATE_MARKER);

  if (markerIndex === -1) {
    return { freeContent: raw.trim(), paywallContent: "", fullContent };
  }

  return {
    freeContent: raw.slice(0, markerIndex).trim(),
    paywallContent: raw.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim(),
    fullContent,
  };
}

async function createVault(
  nostrEventId: string,
  articleId: string,
  dTag: string,
  input: PersonalArticleInput,
  paywallBody: string,
): Promise<{ ciphertext: string; algorithm: string }> {
  const res = await fetch(
    `${KEY_SERVICE_URL}/api/v1/articles/${nostrEventId}/vault`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-writer-id": input.writerId,
        "X-Internal-Secret": process.env.INTERNAL_SECRET ?? "",
      },
      body: JSON.stringify({
        articleId,
        paywallBody,
        pricePence: input.pricePence,
        gatePositionPct: input.gatePositionPct,
        nostrDTag: dTag,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Vault creation failed: ${res.status} — ${JSON.stringify(body)}`,
    );
  }

  return res.json() as Promise<{ ciphertext: string; algorithm: string }>;
}
