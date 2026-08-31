import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import {
  publishToPublication,
  PublicationPaywallUnsupportedError,
  PublicationsSuspendedError,
} from "../services/publication-publisher.js";
import {
  publishPersonalArticle,
  splitContent,
} from "../services/article-publisher.js";
import { sendPublishNotifications } from "@platform-pub/shared/lib/publish-emails.js";
import { checkAndTriggerDriveFulfilment } from "../routes/drives.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// Scheduled Publishing Worker
//
// Polls for drafts whose scheduled_at has passed and publishes them.
// Runs every 60 seconds via advisory lock in gateway/index.ts.
//
// Publication articles use the existing publication-publisher pipeline.
// Personal articles go through services/article-publisher.ts — the one
// server-side publish pipeline, which this worker used to own outright and is
// now simply the first caller of (the archive importer is the second). Publish
// mechanics belong THERE, not here; this file owns claiming, retry and the
// draft's lifecycle, nothing more.
// =============================================================================

interface ScheduledDraft {
  id: string;
  writer_id: string;
  title: string;
  dek: string | null;
  content_raw: string;
  nostr_d_tag: string | null;
  gate_position_pct: number | null;
  price_pence: number | null;
  publication_id: string | null;
  cover_image_url: string | null;
  comments_enabled: boolean | null;
}

export async function publishScheduledDrafts(): Promise<void> {
  // Atomically claim due drafts by pushing scheduled_at 5 minutes into the
  // future. If the process hard-crashes after claim but before DELETE or the
  // catch block, the draft naturally becomes due again — no orphan possible.
  const drafts = await withTransaction(async (client) => {
    const { rows } = await client.query<
      ScheduledDraft & { saved_scheduled_at: Date }
    >(
      `UPDATE article_drafts
       SET scheduled_at = now() + interval '5 minutes'
       WHERE id IN (
         SELECT id FROM article_drafts
         WHERE scheduled_at IS NOT NULL AND scheduled_at <= now()
         ORDER BY scheduled_at ASC
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, writer_id, title, dek, content_raw, nostr_d_tag,
                 gate_position_pct, price_pence, publication_id, cover_image_url,
                 comments_enabled`,
    );
    return rows;
  });

  if (drafts.length === 0) return;

  logger.info({ count: drafts.length }, "Scheduler: processing due drafts");

  for (const draft of drafts) {
    try {
      if (draft.publication_id) {
        await publishPublicationDraft(draft);
      } else {
        await publishPersonalDraft(draft);
      }

      await pool.query("DELETE FROM article_drafts WHERE id = $1", [draft.id]);

      logger.info(
        { draftId: draft.id, writerId: draft.writer_id, title: draft.title },
        "Scheduler: draft published successfully",
      );
    } catch (err) {
      // Both are permanent rejections for as long as they hold, so they take
      // the same disposition: un-schedule rather than retry. A suspended
      // publication draft retried every cycle would log an error forever and
      // never publish — the generic branch below is for TRANSIENT failure only.
      if (
        err instanceof PublicationPaywallUnsupportedError ||
        err instanceof PublicationsSuspendedError
      ) {
        // Permanent rejection — retrying can never succeed. Un-schedule the
        // draft (it returns to the writer's plain drafts, content intact).
        await pool
          .query(
            "UPDATE article_drafts SET scheduled_at = NULL WHERE id = $1",
            [draft.id],
          )
          .catch(() => {});
        logger.warn(
          { draftId: draft.id, writerId: draft.writer_id },
          err instanceof PublicationsSuspendedError
            ? "Scheduler: publication draft un-scheduled (publications suspended); draft kept intact"
            : "Scheduler: paywalled publication draft un-scheduled (publication paywalls unsupported)",
        );
        continue;
      }
      // Restore scheduled_at so the draft is retried next cycle
      await pool
        .query("UPDATE article_drafts SET scheduled_at = now() WHERE id = $1", [
          draft.id,
        ])
        .catch(() => {});
      logger.error(
        { err, draftId: draft.id, writerId: draft.writer_id },
        "Scheduler: draft publish failed — will retry next cycle",
      );
    }
  }
}

// =============================================================================
// Publication articles — delegate to the existing server-side pipeline
// =============================================================================

async function publishPublicationDraft(draft: ScheduledDraft): Promise<void> {
  const { rows: authors } = await pool.query<{ nostr_pubkey: string }>(
    "SELECT nostr_pubkey FROM accounts WHERE id = $1",
    [draft.writer_id],
  );
  if (authors.length === 0)
    throw new Error(`Writer ${draft.writer_id} not found`);

  // Check if the author can publish to this publication
  const { rows: members } = await pool.query<{ can_publish: boolean }>(
    `SELECT can_publish FROM publication_members
     WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
    [draft.publication_id!, draft.writer_id],
  );
  const canPublish = members.length > 0 && members[0].can_publish;

  const { freeContent, paywallContent, fullContent } = splitContent(
    draft.content_raw,
  );
  const isPaywalled = !!paywallContent && (draft.price_pence ?? 0) > 0;

  const result = await publishToPublication({
    publicationId: draft.publication_id!,
    authorId: draft.writer_id,
    authorPubkey: authors[0].nostr_pubkey,
    title: draft.title || "Untitled",
    content: isPaywalled ? freeContent : fullContent,
    fullContent,
    accessMode: isPaywalled ? "paywalled" : "public",
    pricePence: isPaywalled ? draft.price_pence! : undefined,
    gatePositionPct: isPaywalled ? draft.gate_position_pct! : undefined,
    showOnWriterProfile: true,
    canPublish,
    existingDTag: draft.nostr_d_tag ?? undefined,
    coverImageUrl: draft.cover_image_url,
    commentsEnabled: draft.comments_enabled ?? true,
  });

  // Send notification emails for new articles
  if (result.status === "published") {
    sendPublishNotifications(
      draft.writer_id,
      result.articleId,
      draft.title || "Untitled",
      result.dTag,
      undefined,
      isPaywalled ? freeContent : fullContent,
    ).catch((err) =>
      logger.error(
        { err, draftId: draft.id },
        "Scheduler: publish email failed",
      ),
    );

    // Awaited and NOT swallowed: the caller deletes the draft next, which
    // SET NULLs pledge_drives.draft_id — the drive's only match key. A
    // failure here must propagate so the outer catch restores scheduled_at
    // and the whole publish retries (the upsert pipeline converges).
    await checkAndTriggerDriveFulfilment(
      draft.writer_id,
      result.articleId,
      draft.id,
    );
  }
}

// =============================================================================
// Personal articles — the shared publisher, with every option at its default
//
// A scheduled publish is "now, tell the subscribers, match the drive", which is
// exactly what publishPersonalArticle does when passed no options. Do not add
// options here to change scheduler behaviour; they exist for the importer.
// =============================================================================

async function publishPersonalDraft(draft: ScheduledDraft): Promise<void> {
  await publishPersonalArticle(
    {
      writerId: draft.writer_id,
      title: draft.title,
      dek: draft.dek,
      contentRaw: draft.content_raw,
      nostrDTag: draft.nostr_d_tag,
      gatePositionPct: draft.gate_position_pct,
      pricePence: draft.price_pence,
      coverImageUrl: draft.cover_image_url,
      commentsEnabled: draft.comments_enabled,
    },
    { draftId: draft.id },
  );
}
