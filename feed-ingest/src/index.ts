import "dotenv/config";
import { run, parseCrontab } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import {
  trustSystemEnabled,
  identityLinkDetectEnabled,
} from "@platform-pub/shared/lib/env.js";
import { feedIngestPoll } from "./tasks/feed-ingest-poll.js";
import { feedIngestRss } from "./tasks/feed-ingest-rss.js";
import { feedIngestNostr } from "./tasks/feed-ingest-nostr.js";
import { externalItemsPrune } from "./tasks/external-items-prune.js";
import { sourceMetadataRefresh } from "./tasks/source-metadata-refresh.js";
import { feedItemsReconcile } from "./tasks/feed-items-reconcile.js";
import { feedItemsAuthorRefresh } from "./tasks/feed-items-author-refresh.js";
import { feedIngestAtprotoBackfill } from "./tasks/feed-ingest-atproto-backfill.js";
import { feedIngestNostrBackfill } from "./tasks/feed-ingest-nostr-backfill.js";
import { feedIngestActivityPub } from "./tasks/feed-ingest-activitypub.js";
import { outboundCrossPost } from "./tasks/outbound-cross-post.js";
import { outboundTokenRefresh } from "./tasks/outbound-token-refresh.js";
import { atprotoOauthStatesPrune } from "./tasks/atproto-oauth-states-prune.js";
import { activityPubInstanceHealthPrune } from "./tasks/activitypub-instance-health-prune.js";
import { resolverResultsPrune } from "./tasks/resolver-results-prune.js";
import { externalSourcesGc } from "./tasks/external-sources-gc.js";
import { feedScoresRefresh } from "./tasks/feed-scores-refresh.js";
import { trustLayer1Refresh } from "./tasks/trust-layer1-refresh.js";
import { trustEpochAggregate } from "./tasks/trust-epoch-aggregate.js";
import { relayPublish } from "./tasks/relay-publish.js";
import { relayOutboxRedrive } from "./tasks/relay-outbox-redrive.js";
import { relayOutboxReconcile } from "./tasks/relay-outbox-reconcile.js";
import { relayOutboxPrune } from "./tasks/relay-outbox-prune.js";
import { externalEngagementRefresh } from "./tasks/external-engagement-refresh.js";
import { engagementBaselineRefresh } from "./tasks/engagement-baseline-refresh.js";
import { externalParentPrefetch } from "./tasks/external-parent-prefetch.js";
import { externalContextGc } from "./tasks/external-context-gc.js";
import { feedIngestEmail } from "./tasks/feed-ingest-email.js";
import { identityLinkDetect } from "./tasks/identity-link-detect.js";
import { JetstreamListener } from "./jetstream/listener.js";

// =============================================================================
// Feed Ingest Worker
//
// Background job runner using Graphile Worker. No HTTP server — pure
// background processing. All jobs use the shared PostgreSQL connection.
//
// Scheduled jobs:
//   feed_ingest_poll        — find sources due for polling, enqueue per-source jobs
//   external_items_prune    — delete expired external items (daily)
//   source_metadata_refresh — refresh source display metadata (daily)
//
// Reactive jobs (queued by poll or gateway):
//   feed_ingest_rss         — fetch + parse a single RSS source
// =============================================================================

async function start() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.error("DATABASE_URL is required");
    process.exit(1);
  }

  // Trust is parked by default (architecture-audit item 7): when
  // TRUST_SYSTEM_ENABLED is off we simply don't register the three trust
  // schedules, which is the bulk of the parked compute. The task handlers stay
  // registered in taskList below so any already-queued job still resolves; only
  // the recurring schedules are withheld.
  const trustOn = trustSystemEnabled();
  // Slice 8 P3: the cross-source identity-link detection cron ships dark — only
  // schedule it when the operator switch is on (it writes global links that
  // suppress duplicates in everyone's feed). Handler stays registered below so a
  // manually-queued run still resolves.
  const identityDetectOn = identityLinkDetectEnabled();
  const cronItems: string[] = [
    // Poll for sources due for fetching — every 60 seconds
    "* * * * * feed_ingest_poll",
    // Prune old external items — daily at 02:15 UTC
    "15 2 * * * external_items_prune",
    // Refresh source metadata — daily at 03:00 UTC
    "0 3 * * * source_metadata_refresh",
    // Refresh denormalised author metadata in feed_items — daily at 04:00 UTC
    "0 4 * * * feed_items_author_refresh",
    // Reconcile feed_items with source tables — daily at 05:00 UTC
    "0 5 * * * feed_items_reconcile",
    // Refresh expiring OAuth tokens for linked accounts — every 30 min
    "*/30 * * * * outbound_token_refresh",
    // Prune expired atproto OAuth pending states — every 5 min
    "*/5 * * * * atproto_oauth_states_prune",
    // Prune expired resolver Phase B results — every 5 min
    "*/5 * * * * resolver_results_prune",
    // Garbage-collect orphaned external_sources — daily at 06:00 UTC
    "0 6 * * * external_sources_gc",
    // Prune dormant activitypub_instance_health rows — weekly Sun 07:00 UTC
    "0 7 * * 0 activitypub_instance_health_prune",
    // Refresh feed_items.score from engagement — every 5 minutes
    "*/5 * * * * feed_scores_refresh",
    ...(trustOn
      ? [
          // Recompute Layer 1 trust signals — daily at 01:00 UTC
          "0 1 * * * trust_layer1_refresh",
          // Trust epoch aggregation — quarterly full epoch (1 Jan/Apr/Jul/Oct)
          "0 2 1 1,4,7,10 * trust_epoch_aggregate ?id=trust_epoch_full",
          // Trust mop-up scoring — Mon/Thu at 02:00 UTC
          "0 2 * * 1,4 trust_epoch_aggregate ?id=trust_epoch_mopup",
        ]
      : []),
    // Relay outbox second heartbeat — every minute
    "* * * * * relay_outbox_redrive",
    // Relay outbox queue metrics — daily at 04:30 UTC
    "30 4 * * * relay_outbox_reconcile",
    // Prune sent relay_outbox entries older than 30 days — daily at 03:30 UTC
    "30 3 * * * relay_outbox_prune",
    // Refresh engagement counts on recent external items — every 30 min
    "*/30 * * * * external_engagement_refresh",
    // Rebuild author engagement baselines + network ambient — daily at 04:45
    // UTC, after external_engagement_refresh's 04:00 full <7d sweep so the
    // medians see that run's counts (SOCIAL-PROOF-RESONANCE-ADR D3)
    "45 4 * * * engagement_baseline_refresh",
    // Garbage-collect unreferenced context-only external items — daily at 02:30 UTC
    "30 2 * * * external_context_gc",
    ...(identityDetectOn
      ? [
          // Detect cross-source identity links from stored metadata — daily 06:30 UTC
          "30 6 * * * identity_link_detect",
        ]
      : []),
  ];

  const runner = await run({
    connectionString,
    concurrency: 10,
    noHandleSignals: false,
    pollInterval: 2000,
    parsedCronItems: parseCrontab(cronItems.join("\n")),
    taskList: {
      feed_ingest_poll: feedIngestPoll,
      feed_ingest_rss: feedIngestRss,
      feed_ingest_nostr: feedIngestNostr,
      external_items_prune: externalItemsPrune,
      source_metadata_refresh: sourceMetadataRefresh,
      feed_items_reconcile: feedItemsReconcile,
      feed_items_author_refresh: feedItemsAuthorRefresh,
      feed_ingest_atproto_backfill: feedIngestAtprotoBackfill,
      feed_ingest_nostr_backfill: feedIngestNostrBackfill,
      feed_ingest_activitypub: feedIngestActivityPub,
      outbound_cross_post: outboundCrossPost,
      outbound_token_refresh: outboundTokenRefresh,
      atproto_oauth_states_prune: atprotoOauthStatesPrune,
      activitypub_instance_health_prune: activityPubInstanceHealthPrune,
      resolver_results_prune: resolverResultsPrune,
      external_sources_gc: externalSourcesGc,
      feed_scores_refresh: feedScoresRefresh,
      trust_layer1_refresh: trustLayer1Refresh,
      trust_epoch_aggregate: trustEpochAggregate,
      relay_publish: relayPublish,
      relay_outbox_redrive: relayOutboxRedrive,
      relay_outbox_reconcile: relayOutboxReconcile,
      relay_outbox_prune: relayOutboxPrune,
      external_engagement_refresh: externalEngagementRefresh,
      engagement_baseline_refresh: engagementBaselineRefresh,
      external_parent_prefetch: externalParentPrefetch,
      external_context_gc: externalContextGc,
      feed_ingest_email: feedIngestEmail,
      identity_link_detect: identityLinkDetect,
    },
  });

  logger.info(
    { trustSchedulesRegistered: trustOn, identityLinkDetectScheduled: identityDetectOn },
    trustOn
      ? "Feed ingest worker started"
      : "Feed ingest worker started (trust schedules parked — TRUST_SYSTEM_ENABLED off)",
  );

  // Start the Bluesky Jetstream listener alongside the Graphile runner.
  // It maintains its own WebSocket; nothing to await on startup.
  const jetstream = new JetstreamListener();
  await jetstream.start();

  // Shutdown runs TWICE on every SIGTERM, and must be idempotent.
  //
  // graphile-worker installs its own signal handlers: on SIGTERM it stops the
  // runner itself and then re-raises SIGTERM on this process ("killing self via
  // SIGTERM"), which re-enters this handler 12ms later. The second pass then
  // called runner.stop() on an already-stopped runner, graphile threw `Runner is
  // already stopped`, and the process died on an UNCAUGHT EXCEPTION rather than
  // exiting — taking the rest of this handler with it. That is not cosmetic:
  // everything after runner.stop() is the orderly part (pool.end, and inside
  // jetstream.stop the final cursor flush and the advisory-lock release), so a
  // routine `docker compose stop` lost cursor progress and left the leader lock
  // to be reclaimed by session death instead of released.
  //
  // Observed on prod 2026-08-11 14:07 UTC. The SIGTERM itself is what stopped
  // ingest for 21 hours — this handler is not why it stayed down — but a
  // shutdown path that crashes on its own second invocation is a fault of its
  // own, and it fired on every restart the platform has ever done.
  //
  // A single guard, not a try/catch per call: re-entering at all is the bug, and
  // the second pass has nothing left to do that the first did not already do.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.debug({ signal }, "Shutdown already in progress — ignoring signal");
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "Shutting down feed-ingest worker");
    try {
      await jetstream.stop();
      await runner.stop();
      await pool.end();
    } catch (err) {
      // Exit anyway. A shutdown that throws must still be a shutdown, or the
      // container ends on an uncaught exception whose stack buries the signal
      // that caused it — which is exactly how the prod crash above read.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), signal },
        "Error during feed-ingest shutdown — exiting regardless",
      );
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await runner.promise;
}

start().catch((err) => {
  logger.error({ err }, "Failed to start feed-ingest worker");
  process.exit(1);
});
