import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { isSourceBlocked } from "@platform-pub/shared/lib/platform-blocks.js";
import { pinnedWebSocketOptions } from "@platform-pub/shared/lib/http-client.js";
import { recordRepostEdge } from "../lib/repost-edge.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import {
  recordRelayFailure,
  recordRelaySuccess,
  relayOnCooldown,
} from "../lib/relay-budget.js";
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

// =============================================================================
// The cap is a RESUME POINT, not a loss (MIRROR-AUDIT §3, S17).
//
// One `since` cursor governs every kind in the poll's first filter
// (1/5/6/16/30023), so it may never advance past an event this run declined to
// process. It used to. The three streams were capped SEPARATELY, each keeping
// the NEWEST maxItems, and the cursor was then set to the newest event seen —
// so a source that published more than maxItems inside one poll window had its
// OLDEST events dropped and the cursor moved beyond them. They were never
// fetched again: a silent permanent gap, and the busier the author the more of
// it. Nothing logged, nothing failed, and the feed simply had holes.
//
// Keeping the OLDEST maxItems inverts that. The cursor stops at the newest
// event actually processed and the next tick continues from exactly there.
// `since` is inclusive in NIP-01, so an event sharing the boundary second is
// re-fetched rather than skipped, and every writer downstream is idempotent.
//
// Three further properties the shape depends on:
//
//   • ONE pool, deduped by event id. deletionEvents arrives as a flat array
//     across relays, so the same kind-5 seen on three relays used to spend
//     three of the cap's slots.
//
//   • The cursor is a max over what was CONSIDERED, not over what was written.
//     A kind-6 that detectNostrRepost declines, or an event the published_at
//     ratchet skips, has still been seen; holding the cursor back for it means
//     a batch of nothing but those spins the source on one window for ever.
//
//   • The degenerate case: more than maxItems events sharing the boundary
//     second. The batch is then identical every run and the cursor cannot move
//     — the source stops ingesting for good, which is strictly worse than the
//     gap this exists to close. So step past that second and SAY SO. A skipped
//     window somebody can find in a log is not the silent drop it replaces.
// =============================================================================
export interface NostrPollPlan {
  /** The events to process this run, oldest first. */
  batch: NostrEvent[];
  /** How many the cap left behind for the next tick. */
  dropped: number;
  /** Where the cursor lands. Never below `since`. */
  cursor: number;
  /** True only in the degenerate case above — a window is being skipped. */
  skippedSecond: boolean;
}

export function planNostrPollBatch(
  governed: NostrEvent[],
  since: number,
  maxItems: number,
): NostrPollPlan {
  const byId = new Map<string, NostrEvent>();
  for (const e of governed) byId.set(e.id, e);
  const ordered = [...byId.values()].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
  );
  const batch = ordered.slice(0, Math.max(0, maxItems));
  const dropped = ordered.length - batch.length;

  let cursor = since;
  for (const e of batch) if (e.created_at > cursor) cursor = e.created_at;

  const skippedSecond = dropped > 0 && cursor <= since;
  if (skippedSecond) cursor = since + 1;

  return { batch, dropped, cursor, skippedSecond };
}

export const feedIngestNostr: Task = async (payload, _helpers) => {
  const { sourceId } = payload as { sourceId: string };
  // THE OPERATOR'S REFUSAL (L6.5, D7 §7). Checked per fetch rather than only at
  // the poll selector, because a job can be enqueued from several places (the
  // poll, a re-add, a backfill) and the guard has to sit where the work
  // actually happens. One indexed lookup against an HTTP fetch we are about to
  // spend.
  if (await isSourceBlocked(sourceId)) {
    logger.info({ sourceId }, "Source is blocked platform-wide — skipping fetch");
    return;
  }

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

    // A RELAY'S FAILURE IS A FACT ABOUT THE RELAY, AND IT IS STILL RECORDED
    // (CA-C3; `lib/relay-budget.ts` says why the two obvious fixes are
    // refused). Every relay outcome is collected here: a dropped relay is
    // skipped and named, a failure spends the RELAY's budget, and the poll's
    // own verdict — recorded on the source without touching its deactivation
    // count — is decided after the loop from what was tried.
    const relayFailures: string[] = [];
    let relaysTried = 0;
    let relaysAnswered = 0;

    for (const relayUrl of relayUrls) {
      if (relayOnCooldown(relayUrl)) {
        relayFailures.push(`${relayUrl} (dropped after repeated failures)`);
        continue;
      }
      relaysTried++;
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
        recordRelaySuccess(relayUrl);
        relaysAnswered++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const dropped = recordRelayFailure(relayUrl);
        relayFailures.push(`${relayUrl} (${msg})`);
        logger.warn(
          { sourceId, relayUrl, err: msg, dropped },
          dropped
            ? "Failed to fetch from relay — dropped for every source until its cooldown ends"
            : "Failed to fetch from relay — trying next",
        );
      }
    }

    // The poll's verdict. Some relays failed: the source is healthy (the rest
    // answered, the cursor is a max over what they returned) and the failure
    // is RECORDED in last_error so a member's quiet feed can be diagnosed.
    // Every relay failed, or every relay was on cooldown: nothing was read,
    // the cursor floors at `since` by `planNostrPollBatch`'s contract, and the
    // interval backs off — doubling on the column itself, capped where the
    // error path caps — WITHOUT spending error_count, because a relay outage
    // must never deactivate the sources that happen to share that relay.
    const allRelaysFailed = relaysAnswered === 0;
    const relayError =
      relayFailures.length > 0
        ? `${
            allRelaysFailed
              ? "no relay answered"
              : `${relayFailures.length}/${relayUrls.length} relays failed`
          }: ${relayFailures.join("; ")}`.slice(0, 1000)
        : null;
    if (allRelaysFailed) {
      logger.warn(
        { sourceId, relays: relayUrls.length, tried: relaysTried },
        "Nostr poll: no relay answered — backing off without spending the source's error budget",
      );
    }

    // One cap over the whole cursor-governed set, OLDEST first — see
    // planNostrPollBatch, which owns the rule and is tested directly.
    const plan = planNostrPollBatch(
      [...eventsMap.values(), ...deletionEvents, ...repostEvents.values()],
      since,
      maxItems,
    );
    const events = plan.batch.filter(
      (e) => e.kind !== 5 && e.kind !== 6 && e.kind !== 16,
    );
    const cappedDeletes = plan.batch.filter((e) => e.kind === 5);
    const cappedReposts = plan.batch.filter((e) => e.kind === 6 || e.kind === 16);
    const newestCreatedAt = plan.cursor;

    const sourceNip05 = nostrNip05(latestProfile);

    // Upsert events into external_items + feed_items
    let inserted = 0;

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
    }

    // Record NIP-18 reposts (kind 6/16) as edges. Pubkey + signature were
    // verified above, so event.pubkey === the source pubkey (the booster).
    let repostEdges = 0;
    for (const event of cappedReposts) {
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

    if (plan.skippedSecond) {
      logger.warn(
        { sourceId, since, dropped: plan.dropped, maxItems },
        "Nostr poll: more than maxItems events share the cursor second — advancing past it; the remainder of that second is skipped",
      );
    } else if (plan.dropped > 0) {
      logger.info(
        { sourceId, dropped: plan.dropped, resumeAt: plan.cursor },
        "Nostr poll: capped at maxItems — resuming from the newest event processed",
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
        -- error_count is the DEACTIVATION budget and a relay's failure never
        -- spends it; last_error still carries what failed (CA-C3).
        error_count = 0,
        last_error = $6,
        -- Reset the poll interval to the base (the error path backs off up to
        -- 300·factor^6 ≈ 19,200s; without this a recovered source stayed on
        -- its last backed-off interval forever — AP already resets on success)
        -- — unless NO relay answered, in which case the interval doubles on
        -- itself up to that same cap: a backoff with no counter behind it,
        -- because the only counter is the one a relay outage must not touch.
        fetch_interval_seconds = CASE
          WHEN $7 THEN LEAST(fetch_interval_seconds * 2, 19200)
          ELSE 300
        END,
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
        relayError,
        allRelaysFailed,
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
