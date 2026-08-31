import type { Task } from "graphile-worker";
import { pool } from "@platform-pub/shared/db/client.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { fetchNostrEngagementCounts } from "../lib/nostr-relay.js";
import {
  loadResonanceParams,
  updateExternalResonance,
} from "../lib/resonance.js";

// =============================================================================
// external_engagement_refresh — periodic snapshot of engagement counts
//
// Batch-fetches current like/reply/repost counts from source platforms and
// updates the denormalised columns on external_items. Runs every 30 minutes
// via cron, but **age-tiers** which items it touches per run (#7 / B6):
//   - <6h  old → every run (every 30m)   — engagement is moving fast
//   - <24h old → top-of-hour runs only    — hourly
//   - <7d  old → one daily run            — long-tail decay
// Engagement is long-tail decay, so a 6-day-old item polled as often as a
// 1-hour-old one is wasted load on public.api.bsky.app / Mastodon instances.
// A per-run budget cap bounds the worst case; the daily sweep pages through
// its window across successive runs via a persisted keyset cursor (below), so
// the cap defers long-tail coverage instead of permanently starving it.
//
// Bluesky:  batch getPosts (up to 25 URIs per call)
// Mastodon: individual GET /statuses/:id, parallelised per instance
// Nostr:    reactions (kind 7) + replies (kind 1) by `#e`-tag over the relay
//           graph, gated behind NOSTR_ENGAGEMENT_COUNTS_ENABLED (relay REQ
//           latency makes it the heaviest source, so it ships dark and runs
//           under a tighter per-run cap). Written MONOTONICALLY so a partial
//           relay read never flickers a stored count down.
// RSS:      no counts; always 0
//
// Writes are batched into one UPDATE ... FROM (VALUES ...) per platform and
// skip rows whose counts are unchanged (#8 / B3).
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";
const BSKY_BATCH_SIZE = 25;
const MASTODON_CONCURRENCY = 5;
const MAX_LOOKBACK_DAYS = 7;
// UTC hour whose top-of-hour run performs the full <7d daily sweep.
const DAILY_REFRESH_HOUR_UTC = 4;
// Nostr's relay REQ latency dwarfs the HTTP APIs, so it carries its own tighter
// per-run budget and a relay-hint cap, independent of the HTTP-platform budget.
const NOSTR_MAX_ITEMS = 300;
const NOSTR_RELAY_HINT_CAP = 8;

function nostrEngagementEnabled(): boolean {
  const v = process.env.NOSTR_ENGAGEMENT_COUNTS_ENABLED;
  return v === "1" || v === "true";
}

interface ExternalItemRow {
  id: string;
  protocol: string;
  source_item_uri: string;
  interaction_data: Record<string, unknown>;
  media: MediaItem[];
  like_count: number;
  reply_count: number;
  repost_count: number;
  published_at: string;
}

interface CountUpdate {
  id: string;
  like: number;
  reply: number;
  repost: number;
}

// ---------------------------------------------------------------------------
// Daily-sweep keyset cursor. Freshest-first + a fixed budget means a DAILY <7d
// sweep whose window exceeds the budget only ever reaches the freshest slice —
// deterministically, so the remainder is starved FOREVER, not "deferred to
// next run" (dev measure 2026-07-21: 19,944 eligible, ~90% unreachable; their
// counts freeze at ~age 6h and the resonance baselines build medians from
// frozen Es). So the daily run pages: it persists the oldest published_at it
// reached, the NEXT daily run resumes strictly below it, and a short page
// resets the cursor for a fresh top-down rotation. Every long-tail item is
// refreshed once per ceil(window/budget) days. The 30m/hourly tiers stay
// freshest-first (their windows recur within hours, so nothing starves).
//
// RUNTIME STATE, not a tuning dial — deliberately absent from
// config-defaults.sql (like payouts_halted): absence simply means "start from
// the top". Read fresh + upserted (never a bare UPDATE), DELETEd to reset.
// ---------------------------------------------------------------------------
const DAILY_SWEEP_CURSOR_KEY = "engagement_daily_sweep_cursor";

async function readDailySweepCursor(): Promise<string | null> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM platform_config WHERE key = $1`,
    [DAILY_SWEEP_CURSOR_KEY],
  );
  return rows.length > 0 ? rows[0].value : null;
}

async function writeDailySweepCursor(publishedAt: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_config (key, value, description)
     VALUES ($1, $2, 'Runtime state: where the daily engagement long-tail sweep resumes (oldest published_at reached). Absent = start from the top.')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DAILY_SWEEP_CURSOR_KEY, publishedAt],
  );
}

async function clearDailySweepCursor(): Promise<void> {
  await pool.query(`DELETE FROM platform_config WHERE key = $1`, [
    DAILY_SWEEP_CURSOR_KEY,
  ]);
}

/**
 * Decide how far back this run reaches, given the wall-clock minute/hour.
 * The cron fires at :00 and :30. A :30 run only touches the <6h tier; a :00
 * run also sweeps <24h; the :00 run at DAILY_REFRESH_HOUR_UTC sweeps the full
 * <7d window. A wider cutoff supersets the narrower tiers, so a single
 * published_at bound expresses all three. (#7 / B6)
 */
export function engagementLookbackHours(now: Date): number {
  // Allow scheduling jitter — a "top of hour" run is anything in the first
  // quarter of the hour (the cron's :00 slot).
  const isTopOfHour = now.getUTCMinutes() < 15;
  if (isTopOfHour && now.getUTCHours() === DAILY_REFRESH_HOUR_UTC) {
    return MAX_LOOKBACK_DAYS * 24;
  }
  return isTopOfHour ? 24 : 6;
}

interface MediaItem {
  type: "image" | "video" | "audio" | "link";
  url: string;
  thumbnail?: string;
  alt?: string;
  title?: string;
  description?: string;
}

// Mastodon attaches an OpenGraph link preview to a status as a `card` object
// (Mastodon-API-only — it's never in the ActivityPub outbox the adapter polls).
// Normalise it into the same {type:"link"} media entry our cards already render
// for Bluesky's app.bsky.embed.external, so a previewed link looks identical
// regardless of source.
interface MastodonCard {
  url?: string;
  title?: string;
  description?: string;
  image?: string | null;
  type?: string; // "link" | "photo" | "video" | "rich"
}

export function cardToLinkMedia(
  card: MastodonCard | null | undefined,
): MediaItem | null {
  if (!card?.url) return null;
  // Only "link" cards become preview tiles; photo/video cards are already
  // represented by the status's media_attachments.
  if (card.type && card.type !== "link") return null;
  return {
    type: "link",
    url: card.url,
    thumbnail: card.image ?? undefined,
    title: card.title || undefined,
    description: card.description || undefined,
  };
}

// Replace any existing link entry with the fresh card, preserving image/video
// media. Returns null when nothing changed so the caller can skip the write.
export function mergeLinkMedia(
  existing: MediaItem[],
  link: MediaItem | null,
): MediaItem[] | null {
  const nonLink = (existing ?? []).filter((m) => m.type !== "link");
  const current = existing ?? [];
  const next = link ? [...nonLink, link] : nonLink;
  if (
    next.length === current.length &&
    JSON.stringify(next) === JSON.stringify(current)
  ) {
    return null;
  }
  return next;
}

export const externalEngagementRefresh: Task = async (_payload, _helpers) => {
  const config = await getPlatformConfig();
  const maxItems =
    parseInt(config.get("feed_ingest_engagement_max_items") ?? "", 10) || 2000;

  const lookbackHours = engagementLookbackHours(new Date());
  const isDailySweep = lookbackHours === MAX_LOOKBACK_DAYS * 24;
  const cutoff = new Date(
    Date.now() - lookbackHours * 60 * 60 * 1000,
  ).toISOString();

  // Freshest-first within the budget — newest items decay fastest and matter
  // most. The daily sweep additionally resumes below the persisted cursor so
  // successive daily runs rotate through the whole <7d window (see the cursor
  // block above); ties on published_at can slip a strict `<` keyset, which is
  // acceptable for a periodic lossy refresh.
  const selectPage = (cursor: string | null) =>
    pool.query<ExternalItemRow>(
      `SELECT id, protocol, source_item_uri, interaction_data, media,
              like_count, reply_count, repost_count, published_at
       FROM external_items
       WHERE published_at >= $1
         AND deleted_at IS NULL
         AND protocol IN ('atproto', 'activitypub')
         AND ($3::timestamptz IS NULL OR published_at < $3)
       ORDER BY published_at DESC
       LIMIT $2`,
      [cutoff, maxItems, cursor],
    );

  let cursor = isDailySweep ? await readDailySweepCursor() : null;
  let { rows } = await selectPage(cursor);
  if (isDailySweep && cursor !== null && rows.length === 0) {
    // Cursor aged out below the moving 7d window — restart from the top NOW
    // rather than wasting today's long-tail slot on an empty page.
    cursor = null;
    await clearDailySweepCursor();
    ({ rows } = await selectPage(null));
  }
  if (isDailySweep) {
    if (rows.length === maxItems) {
      const resumeAt = rows[rows.length - 1].published_at;
      await writeDailySweepCursor(resumeAt);
      logger.info(
        { maxItems, resumeAt },
        "daily engagement sweep hit the per-run budget — resumes below the cursor at the next daily run",
      );
    } else {
      // Window exhausted for this rotation: next daily run starts from the top.
      await clearDailySweepCursor();
    }
  } else if (rows.length === maxItems) {
    logger.warn(
      { maxItems, lookbackHours },
      "engagement refresh hit the per-run budget cap — un-reached older items are covered by the rotating daily sweep",
    );
  }

  if (rows.length === 0) return;

  const atprotoItems = rows.filter((r) => r.protocol === "atproto");
  const mastodonItems = rows.filter((r) => r.protocol === "activitypub");

  let updated = 0;

  if (atprotoItems.length > 0) {
    updated += await refreshBlueskyBatch(atprotoItems);
  }

  if (mastodonItems.length > 0) {
    updated += await refreshMastodonBatch(mastodonItems);
  }

  // Nostr is queried separately (own tighter budget) since its relay REQ latency
  // would otherwise let a backlog of nostr rows crowd out the fast HTTP refresh.
  // It does NOT share the daily keyset cursor (different budget ⇒ different
  // page floor), so at scale it inherits the freshest-first starvation shape —
  // give it its own cursor before lighting NOSTR_ENGAGEMENT_COUNTS_ENABLED on
  // a backlog larger than NOSTR_MAX_ITEMS.
  if (nostrEngagementEnabled()) {
    const { rows: nostrRows } = await pool.query<ExternalItemRow>(
      `SELECT id, protocol, source_item_uri, interaction_data, media,
              like_count, reply_count, repost_count
       FROM external_items
       WHERE published_at >= $1
         AND deleted_at IS NULL
         AND protocol = 'nostr_external'
       ORDER BY published_at DESC
       LIMIT $2`,
      [cutoff, NOSTR_MAX_ITEMS],
    );
    if (nostrRows.length > 0) {
      updated += await refreshNostrBatch(nostrRows);
    }
  }

  if (updated > 0) {
    logger.info(
      { updated, total: rows.length },
      "external engagement refresh complete",
    );
  }
};

// ---------------------------------------------------------------------------
// Batched count write — one UPDATE ... FROM (VALUES ...) for the whole set.
// Callers pre-filter to only the rows whose counts actually changed (#8 / B3).
//
// Resonance (SOCIAL-PROOF-RESONANCE-ADR D5) rides the same set: the rows whose
// counts moved are exactly the rows whose band can have moved, so the derived
// feed_items columns are recomputed here, immediately after the counts land.
// ---------------------------------------------------------------------------

async function batchUpdateCounts(rows: CountUpdate[]): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const values = rows.map((r) => {
    const b = params.length;
    params.push(r.id, r.like, r.reply, r.repost);
    // Cast the first tuple so the planner knows the VALUES column types.
    return b === 0
      ? `($1::uuid, $2::int, $3::int, $4::int)`
      : `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  });
  await pool.query(
    `UPDATE external_items AS ei
     SET like_count = v.like_count, reply_count = v.reply_count, repost_count = v.repost_count
     FROM (VALUES ${values.join(", ")}) AS v(id, like_count, reply_count, repost_count)
     WHERE ei.id = v.id`,
    params,
  );
  await refreshResonanceFor(rows.map((r) => r.id));
}

/**
 * Recompute the derived resonance columns for the given external_items ids.
 * Never fatal: a resonance failure must not lose an engagement-count refresh
 * (the counts are the durable signal; bands rebuild on the next pass).
 */
async function refreshResonanceFor(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const params = await loadResonanceParams();
    await updateExternalResonance(ids, params);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), count: ids.length },
      "resonance recompute failed during engagement refresh",
    );
  }
}

// ---------------------------------------------------------------------------
// Nostr — reactions (kind 7) + replies (kind 1) by `#e`-tag over the relay graph
// ---------------------------------------------------------------------------

async function refreshNostrBatch(items: ExternalItemRow[]): Promise<number> {
  // Key each note by its raw hex event id (the `#e` value reactions/replies
  // reference) and gather the union of the items' relay hints.
  const byNoteId = new Map<string, ExternalItemRow>();
  const relayHints = new Set<string>();
  for (const item of items) {
    const rawId = item.interaction_data?.id;
    const id = typeof rawId === "string" ? rawId : null;
    if (!id || !/^[0-9a-f]{64}$/i.test(id)) continue;
    byNoteId.set(id.toLowerCase(), item);
    const relays = item.interaction_data?.relays;
    if (Array.isArray(relays)) {
      for (const r of relays) if (typeof r === "string") relayHints.add(r);
    }
  }
  if (byNoteId.size === 0) return 0;

  const counts = await fetchNostrEngagementCounts(
    [...byNoteId.keys()],
    [...relayHints].slice(0, NOSTR_RELAY_HINT_CAP),
  );

  const changed: CountUpdate[] = [];
  for (const [id, item] of byNoteId) {
    const observed = counts.get(id);
    if (!observed) continue;
    // Monotonic: a partial relay read can only raise a count, never lower it.
    // repost is left untouched (nostr cards hide repost — kind 6/16 are edges).
    const like = Math.max(item.like_count, observed.like);
    const reply = Math.max(item.reply_count, observed.reply);
    if (like === item.like_count && reply === item.reply_count) continue;
    changed.push({ id: item.id, like, reply, repost: item.repost_count });
  }
  await batchUpdateCounts(changed);
  return changed.length;
}

// ---------------------------------------------------------------------------
// Bluesky — batch getPosts (25 URIs per call)
// ---------------------------------------------------------------------------

async function refreshBlueskyBatch(items: ExternalItemRow[]): Promise<number> {
  const changed: CountUpdate[] = [];

  for (let i = 0; i < items.length; i += BSKY_BATCH_SIZE) {
    const batch = items.slice(i, i + BSKY_BATCH_SIZE);
    const uris = batch.map((item) => item.source_item_uri);

    try {
      const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getPosts`);
      for (const uri of uris) {
        url.searchParams.append("uris", uri);
      }

      const res = await safeFetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        logger.warn(
          { status: res.status, batch: i },
          "getPosts failed during engagement refresh",
        );
        continue;
      }

      const data = JSON.parse(res.text) as {
        posts: Array<{
          uri: string;
          likeCount?: number;
          replyCount?: number;
          repostCount?: number;
        }>;
      };

      const postMap = new Map(data.posts.map((p) => [p.uri, p]));

      for (const item of batch) {
        const post = postMap.get(item.source_item_uri);
        if (!post) continue;

        const like = post.likeCount ?? 0;
        const reply = post.replyCount ?? 0;
        const repost = post.repostCount ?? 0;
        // Skip the write when nothing moved.
        if (
          like === item.like_count &&
          reply === item.reply_count &&
          repost === item.repost_count
        ) {
          continue;
        }
        changed.push({ id: item.id, like, reply, repost });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), batch: i },
        "Bluesky engagement refresh batch failed",
      );
    }
  }

  await batchUpdateCounts(changed);
  return changed.length;
}

// ---------------------------------------------------------------------------
// Mastodon — individual GET /api/v1/statuses/:id per instance
// ---------------------------------------------------------------------------

// A pending Mastodon write: counts plus, when the OpenGraph card changed, the
// re-merged media JSON. Count-only rows (media === null) flush in one batched
// UPDATE; the rare media rows write individually.
interface MastodonUpdate extends CountUpdate {
  media: string | null;
}

async function refreshMastodonBatch(items: ExternalItemRow[]): Promise<number> {
  // Group items by instance host to respect per-instance rate limits
  const byHost = new Map<string, ExternalItemRow[]>();
  for (const item of items) {
    try {
      const host = new URL(item.source_item_uri).hostname;
      const group = byHost.get(host) ?? [];
      group.push(item);
      byHost.set(host, group);
    } catch {
      continue;
    }
  }

  // Fetch per host (parallel up to MASTODON_CONCURRENCY), collecting pending
  // writes; then flush once at the end.
  const pending: MastodonUpdate[] = [];
  const hosts = [...byHost.entries()];
  for (let i = 0; i < hosts.length; i += MASTODON_CONCURRENCY) {
    const hostBatch = hosts.slice(i, i + MASTODON_CONCURRENCY);
    const results = await Promise.allSettled(
      hostBatch.map(([host, hostItems]) =>
        refreshMastodonHost(host, hostItems),
      ),
    );
    for (const result of results) {
      if (result.status === "fulfilled") pending.push(...result.value);
    }
  }

  // Count-only rows → one batched UPDATE. Media rows → individual writes.
  const countOnly = pending.filter((u) => u.media === null);
  const withMedia = pending.filter((u) => u.media !== null);
  await batchUpdateCounts(countOnly);
  for (const u of withMedia) {
    await pool.query(
      `UPDATE external_items
       SET like_count = $1, reply_count = $2, repost_count = $3, media = $5
       WHERE id = $4`,
      [u.like, u.reply, u.repost, u.id, u.media],
    );
  }
  // The media rows bypass batchUpdateCounts, so they need their own recompute.
  await refreshResonanceFor(withMedia.map((u) => u.id));

  return pending.length;
}

async function refreshMastodonHost(
  host: string,
  items: ExternalItemRow[],
): Promise<MastodonUpdate[]> {
  const updates: MastodonUpdate[] = [];

  for (const item of items) {
    const statusId = extractMastodonStatusId(item.source_item_uri);
    if (!statusId) continue;

    try {
      const res = await safeFetch(
        `https://${host}/api/v1/statuses/${statusId}`,
        { headers: { Accept: "application/json" } },
      );

      if (!res.ok) continue;

      const status = JSON.parse(res.text) as {
        favourites_count?: number;
        replies_count?: number;
        reblogs_count?: number;
        card?: MastodonCard | null;
      };

      const like = status.favourites_count ?? 0;
      const reply = status.replies_count ?? 0;
      const repost = status.reblogs_count ?? 0;
      // mergeLinkMedia returns null when the card is unchanged.
      const mergedMedia = mergeLinkMedia(
        item.media,
        cardToLinkMedia(status.card),
      );
      const countsUnchanged =
        like === item.like_count &&
        reply === item.reply_count &&
        repost === item.repost_count;
      // Nothing moved and no media change → skip the write entirely.
      if (countsUnchanged && !mergedMedia) continue;

      updates.push({
        id: item.id,
        like,
        reply,
        repost,
        media: mergedMedia ? JSON.stringify(mergedMedia) : null,
      });
    } catch (err) {
      logger.debug(
        {
          host,
          uri: item.source_item_uri,
          err: err instanceof Error ? err.message : String(err),
        },
        "Mastodon status fetch failed during engagement refresh",
      );
    }
  }

  return updates;
}

function extractMastodonStatusId(uri: string): string | null {
  // Mastodon status URIs: https://instance.social/users/name/statuses/12345
  // or https://instance.social/@name/12345
  try {
    const parts = new URL(uri).pathname.split("/").filter(Boolean);
    // /users/name/statuses/ID or /@name/ID
    const last = parts[parts.length - 1];
    if (last && /^\d+$/.test(last)) return last;
    return null;
  } catch {
    return null;
  }
}
