import { withTransaction, pool } from "@platform-pub/shared/db/client.js";
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
import { internalSecret } from "@platform-pub/shared/lib/env.js";
import { keyServiceHeaders } from "../lib/key-service-client.js";
import { rekeyArticleEvent } from "../lib/article-event-rekey.js";
import {
  writerTermsOutstanding,
  WriterTermsRequiredError,
} from "../lib/terms-gate.js";
import { canWrite, WriterAccessRequiredError } from "../lib/writer-gate.js";

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

// =============================================================================
// What a piece must be before it can go live — THE ONE SPELLING, at every door.
//
// The fourth publish-side validator, and it keeps the other three's rules
// (money.md: paywalled ⇒ price ≥ 1p and a gate 1..99, in lockstep with the
// editor's `publish-validation.ts`, `IndexArticleSchema` and the key service's
// `PublishVaultSchema`), plus the two `IndexArticleSchema` enforces by shape: a
// title, and something to publish. The paywalled predicate is `splitContent`
// below — a second spelling would let a draft pass a door and be read
// differently by the function that decides.
//
// A MARKER WITH NO PRICE IS REFUSED, NOT PUBLISHED FREE. `publishPersonalArticle`
// treats "marker, price 0" as a free piece and publishes the marker-stripped
// WHOLE body — the paid half given away in public. The editor has always
// refused it before signing; publish-now refused it from the day it opened;
// the SCHEDULE door did not (CA-A1, 2026-09-29): it asked only the Writer
// Agreement, so a dashboard press on an autosaved draft — the dashboard runs
// no client check — scheduled the paid half for free publication. So the
// check lives HERE, beside the function it protects, and is asked three ways:
// the schedule route and publish-now answer it as a 400 at the gesture, and
// `publishPersonalArticle` throws it TYPED as the backstop, before it signs
// and before its first transaction (a refusal after that transaction has
// already committed the free row, and the scheduler's generic retry then
// re-commits it every minute).
// =============================================================================

export interface PublishableDraft {
  title: string | null;
  content_raw: string | null;
  price_pence: number | null;
  gate_position_pct: number | null;
}

export function publishRefusal(
  d: PublishableDraft,
): { error: string; message: string } | null {
  if (!d.title || !d.title.trim()) {
    return {
      error: "title_required",
      message: "Give the piece a title before publishing it.",
    };
  }
  const raw = d.content_raw ?? "";
  const { paywallContent, fullContent } = splitContent(raw);
  if (!fullContent.trim()) {
    return {
      error: "content_required",
      message: "There is nothing to publish yet.",
    };
  }
  if (raw.includes(PAYWALL_GATE_MARKER)) {
    if (!paywallContent) {
      return {
        error: "paywall_empty",
        message:
          "There is no content after the paywall gate — move the gate up, or remove it.",
      };
    }
    if (!Number.isInteger(d.price_pence) || (d.price_pence ?? 0) < 1) {
      return {
        error: "paywall_price",
        message: "Set a price of at least £0.01 for the paywalled section.",
      };
    }
    const gate = d.gate_position_pct;
    if (gate === null || !Number.isInteger(gate) || gate < 1 || gate > 99) {
      return {
        error: "paywall_gate",
        message:
          "The paywall gate needs a position between 1 and 99 per cent.",
      };
    }
  }
  return null;
}

/**
 * The publisher's own refusal, thrown TYPED so a batch caller can tell it from
 * a transient fault: the scheduler un-schedules the draft on it (content kept)
 * the way it does on `WriterTermsRequiredError`, instead of retrying a
 * permanent rejection every minute forever.
 */
export class ArticleUnpublishableError extends Error {
  readonly code: string;
  constructor(refusal: { error: string; message: string }) {
    super(refusal.message);
    this.name = "ArticleUnpublishableError";
    this.code = refusal.error;
  }
}

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? "http://localhost:3002";
// Not `?? ""`: an unset secret must not present as key-service refusing the
// vault write. See `internalSecret()` and the note in routes/export.ts.

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
   * Email the writer's subscribers about a NEW piece. Default true.
   *
   * An EDIT emails nobody whatever this says: a live article already holding
   * the d-tag (the same prior row the re-key reads) means the subscribers were
   * told the first time. This is decided HERE, not by each caller, because the
   * scheduler passes no options — so a scheduled edit of a live piece emailed
   * every subscriber again (MODERNHAUS-ADR §E4.3).
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
  const sendEmail = options.sendEmail !== false;
  const matchDrives = options.matchDrives !== false;
  const draftId = options.draftId ?? null;

  // WRITER ACCESS FIRST (READER-WRITER-SPLIT-ADR §4.1): the backstop for the
  // doors that reach here — publish-now refuses a reader at its preHandler,
  // but a scheduled draft publishes minutes or days after the gesture, and a
  // draft a reader holds from before the gate must not go live through the
  // scheduler. Before every other refusal (asking a reader about the Writer
  // Agreement or the piece is asking about an act they cannot perform),
  // before the event is signed and before the first transaction. TYPED, so
  // the scheduler un-schedules rather than retrying every minute for ever.
  if (!(await canWrite(input.writerId))) {
    throw new WriterAccessRequiredError(input.writerId);
  }

  // THE BACKSTOP FOR EVERY DOOR (posts.md: a publish-side precondition is
  // enforced at every one of them). The schedule route and publish-now answer
  // this refusal as a 400 at the gesture; here it is a TYPED throw, BEFORE the
  // event is signed and BEFORE the first transaction — a marker with no price
  // would otherwise be read as a free piece two lines down and the whole body
  // committed in public. The scheduler un-schedules on the type (CA-A1).
  const refusal = publishRefusal({
    title: input.title,
    content_raw: input.contentRaw,
    price_pence: input.pricePence,
    gate_position_pct: input.gatePositionPct,
  });
  if (refusal) {
    throw new ArticleUnpublishableError(refusal);
  }

  const { freeContent, paywallContent, fullContent } = splitContent(
    input.contentRaw,
  );
  const isPaywalled = !!paywallContent && (input.pricePence ?? 0) > 0;

  // THE BACKSTOP FOR EVERY PAYWALLED PUBLISH THAT DOES NOT COME THROUGH
  // `POST /articles` (A3). A scheduled draft reaches the site through this
  // function and never touches that route, so a refusal there alone would let
  // a writer schedule paid access under a text they had not accepted — and,
  // worse, would do it silently, minutes or days after the gesture. The
  // importer is the same shape.
  //
  // It throws rather than returning, because every caller here is a batch:
  // the scheduler catches this error by TYPE and un-schedules the draft, the
  // same disposition it gives the two publication refusals, which is what
  // stops a permanent rejection being retried every minute forever.
  //
  // `POST /drafts/:id/schedule` refuses first, at the gesture, so this fires
  // only for a draft that was free when it was scheduled and gained a gate
  // afterwards.
  if (isPaywalled && (await writerTermsOutstanding(input.writerId))) {
    throw new WriterTermsRequiredError(input.writerId);
  }

  const dTag = input.nostrDTag ?? generateDTag(input.title || "untitled");
  const wordCount = fullContent.split(/\s+/).filter(Boolean).length;
  const slug = slugify(input.title || "untitled", 120);

  // AN EDIT KEEPS ITS FIRST-PUBLICATION DATE (CA-B3, 2026-09-29). `published_at`
  // is when the words were first published (posts.md) and this defaulted it to
  // now on EVERY call, with both upserts' conflict arms writing
  // `EXCLUDED.published_at` — so a re-publish of a live d-tag through
  // publish-now or the scheduler re-dated the piece and bumped it to the top
  // of every feed. The prior row's date is read HERE, before the NIP-23 tag
  // is built and the event signed, because the tag and the column must hold
  // one instant: read inside the transaction it would be too late for the
  // signature. An explicit `options.publishedAt` still wins (ARCHIVE-IMPORT-ADR
  // §VII: a corrected date arrives through exactly this upsert); a first
  // publish still dates to now. Not `FOR UPDATE` — the transaction below
  // locks the row itself, and the only writer of this column is this upsert.
  let publishedAt = options.publishedAt ?? null;
  if (!publishedAt && input.nostrDTag) {
    const { rows: prior } = await pool.query<{ published_at: Date | null }>(
      `SELECT published_at FROM articles
        WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL`,
      [input.writerId, dTag],
    );
    publishedAt = prior[0]?.published_at ?? null;
  }
  publishedAt ??= new Date();

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
  // Set inside the transaction from the prior row; read after it commits.
  let isEdit = false;
  const articleId = await withTransaction(async (client) => {
    // The prior event id, read before the upsert overwrites it (§2.8). Same
    // rule and same reason as the index route: an edit signs a NEW event, and
    // everything pointing at the old id has to come with it or the piece's
    // conversation is silently orphaned. This path is the scheduler's and the
    // bulk importer's, and a scheduled RE-publish of an existing d-tag is an
    // edit like any other.
    const priorRow = await client.query<{ nostr_event_id: string }>(
      `SELECT nostr_event_id FROM articles
        WHERE writer_id = $1 AND nostr_d_tag = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [input.writerId, dTag],
    );
    const priorEventId = priorRow.rows[0]?.nostr_event_id ?? null;
    isEdit = priorRow.rows.length > 0;

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

    if (priorEventId) {
      const rekeyed = await rekeyArticleEvent(client, priorEventId, v1.id);
      if (Object.keys(rekeyed).length > 0) {
        logger.info({ artId, rekeyed }, "Article edit carried its conversation");
      }
    }

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

  if (sendEmail && !isEdit) {
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

const VAULT_CREATE_TIMEOUT_MS = 30_000;

async function createVault(
  nostrEventId: string,
  articleId: string,
  dTag: string,
  input: PersonalArticleInput,
  paywallBody: string,
): Promise<{ ciphertext: string; algorithm: string }> {
  const path = `/api/v1/articles/${nostrEventId}/vault`;
  // Stringified ONCE: the binding hashes the bytes we send, and a second
  // JSON.stringify is not guaranteed to reproduce the first.
  const rawBody = JSON.stringify({
    articleId,
    paywallBody,
    pricePence: input.pricePence,
    gatePositionPct: input.gatePositionPct,
    nostrDTag: dTag,
  });
  const res = await fetch(`${KEY_SERVICE_URL}${path}`, {
    method: "POST",
    headers: keyServiceHeaders({
      method: "POST",
      path,
      rawBody,
      json: true,
      identity: { writerId: input.writerId },
    }),
    body: rawBody,
    // Bounded: the scheduler calls this inside its advisory lock, so a hung
    // key-service would otherwise hold every other tick off for undici's 300s
    // default per draft. A timeout is ambiguous (the vault may exist), which
    // is safe here — the caller's catch retries, and key-service reuses the
    // article's vault key on the second call.
    signal: AbortSignal.timeout(VAULT_CREATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Vault creation failed: ${res.status} — ${JSON.stringify(body)}`,
    );
  }

  return res.json() as Promise<{ ciphertext: string; algorithm: string }>;
}
