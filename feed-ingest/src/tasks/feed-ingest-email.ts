import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  normaliseEmail,
  type PostmarkInboundPayload,
} from "../adapters/email.js";
import { insertEmailItem } from "../lib/email-ingest.js";

// =============================================================================
// feed_ingest_email — processes a single inbound email webhook payload.
//
// Push-only: enqueued by the gateway inbound-mail route when Postmark
// delivers a newsletter. No polling, no cursor.
// =============================================================================

interface Payload {
  sourceId: string;
  emailPayload: PostmarkInboundPayload;
}

export const feedIngestEmail: Task = async (payload, _helpers) => {
  const { sourceId, emailPayload } = payload as Payload;

  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    display_name: string | null;
    avatar_url: string | null;
    is_active: boolean;
    error_count: number;
  }>(
    `SELECT id, source_uri, display_name, avatar_url, is_active, error_count
     FROM external_sources WHERE id = $1`,
    [sourceId],
  );

  if (!source) {
    logger.warn({ sourceId }, "Email source not found, skipping");
    return;
  }
  if (!source.is_active) {
    logger.debug({ sourceId }, "Email source inactive, skipping");
    return;
  }

  try {
    const item = normaliseEmail(emailPayload);

    const inserted = await withTransaction(async (client) => {
      return insertEmailItem(client, source, item);
    });

    if (inserted) {
      logger.info(
        { sourceId, messageId: emailPayload.MessageID },
        "Email item ingested",
      );
    } else {
      logger.debug(
        { sourceId, messageId: emailPayload.MessageID },
        "Email item skipped (duplicate or dedup match)",
      );
    }

    // Clear errors on success
    if (source.error_count > 0) {
      await pool.query(
        `UPDATE external_sources SET error_count = 0, last_error = NULL, updated_at = now() WHERE id = $1`,
        [sourceId],
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const { rows: configRows } = await pool.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'feed_ingest_max_errors'`,
    );
    const maxErrors = parseInt(configRows[0]?.value ?? "", 10) || 50;

    const newErrorCount = source.error_count + 1;
    const shouldDeactivate = newErrorCount >= maxErrors;

    await pool.query(
      `
      UPDATE external_sources SET
        error_count = $2,
        last_error = $3,
        is_active = CASE WHEN $4 THEN FALSE ELSE is_active END,
        updated_at = now()
      WHERE id = $1
      `,
      [sourceId, newErrorCount, errorMessage.slice(0, 1000), shouldDeactivate],
    );

    if (shouldDeactivate) {
      logger.warn(
        { sourceId, errorCount: newErrorCount },
        "Email source deactivated after too many errors",
      );
    } else {
      logger.warn(
        { sourceId, errorCount: newErrorCount, err: errorMessage },
        "Email ingest failed",
      );
    }
  }
};
