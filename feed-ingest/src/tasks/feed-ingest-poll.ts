import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../lib/platform-config.js";

// =============================================================================
// feed_ingest_poll — scheduled every 60 seconds
//
// Finds external_sources that are due for polling and enqueues per-source
// fetch jobs. Enforces per-host concurrency limits to be a good citizen.
// =============================================================================

export const feedIngestPoll: Task = async (_payload, helpers) => {
  // Load config values (process-cached, 30s TTL — A5)
  const config = await getPlatformConfig();
  const maxPerHost =
    parseInt(config.get("feed_ingest_max_per_host") ?? "", 10) || 2;
  // Per-tick enqueue cap (audit #1 / C2). This bounds how many fetch jobs the
  // poll enqueues per 60s tick — NOT how many run at once. Actual fetch
  // concurrency is the worker runner's `concurrency` (index.ts) plus the
  // per-source `jobKey` (one in-flight job per source); per-host politeness is
  // `maxPerHost` (≤N/host/tick), preserved below. The two were historically
  // conflated at 10, which capped steady-state throughput at ~10/min ≈ 50
  // sources before they fell behind. Decoupled: default 100 (= the SELECT
  // LIMIT, i.e. enqueue all due sources each tick) so the ceiling is gone.
  //
  // The default is 100 in code, NOT via the `feed_ingest_max_enqueue_per_tick`
  // seed (migration 106): that seed is config-only and absent from schema.sql,
  // so it never lands on a schema.sql-bootstrapped DB (dev initdb / fresh prod)
  // while `_migrations` marks 106 applied — migrate.ts then skips it (audit D1).
  // We must NOT fall back to the legacy `feed_ingest_max_concurrent` (seeded at
  // 10 on existing DBs): that resurrects the very coupling 106 set out to remove
  // and silently pins throughput at 10. Honour an explicit per-tick override if
  // an operator sets one; otherwise 100, unconditionally.
  const maxEnqueuePerTick =
    parseInt(config.get("feed_ingest_max_enqueue_per_tick") ?? "", 10) || 100;
  // atproto sources are normally pushed by the Jetstream listener. Only
  // fall back to polling via getAuthorFeed if the listener has reported
  // itself unhealthy — otherwise we'd duplicate work.
  const jetstreamHealthy = config.get("jetstream_healthy") !== "false";

  // Find sources due for polling, capped per host IN THE SELECTION
  // (FOLLOW-GRAPH-IMPORT-ADR §6.4a). The per-host cap used to be applied only
  // in JS, AFTER a flat `ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 100`
  // — so a large single-host backlog (a 500-follow Mastodon import) filled the
  // whole selection window with its own rows every tick, the JS cap passed 2
  // of them, and the tick enqueued ~2 jobs SYSTEM-WIDE (all protocols, all
  // users) until that backlog drained. The window function caps each host's
  // contribution to the window itself, so other hosts' due sources stay
  // selectable. Host extraction mirrors the JS grouping below: first relay
  // hostname for nostr, else the source URI hostname, else the raw URI
  // (DIDs/pubkeys group as themselves).
  const { rows: sources } = await pool.query<{
    id: string;
    protocol: string;
    source_uri: string;
    relay_urls: string[] | null;
  }>(
    `
    WITH due AS (
      SELECT id, protocol, source_uri, relay_urls, last_fetched_at,
        COALESCE(
          substring(
            CASE WHEN protocol = 'nostr_external'
                   AND relay_urls IS NOT NULL AND array_length(relay_urls, 1) > 0
                 THEN relay_urls[1]
                 ELSE source_uri
            END
            FROM '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)'
          ),
          source_uri
        ) AS host
      FROM external_sources
      WHERE is_active = TRUE
        AND protocol != 'email'
        AND (protocol != 'atproto' OR $1::boolean = FALSE)
        AND (
          last_fetched_at IS NULL
          OR last_fetched_at + (fetch_interval_seconds || ' seconds')::interval <= now()
        )
    ),
    ranked AS (
      SELECT id, protocol, source_uri, relay_urls, last_fetched_at,
             row_number() OVER (
               PARTITION BY host
               ORDER BY last_fetched_at ASC NULLS FIRST, id ASC
             ) AS host_rank
      FROM due
    )
    SELECT id, protocol, source_uri, relay_urls
    FROM ranked
    WHERE host_rank <= $2
    ORDER BY last_fetched_at ASC NULLS FIRST, id ASC
    LIMIT 100
  `,
    [jetstreamHealthy, maxPerHost],
  );

  if (sources.length === 0) return;

  // Group by hostname for rate limiting
  // RSS: group by feed URL hostname
  // Nostr: group by first relay URL hostname (rate limit per relay, not per pubkey)
  const byHost = new Map<string, typeof sources>();
  for (const source of sources) {
    let hostname: string;
    if (
      source.protocol === "nostr_external" &&
      source.relay_urls &&
      source.relay_urls.length > 0
    ) {
      try {
        hostname = new URL(source.relay_urls[0]).hostname;
      } catch {
        hostname = source.source_uri;
      }
    } else {
      try {
        hostname = new URL(source.source_uri).hostname;
      } catch {
        hostname = source.source_uri;
      }
    }
    const group = byHost.get(hostname) ?? [];
    group.push(source);
    byHost.set(hostname, group);
  }

  // Enqueue jobs respecting per-host and global limits.
  //
  // Every drop below is counted and logged (§7.7): a source that silently fails
  // to be enqueued is indistinguishable from one that has nothing to fetch, so a
  // host starving behind the cap looked identical to a healthy idle host. The
  // counters make the cap visible without changing what it does.
  let totalEnqueued = 0;
  let skippedByHostCap = 0;
  let skippedByTickCap = 0;
  let skippedNoTask = 0;
  const hostsCapped = new Set<string>();
  for (const [hostname, hostSources] of byHost) {
    const toEnqueue = hostSources.slice(0, maxPerHost);
    if (hostSources.length > toEnqueue.length) {
      skippedByHostCap += hostSources.length - toEnqueue.length;
      hostsCapped.add(hostname);
    }
    for (const source of toEnqueue) {
      if (totalEnqueued >= maxEnqueuePerTick) {
        skippedByTickCap += toEnqueue.length - toEnqueue.indexOf(source);
        break;
      }

      const taskName =
        source.protocol === "rss"
          ? "feed_ingest_rss"
          : source.protocol === "nostr_external"
            ? "feed_ingest_nostr"
            : source.protocol === "activitypub"
              ? "feed_ingest_activitypub"
              : source.protocol === "atproto" && !jetstreamHealthy
                ? "feed_ingest_atproto_backfill"
                : null;
      if (!taskName) {
        skippedNoTask++;
        continue;
      }

      await helpers.addJob(
        taskName,
        { sourceId: source.id },
        {
          jobKey: `feed_ingest_${source.id}`,
          maxAttempts: 1,
        },
      );
      totalEnqueued++;
    }
    if (totalEnqueued >= maxEnqueuePerTick) break;
  }

  const totalSkipped = skippedByHostCap + skippedByTickCap + skippedNoTask;
  if (totalEnqueued > 0 || totalSkipped > 0) {
    logger.info(
      {
        count: totalEnqueued,
        ...(totalSkipped > 0
          ? {
              skippedByHostCap,
              skippedByTickCap,
              skippedNoTask,
              // Named so a persistently-starved host is greppable, not just a
              // number that moves.
              hostsCapped: [...hostsCapped],
              maxPerHost,
              maxEnqueuePerTick,
            }
          : {}),
      },
      "Enqueued feed ingest jobs",
    );
  }

  await writeIngestHeartbeat();
};

// ---------------------------------------------------------------------------
// The ingest heartbeat (prod incident 2026-08-11).
//
// feed-ingest was stopped by a stray SIGTERM at 14:07 UTC and nothing brought
// it back. Every other container stayed green, /health stayed green, and the
// platform's entire content pipeline was dead for 21 hours — found only because
// the operator noticed their own feeds were stale. Nothing anywhere said "the
// ingest worker is not running", because nothing was watching for an ABSENCE.
//
// So: this task, which runs every 60 seconds, stamps the clock. The gateway's
// admin overview reads its AGE, and staleness is the alarm.
//
// WHY THE ABSENCE AND NOT A CLAIM. jetstream_healthy is the counter-example
// living in this same table: a boolean the listener sets false when it knows it
// is unwell, which is worthless for the failures where it cannot know or is not
// running at all. A timestamp inverts that — a stopped worker writes nothing,
// and nothing is exactly what raises the alarm. There is no state in which a
// dead process reports itself alive.
//
// It sits at the END of the task deliberately: it then means "a scheduled task
// ran to completion", not merely "a process exists". A poll that throws every
// tick leaves the heartbeat stale, which is the truth an operator needs.
//
// Runtime STATE, not a dial — so, like payouts_halted, it is deliberately NOT
// in config-defaults.sql and is refused by the admin config editor. UPSERT, not
// UPDATE: a bare UPDATE matches zero rows when the key is absent and reports no
// error, which is exactly how jetstream_healthy silently never persisted.
async function writeIngestHeartbeat(): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO platform_config (key, value, description, updated_at)
       VALUES ('feed_ingest_heartbeat', now()::text,
               'Runtime state: when the feed-ingest poll last completed. Written every 60s; its AGE is the ingest liveness alarm on /admin/overview. Not a dial.',
               now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
  } catch (err) {
    // Never fail the tick over the heartbeat. A throw here would make graphile
    // retry a poll that already did its work, and re-enqueue every due source.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to write feed-ingest heartbeat",
    );
  }
}
