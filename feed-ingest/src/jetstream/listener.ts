import { WebSocket } from "ws";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { pinnedWebSocketOptions } from "@platform-pub/shared/lib/http-client.js";
import { ADVISORY_LOCKS } from "@platform-pub/shared/lib/advisory-locks.js";
import {
  normaliseAtprotoCommit,
  detectAtprotoRepostFromCommit,
  buildAtUri,
  type JetstreamCommit,
} from "../adapters/atproto.js";
import { insertAtprotoItem } from "../lib/atproto-ingest.js";
import { sourceBlockedSql } from "@platform-pub/shared/lib/platform-blocks.js";
import { ATPROTO_ENRICH_FAILED_ERROR } from "../tasks/feed-ingest-atproto-backfill.js";
import { recordRepostEdge } from "../lib/repost-edge.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { SilenceWatchdog, attachLiveness } from "./silence-watchdog.js";
import {
  resumeFrom,
  watermarkAfterFlush,
  type ResumePoint,
} from "./resume-cursor.js";

// =============================================================================
// Jetstream listener
//
// A long-lived WebSocket subscriber to the Bluesky Jetstream firehose. See
// docs/adr/UNIVERSAL-FEED-ADR.md §V.3 and §VI.3.
//
// Responsibilities:
//   - Maintain a persistent connection filtered to the set of DIDs we have
//     active external_sources for, and to app.bsky.feed.post events only.
//   - Re-check the DID set every 60s; reconnect with updated filter when it
//     changes. Jetstream does not support dynamic subscription updates.
//   - Persist per-source time_us cursors so restarts resume without gaps.
//   - Dual-write ingested posts into external_items + feed_items in one
//     transaction, using ON CONFLICT DO NOTHING for idempotency.
//   - Set deleted_at on posts that receive a delete commit.
//   - Update platform_config.jetstream_healthy so the RSS-style polling
//     fallback can kick in if the listener is wedged.
//
// Connection lifecycle:
//   - No active DIDs → no connection. Poll loop keeps checking.
//   - New DID appears → connect.
//   - DID set changes while connected → reconnect with new filter.
//   - WebSocket error/close → exponential backoff, reconnect.
//   - WebSocket alive but SILENT past the keepalive window → terminate and
//     reconnect (silence-watchdog.ts). A half-open socket emits neither error
//     nor close, so without this the listener would wait on one forever — and
//     it is also why jetstream_healthy could never reach `false`, since only
//     the close path writes it.
//
// TWO FAILURES THAT LOOK IDENTICAL FROM THE DATABASE, and only one of them is
// the socket's fault. Both present as "connected, ingesting nothing":
//   · a half-open socket — no frames at all. The watchdog above.
//   · an over-deep resume — frames pouring in, every one a duplicate we already
//     hold, so nothing inserts and no cursor moves. resume-cursor.ts. The
//     watchdog cannot see this one and must not try to: the socket is genuinely
//     healthy and working hard.
// The way to tell them apart from outside is bytes on the wire, not rows in the
// table (`/proc/net/dev` inside the container: ~4 MB/s means replay, ~0 means
// wedge).
// =============================================================================

const DEFAULT_JETSTREAM_URL = "wss://jetstream1.us-east.bsky.network/subscribe";
// Posts become THINGs; reposts become RepostEdges (UNIVERSAL-POST §2.2 / Phase 0c).
const WANTED_COLLECTIONS = ["app.bsky.feed.post", "app.bsky.feed.repost"];
const DID_REFRESH_INTERVAL_MS = 60_000;
const INITIAL_BACKOFF_MS = 1000;
// Session-scoped advisory lock key. Only one feed-ingest replica at a time
// runs the Jetstream WebSocket; others poll for the lock. See
// shared/src/lib/advisory-locks.ts for the full registry.
const JETSTREAM_LOCK_KEY = ADVISORY_LOCKS.JETSTREAM;
const LEADER_POLL_MS = 30_000;

// Jetstream puts every DID in the upgrade URL as a `wantedDids=` query param.
// Most reverse proxies and WebSocket servers cap the upgrade URL around
// 8-16 KB; each DID contributes ~40 bytes (including the param name + `=`
// + URL encoding), so the server filter tops out around 150-200 DIDs. Above
// this we subscribe to the wildcard firehose (still scoped to
// app.bsky.feed.post via wantedCollections) and filter DIDs client-side
// using sourceByDid. Bandwidth goes up but the platform scales past 200
// Bluesky subscriptions without sharding.
const WILDCARD_DID_THRESHOLD = 150;

// The pin's default URL cap is 2048 chars — far below a filtered upgrade URL
// carrying up to WILDCARD_DID_THRESHOLD-1 DIDs (~48 chars each URL-encoded, so
// ~7 KB at 149 DIDs). Without a larger cap `pinnedWebSocketOptions` throws for
// any DID set past ~40, and since wildcard mode only engages at 150, every atproto
// deployment between ~40 and 149 active sources could NEVER connect — connect()
// threw, was caught, and retried the identical over-length URL forever, degrading
// all Bluesky ingest to the delete-blind poll fallback (H11). 16 KB covers 149
// DIDs and sits at the documented server upgrade-URL ceiling; past 150 the URL
// carries no wantedDids at all, so this cap never binds in wildcard mode.
const JETSTREAM_MAX_URL_LENGTH = 16384;

// Cursor write batching (#5 / B2). The per-event cursor UPDATE used to fire one
// row-update to external_sources for every ingested post — in wildcard mode,
// one write per matched event off the firehose. Instead we accumulate the
// max(time_us) per source in memory and flush a single batched UPDATE every
// CURSOR_FLUSH_MS, or sooner once CURSOR_FLUSH_EVENT_THRESHOLD events pile up.
// The GREATEST guard keeps it idempotent; on crash we lose at most one flush
// window of cursor progress, re-ingested (and deduped) on the next resume.
const CURSOR_FLUSH_MS = 5_000;
const CURSOR_FLUSH_EVENT_THRESHOLD = 500;

// Half-open-socket detection (see silence-watchdog.ts for the incident and the
// measurement behind these numbers). Jetstream sends its own ping every 30s and
// pongs ours in ~100ms, so 90s of TOTAL inbound silence — three missed
// keepalives plus two unanswered probes of our own — is a wedged socket and not
// a quiet subscription. Not dials: they describe the protocol's measured
// keepalive behaviour, not a preference to be tuned per deployment.
const HEARTBEAT_INTERVAL_MS = 30_000;
const SILENCE_TIMEOUT_MS = 90_000;

// Replay cap fallback; canonical value in config-defaults.sql, held in step by
// feed-ingest/tests/config-fallback-parity.test.ts. A day covers any outage
// worth replaying through the firehose — longer belongs to the per-source
// backfill, which fetches one account's history instead of the network's.
const MAX_REPLAY_HOURS_FALLBACK = 24;

/**
 * The replay cap, from the dial. Exported so the fallback-parity suite can
 * drive the REAL read path against an empty config rather than a copy of the
 * number — a drifted fallback never errors, it substitutes silently, in exactly
 * the case it exists for.
 */
export async function loadMaxReplayHours(): Promise<number> {
  const config = await getPlatformConfig();
  const parsed = parseInt(
    config.get("feed_ingest_atproto_max_replay_hours") ?? "",
    10,
  );
  // `> 0` and not merely finite: a 0 or negative cap would resume from now or
  // the future, which is the silent-stream state resume-cursor.ts guards.
  return parsed > 0 ? parsed : MAX_REPLAY_HOURS_FALLBACK;
}

type SourceRow = {
  id: string;
  source_uri: string;
  cursor: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export class JetstreamListener {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private currentDids: Set<string> = new Set();
  private sourceByDid: Map<string, SourceRow> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private didRefreshTimer: NodeJS.Timeout | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private maxBackoffMs = 30_000;
  private stopping = false;
  private healthy = false;
  private leaderClient: PoolClient | null = null;
  private leaderPollTimer: NodeJS.Timeout | null = null;
  private isLeader = false;
  // Per-source max(time_us) awaiting a batched durable flush (#5 / B2).
  private pendingCursors: Map<string, bigint> = new Map();
  private cursorFlushTimer: NodeJS.Timeout | null = null;
  private eventsSinceFlush = 0;
  private watchdog: SilenceWatchdog | null = null;
  // The one global stream position (CA-C7; resume-cursor.ts says why). Loaded
  // at start, advanced in memory as each flush lands, null until the first
  // flush ever written — when the per-source cursors are the fallback.
  private watermark: bigint | null = null;
  // The oldest time_us whose ingest FAILED since the last resume: the
  // watermark is held below it, and a resume at or below it clears it.
  private failedFloor: bigint | null = null;

  constructor(url?: string) {
    this.url = url ?? process.env.JETSTREAM_URL ?? DEFAULT_JETSTREAM_URL;
  }

  async start(): Promise<void> {
    logger.info({ url: this.url }, "Jetstream listener starting");
    await this.loadMaxBackoff();
    await this.loadWatermark();
    // Try to claim leadership immediately; if another replica holds the lock,
    // poll periodically until it's released.
    await this.tryBecomeLeader();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.watchdog?.stop();
    if (this.didRefreshTimer) clearTimeout(this.didRefreshTimer);
    if (this.leaderPollTimer) clearTimeout(this.leaderPollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    // Persist any cursor progress accumulated since the last flush before we
    // give up leadership.
    await this.flushCursors();
    await this.releaseLeadership();
    await this.setHealthy(false);
    logger.info("Jetstream listener stopped");
  }

  // --- Leader election --------------------------------------------------------
  //
  // Jetstream state (cursor, DID filter) is global; running it on >1 replica
  // produces duplicate ingestion and cursor contention. Use a session-scoped
  // advisory lock: whichever replica holds it is the sole listener. Others
  // poll until the holder dies and releases.

  private async tryBecomeLeader(): Promise<void> {
    if (this.stopping || this.isLeader) return;
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Leader election: pool.connect failed",
      );
      this.schedulePollRetry();
      return;
    }
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [JETSTREAM_LOCK_KEY],
      );
      if (rows[0]?.locked) {
        this.leaderClient = client;
        this.isLeader = true;
        logger.info("Jetstream leader elected — starting listener");
        await this.refreshDids();
        this.scheduleDidRefresh();
        return;
      }
      // Lock held elsewhere — release the client and poll again later.
      client.release();
      this.schedulePollRetry();
    } catch (err) {
      try {
        client.release();
      } catch {
        /* ignore */
      }
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Leader election attempt failed",
      );
      this.schedulePollRetry();
    }
  }

  private schedulePollRetry(): void {
    if (this.stopping) return;
    this.leaderPollTimer = setTimeout(() => {
      this.leaderPollTimer = null;
      this.tryBecomeLeader().catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "Leader election poll failed",
        ),
      );
    }, LEADER_POLL_MS);
  }

  private async releaseLeadership(): Promise<void> {
    if (!this.leaderClient) return;
    // A failed unlock on a SURVIVING session must not return the lock-holding
    // connection to the pool (no later election could ever win it back), so
    // the client is released WITH the error and pg-pool destroys it — closing
    // the session is what frees the lock.
    let unlockErr: Error | undefined;
    try {
      await this.leaderClient.query("SELECT pg_advisory_unlock($1)", [
        JETSTREAM_LOCK_KEY,
      ]);
    } catch (err) {
      unlockErr = err instanceof Error ? err : new Error(String(err));
    }
    try {
      this.leaderClient.release(unlockErr);
    } catch {
      /* ignore */
    }
    this.leaderClient = null;
    this.isLeader = false;
  }

  // Self-scheduling DID refresh. Using setTimeout (rather than setInterval)
  // guarantees the next tick only fires after the previous one resolves, so a
  // slow DB query cannot stack up overlapping reconnects.
  private scheduleDidRefresh(): void {
    if (this.stopping || !this.isLeader) return;
    this.didRefreshTimer = setTimeout(() => {
      this.didRefreshTimer = null;
      this.refreshDids()
        .catch((err) => logger.warn({ err: err.message }, "DID refresh failed"))
        .finally(() => this.scheduleDidRefresh());
    }, DID_REFRESH_INTERVAL_MS);
  }

  private async loadWatermark(): Promise<void> {
    try {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM platform_config WHERE key = 'jetstream_cursor'`,
      );
      const raw = rows[0]?.value;
      if (!raw) return;
      const v = BigInt(raw);
      if (v > 0n) this.watermark = v;
    } catch (err) {
      // Malformed or unreadable: the per-source cursors are the fallback, as
      // before this key existed. Never a reason not to start.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Jetstream watermark could not be read — resuming from per-source cursors",
      );
    }
  }

  private async loadMaxBackoff(): Promise<void> {
    // Process-cached, 30s TTL (A5)
    const config = await getPlatformConfig();
    const parsed = parseInt(
      config.get("feed_ingest_atproto_reconnect_max_seconds") ?? "30",
      10,
    );
    if (!isNaN(parsed) && parsed > 0) this.maxBackoffMs = parsed * 1000;
  }

  // --- DID set management -----------------------------------------------------

  private async refreshDids(): Promise<void> {
    // Flush pending cursor progress before reloading rows, otherwise the fresh
    // sourceByDid would carry stale (older) cursors and resumePoint() could
    // rewind on the next reconnect.
    await this.flushCursors();

    const { rows } = await pool.query<SourceRow>(`
      SELECT id, source_uri, cursor, handle, display_name, avatar_url
      FROM external_sources es
      WHERE protocol = 'atproto' AND is_active = TRUE
        -- The operator's refusal (L6.5, D7 §7). Jetstream is a PUSH path with
        -- no per-source job to guard, so the block is applied to the DID set
        -- itself: a blocked source drops out of the subscription on the next
        -- refresh and the listener stops being told about it at all. That
        -- refresh interval is the lag, and it is the reason this is a
        -- predicate here rather than a check per event — per event it would be
        -- a query on the firehose's hot path.
        AND NOT ${sourceBlockedSql("es")}
    `);

    const nextDids = new Set<string>();
    const nextMap = new Map<string, SourceRow>();
    for (const row of rows) {
      nextDids.add(row.source_uri);
      nextMap.set(row.source_uri, row);
    }

    // Self-heal sources still missing a handle. A live Jetstream commit carries
    // only the DID, so insertAtprotoItem attributes posts from source.handle;
    // an active source whose handle never resolved (subscribed before the
    // enrichment code shipped, or a transient getProfile failure at subscribe
    // time that the one-shot backfill never retried) keeps minting null-author
    // rows that render as the "Bluesky user" placeholder byline. Re-enqueue the
    // backfill (its first act is fetchAtprotoProfile → persist handle + repair
    // historical rows). Deduped by job_key and self-limiting: once the handle
    // lands the source drops out of this filter, so it stops re-enqueuing.
    await this.enrichMissingHandles(rows);

    const changed = !setsEqual(this.currentDids, nextDids);
    const wasWildcard = this.currentDids.size >= WILDCARD_DID_THRESHOLD;
    const willBeWildcard = nextDids.size >= WILDCARD_DID_THRESHOLD;
    this.currentDids = nextDids;
    this.sourceByDid = nextMap;

    if (!changed) return;

    // When we were and still are above the wildcard threshold, the Jetstream
    // filter didn't change — we aren't sending `wantedDids` at all. The only
    // thing that matters is `sourceByDid`, which we just swapped in memory.
    // Avoid the full cursor-rewind reconnect storm for routine subscribe /
    // unsubscribe churn past the threshold.
    if (wasWildcard && willBeWildcard && this.ws) {
      logger.info(
        { didCount: nextDids.size },
        "Jetstream DID set changed (wildcard mode) — filter is client-side, no reconnect",
      );
      return;
    }

    logger.info(
      {
        didCount: nextDids.size,
        mode: willBeWildcard ? "wildcard" : "filtered",
      },
      "Jetstream DID set changed — reconnecting",
    );

    if (nextDids.size === 0) {
      if (this.ws) this.ws.close();
      this.ws = null;
      await this.setHealthy(false);
      return;
    }

    // Force a reconnect with the new filter.
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = INITIAL_BACKOFF_MS;
    void this.connect();
  }

  // Enqueue handle enrichment for any active atproto source whose handle is
  // still null/empty. Uses a distinct job_key from the subscribe-time backfill
  // so a routine self-heal can't clobber a genuinely-fresh subscription's job;
  // add_job dedupes on the key, so at most one enrichment per source is pending.
  //
  // Backoff (2026-07-06 audit residual): a permanently-unresolvable DID
  // (deleted/tombstoned account) used to re-enqueue the full backfill every
  // 60s forever. The backfill now records enrichment failures on the source
  // (error_count/last_error), and this filter retries fast only while under
  // the attempt cap, then once a day — self-limiting without ever giving up
  // outright (an account that comes back heals within a day; one that heals
  // sooner drops out of the filter the moment its handle lands).
  private async enrichMissingHandles(rows: SourceRow[]): Promise<void> {
    const ENRICH_FAST_ATTEMPTS = 6;
    if (rows.length === 0) return;
    try {
      // Two candidate classes (one heal loop): a NULL/empty handle (never
      // resolved), and a source whose last enrichment attempt FAILED (the
      // ATPROTO_ENRICH_FAILED_ERROR marker) — the rename case (§0i.10): an
      // identity event's one-shot re-resolve that hit a transient getProfile
      // failure leaves the OLD handle in place, so the NULL-handle filter
      // alone would never retry it and the rename was lost forever. Both
      // classes are self-limiting: a successful enrichment writes the handle
      // and resets error_count/last_error, dropping the source out.
      const { rows: due } = await pool.query<{ id: string }>(
        `SELECT id FROM external_sources
          WHERE id = ANY($1)
            AND (handle IS NULL OR btrim(handle) = '' OR last_error = $3)
            AND (error_count < $2
                 OR last_fetched_at IS NULL
                 OR last_fetched_at < now() - interval '24 hours')`,
        [rows.map((r) => r.id), ENRICH_FAST_ATTEMPTS, ATPROTO_ENRICH_FAILED_ERROR],
      );
      if (due.length === 0) return;
      for (const row of due) {
        await pool.query(
          `SELECT graphile_worker.add_job(
             'feed_ingest_atproto_backfill',
             json_build_object('sourceId', $1::text),
             job_key := 'feed_ingest_enrich_' || $1::text,
             max_attempts := 1
           )`,
          [row.id],
        );
      }
      logger.info(
        { count: due.length },
        "Enqueued atproto handle enrichment (missing or failed-resolve handles)",
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to enqueue atproto handle enrichment",
      );
    }
  }

  // --- Cursor handling --------------------------------------------------------

  // Jetstream's ?cursor= param is time_us (microseconds since epoch). On
  // reconnect we resume from the ONE stream watermark (held below any failed
  // ingest), or — until the first flush has written one — from the oldest
  // cursor across active sources; either way CAPPED at
  // feed_ingest_atproto_max_replay_hours.
  //
  // The cap is not a refinement, it is a fix: the minimum across N sources is
  // the least active account's last post, so it ages without bound, and past
  // the wildcard threshold an old cursor asks Bluesky to replay a month of the
  // entire network. resume-cursor.ts has the measurements and the failure it
  // presents as. Uncapped, this listener can never reach live. And the
  // watermark is the other half (CA-C7): with the cap alone every reconnect —
  // every new follow — still replayed the whole cap.
  private async resumePoint(): Promise<ResumePoint> {
    const hours = await loadMaxReplayHours();
    return resumeFrom(
      {
        watermark: this.watermark === null ? null : this.watermark.toString(),
        failedFloor: this.failedFloor,
        perSourceCursors: [...this.sourceByDid.values()].map((r) => r.cursor),
      },
      BigInt(Date.now()) * 1000n,
      BigInt(Math.round(hours * 3600)) * 1_000_000n,
    );
  }

  // An ingest that FAILED is a position the stream must re-deliver: the
  // watermark is held below the oldest such event until a resume passes it.
  private recordFailure(timeUs: number): void {
    const t = BigInt(timeUs);
    if (this.failedFloor === null || t < this.failedFloor) this.failedFloor = t;
  }

  // --- Batched cursor flush (#5 / B2) -----------------------------------------

  // Record a source's latest time_us for a later batched durable flush. The
  // in-memory mirror (sourceByDid[*].cursor) is updated eagerly by the caller
  // so resumePoint() on reconnect is always current; this only debounces the
  // DB write.
  private recordCursor(sourceId: string, timeUs: number): void {
    const t = BigInt(timeUs);
    const existing = this.pendingCursors.get(sourceId);
    if (existing === undefined || t > existing) {
      this.pendingCursors.set(sourceId, t);
    }
    this.eventsSinceFlush++;
    if (this.eventsSinceFlush >= CURSOR_FLUSH_EVENT_THRESHOLD) {
      void this.flushCursors();
    } else {
      this.scheduleCursorFlush();
    }
  }

  private scheduleCursorFlush(): void {
    if (this.cursorFlushTimer || this.stopping) return;
    this.cursorFlushTimer = setTimeout(() => {
      this.cursorFlushTimer = null;
      void this.flushCursors();
    }, CURSOR_FLUSH_MS);
  }

  // Flush all pending cursors in one UPDATE ... FROM (VALUES ...). The GREATEST
  // guard preserves idempotency under out-of-order delivery. On failure the
  // batch is merged back so progress isn't lost.
  private async flushCursors(): Promise<void> {
    if (this.cursorFlushTimer) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    this.eventsSinceFlush = 0;
    if (this.pendingCursors.size === 0) return;

    // Snapshot + clear so events arriving during the await accumulate into the
    // next batch rather than being dropped.
    const batch = [...this.pendingCursors.entries()];
    this.pendingCursors.clear();

    const params: unknown[] = [];
    const values = batch.map(([id, cursor]) => {
      const b = params.length;
      params.push(id, cursor.toString());
      return b === 0 ? `($1::uuid, $2::bigint)` : `($${b + 1}, $${b + 2})`;
    });

    // A live event proves the source alive, which is how a poll-fallback
    // error heals — but the ENRICHMENT marker is not a liveness question, it
    // is "getProfile failed and the handle may be stale", and the
    // enrichMissingHandles filter above backs off on error_count. Clearing it
    // on every event reset that backoff for any posting source and dropped
    // the rename-retry class out of the filter (CA-C9), so the marker and its
    // count are kept; everything else clears as before.
    const marker = params.length + 1;
    params.push(ATPROTO_ENRICH_FAILED_ERROR);
    try {
      await pool.query(
        `UPDATE external_sources AS s
         SET cursor = GREATEST(COALESCE(s.cursor::BIGINT, 0), v.cursor)::TEXT,
             last_fetched_at = now(),
             error_count = CASE WHEN s.last_error = $${marker} THEN s.error_count ELSE 0 END,
             last_error = CASE WHEN s.last_error = $${marker} THEN s.last_error ELSE NULL END,
             updated_at = now()
         FROM (VALUES ${values.join(", ")}) AS v(id, cursor)
         WHERE s.id = v.id`,
        params,
      );
      // The stream watermark, from this batch of SUCCESSES, held below any
      // failure (CA-C7). UPSERT and GREATEST: runtime state that is never
      // seeded (like the heartbeat), and never moved back by a batch that
      // flushed out of order. Its own statement, after the per-source write:
      // a watermark past a per-source cursor that never landed would skip
      // what the per-source fallback still knew about.
      const next = watermarkAfterFlush(
        batch.map(([, c]) => c),
        this.failedFloor,
      );
      if (next !== null) {
        await pool.query(
          `INSERT INTO platform_config (key, value, description, updated_at)
           VALUES ('jetstream_cursor', $1,
                   'Runtime state: the Jetstream stream position (time_us) the listener resumes from — the newest ingest that succeeded, held below any that failed. Written by the listener''s cursor flush. Not a dial.',
                   now())
           ON CONFLICT (key) DO UPDATE
             SET value = GREATEST(platform_config.value::bigint, EXCLUDED.value::bigint)::text,
                 updated_at = now()`,
          [next.toString()],
        );
        if (this.watermark === null || next > this.watermark) this.watermark = next;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Jetstream cursor flush failed — re-queuing batch",
      );
      // Merge the failed batch back in (GREATEST makes re-applying safe).
      for (const [id, cursor] of batch) {
        const existing = this.pendingCursors.get(id);
        if (existing === undefined || cursor > existing) {
          this.pendingCursors.set(id, cursor);
        }
      }
      this.scheduleCursorFlush();
    }
  }

  // --- WebSocket connection ---------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopping) return;
    if (this.currentDids.size === 0) return;

    const params = new URLSearchParams();
    for (const c of WANTED_COLLECTIONS) params.append("wantedCollections", c);

    const wildcard = this.currentDids.size >= WILDCARD_DID_THRESHOLD;
    if (!wildcard) {
      // Below threshold: let Jetstream do the DID filter server-side so we
      // only receive events we care about.
      for (const did of this.currentDids) params.append("wantedDids", did);
    }
    // Above threshold: omit `wantedDids` and receive every
    // app.bsky.feed.post. handleMessage() drops events whose DID isn't in
    // sourceByDid, so correctness is unaffected — only bandwidth goes up.

    const resume = await this.resumePoint();
    if (resume.cursor) params.set("cursor", resume.cursor);
    // Resuming at or below the failed floor means the stream will re-deliver
    // the event that failed; it either lands or records itself again. A
    // resume past it — clamped by the replay cap, or from live — has lost
    // it and SAYS so (the per-source poll fallback is what reaches one
    // account's history directly). Either way the floor is released here:
    // a floor kept past its resume would hold the watermark for ever.
    if (this.failedFloor !== null) {
      const at = resume.cursor === null ? null : BigInt(resume.cursor);
      if (at === null || at > this.failedFloor) {
        logger.warn(
          { failedFloor: this.failedFloor.toString(), resumeAt: resume.cursor },
          "Jetstream resume is past an ingest that failed — that event is not replayed",
        );
      }
      this.failedFloor = null;
    }

    const fullUrl = `${this.url}?${params.toString()}`;
    // INFO, not debug, and it names the replay depth: an over-deep resume is
    // invisible from the outside — the socket looks healthy and busy while
    // delivering nothing new — so the one moment it is knowable is here.
    logger.info(
      {
        didCount: this.currentDids.size,
        mode: wildcard ? "wildcard" : "filtered",
        storedAgeHours:
          resume.storedAgeHours === null
            ? null
            : Math.round(resume.storedAgeHours * 10) / 10,
        clamped: resume.clamped,
      },
      resume.clamped
        ? "Opening Jetstream WebSocket — stored cursor older than the replay cap, resuming from the cap"
        : "Opening Jetstream WebSocket",
    );

    // Pin the resolved IP so the WS library can't be tricked by a second
    // DNS lookup into connecting to a different (private) address — same
    // defense undici gets from buildPinnedAgent. Failure here (DNS error,
    // private-IP resolution) is logged and treated as a transient error;
    // the reconnect backoff loop will try again.
    let wsOpts;
    try {
      wsOpts = await pinnedWebSocketOptions(fullUrl, {
        maxLength: JETSTREAM_MAX_URL_LENGTH,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Jetstream pinned WS resolution failed — will retry after backoff",
      );
      if (!this.stopping) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      }
      return;
    }
    // DID set or stop flag may have changed while we awaited DNS.
    if (this.stopping || this.currentDids.size === 0) return;

    // §0f-13 (H13 residual): two connect() calls can overlap — a fired
    // backoff-reconnect awaiting the DNS pin while a refreshDids tick with a
    // changed DID set calls connect() (it clears only a PENDING timer, not an
    // in-flight connect). Whichever lands second must not orphan the first's
    // live socket: close any socket already in the slot before claiming it.
    // Its eventual close event is silenced by the `this.ws !== ws` guard
    // below — which is correct HERE (we're deliberately replacing it), the
    // guard only made the loser silent when nothing closed it at all.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing/dead */
      }
    }
    const ws = new WebSocket(fullUrl, wsOpts);
    this.ws = ws;

    // Liveness. Attached BEFORE 'open' so a frame arriving in the same tick as
    // the handshake still counts; the watchdog itself only starts on open.
    this.watchdog?.stop();
    const watchdog = new SilenceWatchdog({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      timeoutMs: SILENCE_TIMEOUT_MS,
      onProbe: () => {
        try {
          ws.ping();
        } catch {
          // A ping on a dying socket throws; the close/error handlers own that.
        }
      },
      onSilent: (idleMs) => {
        // Mark UNHEALTHY before terminating, so the atproto polling fallback
        // engages while we reconnect — this is the state that flag was written
        // for and could never previously reach.
        this.setHealthy(false).catch(() => {});
        logger.warn(
          { idleMs, didCount: this.currentDids.size },
          "Jetstream silent past the keepalive window — terminating wedged socket",
        );
        // terminate(), never close(): a half-open peer will never answer the
        // closing handshake, so close() waits forever and we would sit in
        // exactly the state we are trying to escape. terminate() destroys the
        // socket, which fires 'close' locally, and that handler schedules the
        // reconnect — so there is deliberately no reconnect call here.
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      },
    });
    this.watchdog = watchdog;
    attachLiveness(ws, watchdog);

    ws.on("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.setHealthy(true).catch(() => {});
      watchdog.start();
      logger.info({ didCount: this.currentDids.size }, "Jetstream connected");
    });

    ws.on("message", (data) => {
      this.handleMessage(data.toString()).catch((err) =>
        logger.warn({ err: err.message }, "Jetstream message handling failed"),
      );
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "Jetstream WebSocket error");
    });

    ws.on("close", (code) => {
      // Ignore the close of a socket we've already replaced. refreshDids closes
      // socket A, nulls this.ws, and connects socket B; A's async close event
      // then arrives later. Without this guard it would null this.ws (now B —
      // orphaning a live, still-ingesting socket that even stop() can't reach)
      // and schedule a redundant reconnect (socket C), so connections multiply
      // across every DID-set refresh / network blip (H13).
      // Whether or not this socket is the current one, its watchdog must go —
      // a timer left running against a replaced socket would ping a corpse and
      // then terminate whatever is in the slot at the next tick.
      watchdog.stop();
      if (this.ws !== ws) return;
      this.ws = null;
      this.setHealthy(false).catch(() => {});
      if (this.stopping) return;
      logger.info(
        { code, backoffMs: this.backoffMs },
        "Jetstream closed — scheduling reconnect",
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    });
  }

  // --- Event handling ---------------------------------------------------------

  private async handleMessage(raw: string): Promise<void> {
    let event: JetstreamCommit;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    // A handle rename arrives as an identity event, never a commit. Without
    // this branch the enrichment self-heal (which only fires on a NULL handle)
    // never revisits a resolved source, so a renamed account kept its old
    // @handle forever (§7.13).
    if (event.kind === "identity") {
      await this.handleIdentity(event);
      return;
    }

    if (event.kind !== "commit") return;
    if (!event.commit) return;
    const collection = event.commit.collection;
    if (
      collection !== "app.bsky.feed.post" &&
      collection !== "app.bsky.feed.repost"
    )
      return;

    const source = this.sourceByDid.get(event.did);
    if (!source) return; // post by a DID we no longer subscribe to; ignore

    // Reposts are boosts BY a subscribed DID → a RepostEdge, not a THING. We
    // record create/update; a repost-record delete (un-repost) is not removed
    // here — §5 time-decay sinks a stale boost without an explicit teardown.
    if (collection === "app.bsky.feed.repost") {
      if (event.commit.operation === "delete") return;
      await this.ingestRepost(event);
      return;
    }

    if (event.commit.operation === "delete") {
      await this.handleDelete(
        source.id,
        event.did,
        event.commit.rkey,
        event.time_us,
      );
      return;
    }

    const item = normaliseAtprotoCommit(event);
    if (!item) return;

    await this.ingest(source, item, event.time_us);
  }

  private async ingestRepost(event: JetstreamCommit): Promise<void> {
    const repost = detectAtprotoRepostFromCommit(event);
    if (!repost) return;
    try {
      await withTransaction(async (client) => {
        await recordRepostEdge(client, repost);
      });
    } catch (err) {
      logger.warn(
        {
          did: event.did,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to record atproto repost edge",
      );
    }
  }

  private async ingest(
    source: SourceRow,
    item: ReturnType<typeof normaliseAtprotoCommit> & {},
    timeUs: number,
  ): Promise<void> {
    try {
      const didInsert = await withTransaction(async (client) =>
        insertAtprotoItem(client, source, item),
      );

      // Eagerly prefetch the parent post (if a reply) and/or the quoted post
      // (if a quote post) so the /parent and /quote tiles render warm. Only
      // for a row this write CREATED: a replayed commit (a reconnect resumed
      // from an older cursor) is `ON CONFLICT DO NOTHING` here, and its
      // neighbourhood was enqueued the first time — re-enqueuing per replay
      // is one job row and one SELECT each for nothing (CA-C10).
      if (didInsert && (item.sourceReplyUri || item.sourceQuoteUri)) {
        pool
          .query(
            `SELECT graphile_worker.add_job('external_parent_prefetch', $1)`,
            [
              JSON.stringify({
                sourceReplyUri: item.sourceReplyUri,
                sourceQuoteUri: item.sourceQuoteUri,
                protocol: "atproto",
                sourceId: source.id,
              }),
            ],
          )
          .catch((err: unknown) => {
            logger.warn(
              {
                sourceId: source.id,
                uri: item.sourceItemUri,
                err: err instanceof Error ? err.message : String(err),
              },
              "Failed to enqueue parent prefetch for atproto item",
            );
          });
      }

      // Advance this source's cursor. The durable write is debounced into a
      // batched flush (#5 / B2); GREATEST(existing, timeUs) there keeps it
      // idempotent under out-of-order delivery.
      this.recordCursor(source.id, timeUs);

      // Keep in-memory source cursor in sync for resumePoint() on reconnect.
      // Mirror the DB's GREATEST guard: Jetstream can deliver out-of-order
      // (e.g. after a reconnect that resumed from an older cursor), and we
      // must not regress and re-admit already-ingested events.
      const existing = source.cursor ? BigInt(source.cursor) : 0n;
      if (BigInt(timeUs) > existing) source.cursor = String(timeUs);
    } catch (err) {
      this.recordFailure(timeUs);
      logger.warn(
        {
          sourceId: source.id,
          uri: item.sourceItemUri,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to ingest atproto item",
      );
    }
  }

  // Identity change (handle rename / PDS move) for a DID we subscribe to.
  //
  // The event's `handle` is optional and usually absent — it announces THAT
  // identity changed, not what to. So this re-enqueues the enrichment backfill,
  // which re-resolves the DID via getProfile and writes the fresh handle to
  // external_sources plus external_authors (the byline's source). When the
  // event does carry a handle, it's used to skip the round-trip if nothing
  // actually changed — identity events also fire for PDS moves, which leave the
  // handle alone.
  //
  // Reuses the enrichment job_key, so a rename and a missing-handle self-heal
  // collapse into one pending job per source rather than racing.
  private async handleIdentity(event: JetstreamCommit): Promise<void> {
    const source = this.sourceByDid.get(event.did);
    if (!source) return; // not a DID we track

    const announced = event.identity?.handle?.trim();
    if (announced && source.handle && announced === source.handle) return;

    try {
      await pool.query(
        `SELECT graphile_worker.add_job(
           'feed_ingest_atproto_backfill',
           json_build_object('sourceId', $1::text),
           job_key := 'feed_ingest_enrich_' || $1::text,
           max_attempts := 1
         )`,
        [source.id],
      );
      logger.info(
        { sourceId: source.id, did: event.did, announcedHandle: announced ?? null },
        "atproto identity change — enqueued handle re-resolution",
      );
    } catch (err) {
      logger.warn(
        {
          sourceId: source.id,
          did: event.did,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to enqueue atproto handle re-resolution",
      );
    }
  }

  private async handleDelete(
    sourceId: string,
    did: string,
    rkey: string,
    timeUs: number,
  ): Promise<void> {
    const uri = buildAtUri(did, "app.bsky.feed.post", rkey);
    try {
      // Matched on (protocol, source_item_uri), never on source_id (CA-C11):
      // a context row inherits the HYDRATING focal's source_id until real
      // ingest promotes it, and the 24h backfill never re-offers an older
      // post, so a subscribed author's older post held only as a thread
      // parent survived its deletion. The uri is built from the event's own
      // DID, so it cannot name another account's post.
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE external_items SET deleted_at = now()
           WHERE protocol = 'atproto' AND source_item_uri = $1
             AND deleted_at IS NULL`,
          [uri],
        );
        await client.query(
          `UPDATE feed_items SET deleted_at = now()
           WHERE source_protocol = 'atproto' AND source_item_uri = $1
             AND deleted_at IS NULL`,
          [uri],
        );
      });
      // Debounced batched cursor advance (#5 / B2).
      this.recordCursor(sourceId, timeUs);
    } catch (err) {
      this.recordFailure(timeUs);
      logger.warn(
        {
          sourceId,
          uri,
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to apply atproto delete",
      );
    }
  }

  // --- Health flag ------------------------------------------------------------

  private async setHealthy(healthy: boolean): Promise<void> {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    try {
      // UPSERT, not UPDATE. A bare UPDATE matches zero rows when the key is
      // absent and reports no error, so the flag silently never persisted on
      // any DB booted from schema.sql (which seeds _migrations with every
      // filename, so migration 055's INSERT never ran). The consumer reads
      // `!== "false"`, i.e. a missing row means healthy — so the listener could
      // never mark itself DOWN and the atproto polling fallback in
      // feed-ingest-poll.ts never engaged. config-defaults.sql now seeds the
      // row, but a write path must not depend on a seed having happened.
      await pool.query(
        `INSERT INTO platform_config (key, value, updated_at)
         VALUES ('jetstream_healthy', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [healthy ? "true" : "false"],
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Failed to write jetstream_healthy flag",
      );
    }
  }
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
