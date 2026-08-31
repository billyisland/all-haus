import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { pinnedWebSocketOptions } from "@platform-pub/shared/lib/http-client.js";
import { recordRepostEdge } from "../lib/repost-edge.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { NOSTR_FALLBACK_RELAYS } from "@platform-pub/shared/lib/nostr-relay-req.js";
import {
  type NostrEvent,
  validateNostrEvents,
  insertNostrItem,
  applyNostrDeletions,
  detectNostrRepost,
  nostrNip05,
  nostrProfileUpdate,
  fetchNostrRelayEvents,
} from "../lib/nostr-ingest.js";

// =============================================================================
// feed_ingest_nostr — per-source external Nostr relay fetch job
//
// Opens temporary WebSocket connections to the source's relay URLs, sends a
// REQ for recent events by the source pubkey, normalises into external_items
// + feed_items, and handles kind 5 deletions.
//
// Orchestration only — the per-event machinery (validation, identity encoding,
// the ratchet writer, deletions, metadata ratchet) is shared with the
// subscribe-time backfill task via lib/nostr-ingest.ts (§4.3).
//
// See docs/adr/UNIVERSAL-FEED-ADR.md §VI.2 for full spec.
// =============================================================================

const DEFAULT_LOOKBACK_SECONDS = 48 * 60 * 60; // 48 hours

export const feedIngestNostr: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string };

  // Load source
  const {
    rows: [source],
  } = await pool.query<{
    id: string;
    source_uri: string;
    relay_urls: string[] | null;
    cursor: string | null;
    error_count: number;
    display_name: string | null;
    avatar_url: string | null;
    metadata_updated_at: Date | null;
  }>(
    `SELECT id, source_uri, relay_urls, cursor, error_count, display_name, avatar_url, metadata_updated_at
      FROM external_sources WHERE id = $1`,
    [sourceId],
  );

  if (!source) {
    logger.warn({ sourceId }, "Nostr source not found — skipping");
    return;
  }

  // §2.6 repair: a relay-less source used to be skipped outright — permanently
  // dead ingest. Fall back to the broad fallback set at QUERY time instead
  // (never written to the row: the durable fix is the backfill's NIP-65
  // persistence; the fallbacks are a default, not discovered author data).
  const relayUrls = source.relay_urls?.length
    ? source.relay_urls
    : NOSTR_FALLBACK_RELAYS;

  // Load config (process-cached, 30s TTL — A5)
  const config = await getPlatformConfig();
  const maxItems = parseInt(
    config.get("feed_ingest_max_items_per_fetch") ?? "50",
    10,
  );
  const maxErrors = parseInt(
    config.get("feed_ingest_max_error_count") ?? "10",
    10,
  );
  const backoffFactor = parseInt(
    config.get("feed_ingest_error_backoff_factor") ?? "2",
    10,
  );

  // Parse cursor (created_at timestamp in seconds)
  const since = source.cursor
    ? parseInt(source.cursor, 10)
    : Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_SECONDS;

  const hexPubkey = source.source_uri;

  try {
    // Fetch events from all relay URLs, deduplicate by event ID
    const eventsMap = new Map<string, NostrEvent>();
    const deletionEvents: NostrEvent[] = [];
    const repostEvents = new Map<string, NostrEvent>();
    let latestProfile: NostrEvent | null = null;

    for (const relayUrl of relayUrls) {
      try {
        const wsOpts = await pinnedWebSocketOptions(relayUrl);
        const rawEvents = await fetchNostrRelayEvents(
          relayUrl,
          [
            {
              // 1 note, 5 deletion, 30023 long-form (THINGs); 6/16 reposts (edges).
              kinds: [1, 5, 6, 16, 30023],
              authors: [hexPubkey],
              since,
            },
            {
              // Kind 0 pulls the latest profile metadata without a `since`
              // filter; the loop below keeps only the newest one received.
              kinds: [0],
              authors: [hexPubkey],
              limit: 1,
            },
          ],
          wsOpts,
        );

        const validated = await validateNostrEvents(rawEvents, hexPubkey, {
          sourceId,
          relayUrl,
        });

        for (const event of validated) {
          if (!event) continue;
          if (event.kind === 5) {
            deletionEvents.push(event);
          } else if (event.kind === 0) {
            if (!latestProfile || event.created_at > latestProfile.created_at) {
              latestProfile = event;
            }
          } else if (event.kind === 6 || event.kind === 16) {
            // NIP-18 repost / generic repost → a RepostEdge, not a THING.
            repostEvents.set(event.id, event);
          } else {
            eventsMap.set(event.id, event);
          }
        }
      } catch (err) {
        logger.warn(
          {
            sourceId,
            relayUrl,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to fetch from relay — trying next",
        );
      }
    }

    // Sort by created_at DESC, cap at maxItems
    const events = [...eventsMap.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, maxItems);

    // Cap deletions too — a chatty relay with long delete history can otherwise
    // ship thousands of kind-5s per fetch cycle.
    const cappedDeletes = deletionEvents
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, maxItems);

    const sourceNip05 = nostrNip05(latestProfile);

    // Upsert events into external_items + feed_items
    let inserted = 0;
    let newestCreatedAt = since;

    let updated = 0;
    for (const event of events) {
      const outcome = await withTransaction(async (client) =>
        insertNostrItem(client, source, event, {
          relays: relayUrls,
          sourceNip05,
        }),
      );

      if (outcome === "inserted") inserted++;
      else if (outcome === "updated") updated++;
      if (event.created_at > newestCreatedAt)
        newestCreatedAt = event.created_at;
    }

    // Record NIP-18 reposts (kind 6/16) as edges. Pubkey + signature were
    // verified above, so event.pubkey === the source pubkey (the booster).
    let repostEdges = 0;
    for (const event of repostEvents.values()) {
      const repost = detectNostrRepost(event);
      if (!repost) continue;
      try {
        const created = await withTransaction(async (client) =>
          recordRepostEdge(client, repost),
        );
        if (created) repostEdges++;
      } catch (err) {
        logger.warn(
          {
            sourceId,
            eventId: event.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "Failed to record nostr repost edge",
        );
      }
      if (event.created_at > newestCreatedAt) newestCreatedAt = event.created_at;
    }

    // Handle kind 5 deletions (pubkey + signature verified above).
    await applyNostrDeletions(pool, sourceId, cappedDeletes, hexPubkey);

    // Kind-0 profile update, gated by the newest-wins metadata ratchet.
    const { profileName, profileAvatar, profileCreatedAt, profileDeleted } =
      nostrProfileUpdate(latestProfile, source.metadata_updated_at);

    // Author-level deletion tombstone (RESOLVER-DISCOVERY-ADR §8.3, migration
    // 151): a newer kind-0 with deleted:true stamps it; a newer kind-0 without
    // clears it (the account came back). Rides the same ratchet as the
    // metadata write, so a stale relay can't flap it.
    if (profileDeleted !== null) {
      await pool.query(
        `UPDATE external_authors
            SET deleted_at = CASE
              WHEN $2 THEN COALESCE(deleted_at, now())
              ELSE NULL
            END
          WHERE protocol = 'nostr_external' AND stable_handle = $1`,
        [hexPubkey, profileDeleted],
      );
    }

    // Update source: cursor, reset errors, optionally refresh display metadata.
    // metadata_updated_at only moves forward when we actually apply a profile
    // write, so the ratchet survives restarts.
    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at = now(),
        cursor = $2,
        error_count = 0,
        last_error = NULL,
        -- Reset the poll interval to the base (the error path backs off up to
        -- 300·factor^6 ≈ 19,200s; without this a recovered source stayed on
        -- its last backed-off interval forever — AP already resets on success).
        fetch_interval_seconds = 300,
        display_name = COALESCE($3, display_name),
        avatar_url = COALESCE($4, avatar_url),
        metadata_updated_at = CASE
          WHEN $5::bigint IS NOT NULL THEN to_timestamp($5::bigint)
          ELSE metadata_updated_at
        END,
        updated_at = now()
      WHERE id = $1
    `,
      [
        sourceId,
        String(newestCreatedAt),
        profileName,
        profileAvatar,
        profileCreatedAt,
      ],
    );

    if (inserted > 0 || updated > 0 || repostEdges > 0) {
      logger.info(
        {
          sourceId,
          inserted,
          updated,
          repostEdges,
          total: events.length,
          deletions: cappedDeletes.length,
        },
        "Nostr events ingested",
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const newErrorCount = source.error_count + 1;
    const shouldDeactivate = newErrorCount >= maxErrors;
    const backoffInterval =
      300 * Math.pow(backoffFactor, Math.min(newErrorCount, 6));

    await pool.query(
      `
      UPDATE external_sources SET
        last_fetched_at = now(),
        error_count = $2,
        last_error = $3,
        is_active = CASE WHEN $4 THEN FALSE ELSE is_active END,
        fetch_interval_seconds = $5,
        updated_at = now()
      WHERE id = $1
    `,
      [
        sourceId,
        newErrorCount,
        errorMessage.slice(0, 1000),
        shouldDeactivate,
        Math.round(backoffInterval),
      ],
    );

    if (shouldDeactivate) {
      logger.warn(
        { sourceId, errorCount: newErrorCount },
        "Nostr source deactivated after too many errors",
      );
    } else {
      logger.warn(
        { sourceId, errorCount: newErrorCount, err: errorMessage },
        "Nostr fetch failed",
      );
    }
  }
};
