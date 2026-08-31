import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import { decryptJson } from "@platform-pub/shared/lib/crypto.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  postMastodonStatus,
  favouriteMastodonStatus,
  reblogMastodonStatus,
  voteMastodonPoll,
  type MastodonCredentials,
} from "../adapters/activitypub-outbound.js";
import {
  publishNostrToRelays,
  type NostrSignedEvent,
} from "../adapters/nostr-outbound.js";
import {
  postBlueskyRecord,
  likeBlueskyRecord,
  repostBlueskyRecord,
} from "../adapters/atproto-outbound.js";
import { appendWithinBudget } from "../lib/text.js";
import { runOutboundJob } from "../lib/outbound-retry.js";

// =============================================================================
// outbound_cross_post — per-event job, dispatches a queued outbound_posts row
// to the appropriate external platform.
//
// Payload: { outboundPostId: UUID }
//
// Responsibilities:
//   - Load outbound_posts row + network_presences + source external_items (if any)
//   - Decrypt credentials, call the protocol-specific adapter
//   - On success: set status='sent', external_post_uri, sent_at
//   - On failure: increment retry_count; if below max_retries, mark 'retrying'
//     and re-enqueue after outbound_retry_delay_seconds * 2^retry_count.
//     Otherwise mark 'failed' and stop.
//
// The native all.haus event is never touched — outbound failure only affects
// outbound_posts.
// =============================================================================

interface OutboundRow {
  id: string;
  account_id: string;
  linked_account_id: string | null;
  protocol: string;
  nostr_event_id: string;
  action_type: string;
  source_item_id: string | null;
  body_text: string | null;
  signed_event: NostrSignedEvent | null;
  status: string;
  retry_count: number;
  max_retries: number;
  // Poster username — used to build the all.haus permalink for truncated posts.
  author_username: string | null;
  // Network presence fields (NULL for nostr_external)
  la_external_id: string | null;
  la_instance_url: string | null;
  la_credentials_enc: string | null;
  la_is_valid: boolean | null;
  la_lifecycle_state: string | null;
  // Source item fields (nullable — NULL for top-level posts)
  ei_source_item_uri: string | null;
  // atproto strong-ref data from external_items.interaction_data
  ei_interaction_data: AtprotoInteractionData | null;
  // Source relay URLs (nostr_external only)
  ei_source_relay_urls: string[] | null;
}

interface AtprotoInteractionData {
  uri?: string;
  cid?: string;
  rootUri?: string;
  rootCid?: string;
  parentUri?: string;
  parentCid?: string;
}

interface AllHausMeta {
  bluesky_max: number;
  mastodon_max: number;
  max_retries: number;
  retry_delay: number;
}

export const outboundCrossPost: Task = async (payload, helpers) => {
  const { outboundPostId } = payload as { outboundPostId: string };

  // Loaded once the row passes the claim guards; read by `attempt` and
  // `computeBackoff` (which both run after the claim).
  let cfg: AllHausMeta;

  await runOutboundJob<OutboundRow>({
    taskName: "outbound_cross_post",
    payload: { outboundPostId },
    rowId: outboundPostId,
    helpers,
    attemptsOf: (row) => row.retry_count,
    maxOf: (row) => row.max_retries,
    // delay·2^(n-1) seconds, no jitter (config-driven base delay).
    computeBackoff: (nextAttempt) =>
      new Date(Date.now() + cfg.retry_delay * Math.pow(2, nextAttempt - 1) * 1000),

    claim: async () => {
      const { rows } = await pool.query<OutboundRow>(
        `
        SELECT
          op.id, op.account_id, op.linked_account_id, op.protocol,
          op.nostr_event_id, op.action_type, op.source_item_id, op.body_text,
          op.signed_event, op.status, op.retry_count, op.max_retries,
          acc.username         AS author_username,
          la.external_id       AS la_external_id,
          la.service_url       AS la_instance_url,
          la.credentials_enc   AS la_credentials_enc,
          la.is_valid          AS la_is_valid,
          la.lifecycle_state   AS la_lifecycle_state,
          ei.source_item_uri   AS ei_source_item_uri,
          ei.interaction_data  AS ei_interaction_data,
          xs.relay_urls        AS ei_source_relay_urls
        FROM outbound_posts op
        LEFT JOIN accounts acc           ON acc.id = op.account_id
        LEFT JOIN network_presences la   ON la.id = op.linked_account_id
        LEFT JOIN external_items ei  ON ei.id = op.source_item_id
        LEFT JOIN external_sources xs ON xs.id = ei.source_id
        WHERE op.id = $1
      `,
        [outboundPostId],
      );
      const row = rows[0];
      if (!row) {
        logger.warn({ outboundPostId }, "outbound_cross_post: row not found");
        return null;
      }
      if (row.status === "sent") return null;
      if (row.status === "failed") return null;
      // A network presence is required for OAuth-backed protocols only, and must
      // be active (lifecycle_state) as well as valid (credentials/handle healthy).
      if (
        row.protocol !== "nostr_external" &&
        (!row.la_is_valid || row.la_lifecycle_state !== "active")
      ) {
        await markFailed(row.id, "Linked account invalid — reconnect in settings");
        return null;
      }

      cfg = await loadConfig();
      return row;
    },

    attempt: async (row) => {
    let externalPostUri: string;

    if (row.protocol === "activitypub") {
      if (!row.la_instance_url)
        throw new Error("Linked account has no instance_url");
      if (!row.la_credentials_enc)
        throw new Error("Linked account has no credentials");
      const creds = decryptJson<MastodonCredentials>(row.la_credentials_enc);

      if (row.action_type === "like") {
        if (!row.ei_source_item_uri)
          throw new Error("Like target missing source URI");
        const result = await favouriteMastodonStatus(
          row.la_instance_url,
          row.ei_source_item_uri,
          creds,
        );
        externalPostUri = result.externalPostUri;
      } else if (row.action_type === "repost") {
        if (!row.ei_source_item_uri)
          throw new Error("Repost target missing source URI");
        const result = await reblogMastodonStatus(
          row.la_instance_url,
          row.ei_source_item_uri,
          creds,
        );
        externalPostUri = result.externalPostUri;
      } else if (row.action_type === "poll_vote") {
        if (!row.ei_source_item_uri)
          throw new Error("Poll vote target missing source URI");
        const choices: number[] = JSON.parse(row.body_text || "[]");
        const result = await voteMastodonPoll(
          row.la_instance_url,
          row.ei_source_item_uri,
          choices,
          creds,
        );
        externalPostUri = result.externalPostUri;
      } else if (
        row.action_type !== "reply" &&
        row.action_type !== "quote" &&
        row.action_type !== "original"
      ) {
        throw new Error(
          `Unsupported activitypub action_type: ${row.action_type}`,
        );
      } else {
        // Mastodon has no native quote semantics — append the source URL so the
        // cross-posted status isn't a naked, context-free top-level post. The
        // URL carries the quote meaning, so it must survive truncation: budget
        // the body grapheme count down to make room before joining, rather than
        // blindly appending and letting the downstream tail-truncation clip the
        // URL off long posts.
        let text = row.body_text ?? "";
        if (row.action_type === "quote") {
          if (!row.ei_source_item_uri)
            throw new Error("Quote target missing source URL");
          const sep = text.endsWith("\n") ? "" : "\n\n";
          text = appendWithinBudget(
            text,
            `${sep}${row.ei_source_item_uri}`,
            cfg.mastodon_max,
          );
        }
        const result = await postMastodonStatus(
          {
            instanceUrl: row.la_instance_url,
            text,
            maxChars: cfg.mastodon_max,
            replyToStatusUri:
              row.action_type === "reply"
                ? (row.ei_source_item_uri ?? undefined)
                : undefined,
            idempotencyKey: row.id,
          },
          creds,
        );
        externalPostUri = result.externalPostUri;
      }
    } else if (row.protocol === "atproto") {
      if (!row.la_external_id) throw new Error("Linked account has no DID");
      const did = row.la_external_id;
      const interaction = row.ei_interaction_data ?? null;

      if (row.action_type === "like") {
        if (!interaction?.uri || !interaction.cid) {
          throw new Error(
            "Source atproto item is missing uri/cid — cannot like",
          );
        }
        const result = await likeBlueskyRecord(did, {
          uri: interaction.uri,
          cid: interaction.cid,
        });
        externalPostUri = result.externalPostUri;
      } else if (row.action_type === "repost") {
        if (!interaction?.uri || !interaction.cid) {
          throw new Error(
            "Source atproto item is missing uri/cid — cannot repost",
          );
        }
        const result = await repostBlueskyRecord(did, {
          uri: interaction.uri,
          cid: interaction.cid,
        });
        externalPostUri = result.externalPostUri;
      } else {
        let reply:
          | {
              root: { uri: string; cid: string };
              parent: { uri: string; cid: string };
            }
          | undefined;
        let quote: { uri: string; cid: string } | undefined;

        if (row.action_type === "reply") {
          if (!interaction?.uri || !interaction.cid) {
            throw new Error(
              "Source atproto item is missing uri/cid — cannot reply",
            );
          }
          const rootUri = interaction.rootUri ?? interaction.uri;
          const rootCid = interaction.rootCid ?? interaction.cid;
          reply = {
            root: { uri: rootUri, cid: rootCid },
            parent: { uri: interaction.uri, cid: interaction.cid },
          };
        } else if (row.action_type === "quote") {
          if (!interaction?.uri || !interaction.cid) {
            throw new Error(
              "Source atproto item is missing uri/cid — cannot quote",
            );
          }
          quote = { uri: interaction.uri, cid: interaction.cid };
        } else if (row.action_type !== "original") {
          throw new Error(
            `Unsupported atproto action_type: ${row.action_type}`,
          );
        }

        const appUrl = process.env.APP_URL?.replace(/\/$/, "");
        const allHausUrl =
          appUrl && row.author_username
            ? `${appUrl}/${row.author_username}`
            : undefined;
        const result = await postBlueskyRecord({
          did,
          text: row.body_text ?? "",
          maxGraphemes: cfg.bluesky_max,
          allHausUrl,
          reply,
          quote,
        });
        externalPostUri = result.externalPostUri;
      }
    } else if (row.protocol === "nostr_external") {
      if (!row.signed_event)
        throw new Error(
          "outbound_posts.signed_event missing for nostr_external job",
        );
      const relays = row.ei_source_relay_urls ?? [];
      if (relays.length === 0)
        throw new Error("Source has no relay URLs configured");
      externalPostUri = await publishNostrToRelays(row.signed_event, relays);
    } else {
      throw new Error(`Outbound protocol not yet supported: ${row.protocol}`);
    }

      await pool.query(
        `
        UPDATE outbound_posts
        SET status = 'sent',
            external_post_uri = $2,
            sent_at = now(),
            error_message = NULL
        WHERE id = $1
      `,
        [row.id, externalPostUri],
      );

      logger.info(
        { outboundPostId: row.id, protocol: row.protocol, externalPostUri },
        "outbound cross-post sent",
      );
    },

    onRetry: async (row, nextAttempt, _nextAt, msg) => {
      await pool.query(
        `
        UPDATE outbound_posts
        SET status = 'retrying', retry_count = $2, error_message = $3
        WHERE id = $1
      `,
        [row.id, nextAttempt, msg],
      );
      const delay = cfg.retry_delay * Math.pow(2, nextAttempt - 1);
      logger.info(
        { outboundPostId: row.id, retry: nextAttempt, delay, err: msg },
        "outbound cross-post retrying",
      );
    },

    onAbandon: async (row, _nextAttempt, msg) => {
      await markFailed(row.id, msg);
      logger.warn(
        { outboundPostId: row.id, err: msg },
        "outbound cross-post failed permanently",
      );
    },
  });
};

async function markFailed(id: string, msg: string): Promise<void> {
  await pool.query(
    `
    UPDATE outbound_posts
    SET status = 'failed', error_message = $2
    WHERE id = $1
  `,
    [id, msg],
  );
}

async function loadConfig(): Promise<AllHausMeta> {
  const { rows } = await pool.query<{ key: string; value: string }>(`
    SELECT key, value FROM platform_config
    WHERE key IN (
      'outbound_bluesky_max_graphemes',
      'outbound_mastodon_max_chars',
      'outbound_max_retries',
      'outbound_retry_delay_seconds'
    )
  `);
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return {
    bluesky_max: parseInt(m.get("outbound_bluesky_max_graphemes") ?? "300", 10),
    mastodon_max: parseInt(m.get("outbound_mastodon_max_chars") ?? "500", 10),
    max_retries: parseInt(m.get("outbound_max_retries") ?? "3", 10),
    retry_delay: parseInt(m.get("outbound_retry_delay_seconds") ?? "30", 10),
  };
}
