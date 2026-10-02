import type { Task } from "graphile-worker";
import { pool, withTransaction } from "@platform-pub/shared/db/client.js";
import { decryptJson } from "@platform-pub/shared/lib/crypto.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { isSourceUriBlocked } from "@platform-pub/shared/lib/platform-blocks.js";
import {
  ensureShadowSource,
  persistHydratedThreadNodes,
  type HydratedNode,
} from "@platform-pub/shared/lib/context-persist.js";
import {
  invalidatePresence,
  isCredentialRefusal,
  NOTIFICATIONS_NEEDS_RECONNECT,
} from "@platform-pub/shared/lib/presence-health.js";
import { hasMastodonScope } from "@platform-pub/shared/lib/mastodon-scopes.js";
import { qualifyAcct, type MastodonStatus } from "@platform-pub/shared/lib/mastodon-api.js";
import { sanitizeContent, stripHtml } from "@platform-pub/shared/lib/sanitize.js";
import { getPlatformConfig } from "../lib/platform-config.js";
import { normaliseAtprotoPost } from "../adapters/atproto.js";
import {
  listMastodonNotifications,
  readHomeInstanceStatus,
  compareMastodonIds,
  MASTODON_PAGE_LIMIT,
  type MastodonCredentials,
  type MastodonNotification,
} from "../adapters/activitypub-outbound.js";
import {
  listBlueskyNotifications,
  type BlueskyNotification,
} from "../adapters/linked-notifications.js";

// =============================================================================
// linked_notifications_poll — replies, mentions and quotes addressed to a
// member on Bluesky or Mastodon come home as notifications
// (CROSS-NETWORK-ROUNDTRIP-ADR rung C).
//
// Scheduled every minute; each tick CLAIMS the presences that are due (their
// last attempt older than the `linked_notifications_poll_seconds` dial) with
// SKIP LOCKED, so the dial is the real interval and two overlapping ticks never
// poll one presence twice. Every active, valid, OAuth-custody presence of an
// active member is polled — C-Q4: a mention needs no cross-post.
//
// PER HIT, ONE TRANSACTION, THROUGH THE EXISTING HOMES (C2):
//   • the post is written CONTEXT-ONLY through `persistHydratedThreadNodes`,
//     anchored on the author's shadow source — so promotion on real ingest,
//     first-writer-owns and the interaction_data merge all hold, and rung B
//     draws a reply to a member's echo under their native note;
//   • the notification BINDS that row (`external_item_id`, migration 236) and,
//     where the post answers or quotes one of the member's cross-posts, the
//     note (`note_id`), so the panel can open the conversation on it;
//   • `idx_notifications_external_item` is not partial on `read`, so a post
//     met again — a boundary re-read, a cursor held back — never notifies
//     twice. The index alone decides; the insert is a bare ON CONFLICT DO
//     NOTHING (the posts invariant).
// A hit is SKIPPED, and counted, when it is the member's own post, when its
// author is platform-blocked (the operator's refusal holds however a post
// reaches us), and — Mastodon only — when it is a reply whose parent no longer
// resolves: filed without its parent it would render as somebody starting the
// conversation they were answering (the ingest rule for the client API).
//
// THE CURSOR advances past what was CONSIDERED, and stops at the first hit
// whose handling THREW — so an ambiguous failure is retried next interval, and
// a skipped hit is not re-considered for ever. Items are handled OLDEST first,
// so "stops" means everything before it is done.
//
// THE LOOP DOES NOT ABORT (a partial outcome is not a total one): one bad token
// fails its own presence. A refused credential invalidates the presence
// (presence-health.ts, C4); a token minted before `read:notifications` was
// asked for is not a failure of the presence but a capability it lacks, and is
// recorded as awaiting a reconnect. The heartbeat (`notifications_polled_at`)
// is stamped only on success, so a presence that keeps failing ages visibly on
// /admin/overview.
// =============================================================================

/** In-code fallbacks — a SECOND copy of config-defaults.sql, parity-tested. */
export const LINKED_NOTIFICATION_FALLBACKS = {
  linked_notifications_poll_seconds: 300,
  linked_notifications_backfill_hours: 72,
} as const;


const CLAIM_BATCH = 50;
const MAX_PAGES = 10;

type Kind = "external_reply" | "external_mention" | "external_quote";

interface PresenceRow {
  id: string;
  account_id: string;
  protocol: "atproto" | "activitypub";
  external_id: string;
  handle: string | null;
  service_url: string | null;
  credentials_enc: string | null;
  notifications_cursor: string | null;
}

/** One post addressed to the member, ready to persist. */
export interface Hit {
  kind: Kind;
  protocol: "atproto" | "activitypub";
  /** The author's identity: a DID, or an ActivityPub actor uri. */
  authorKey: string;
  node: HydratedNode;
  /** The member's post this answers or quotes, by its remote address — the
   *  key to the note it may echo. Null for a bare mention. */
  targetUri: string | null;
}

export type HitOutcome = "notified" | "duplicate" | "self" | "blocked";

export interface PollTally {
  claimed: number;
  succeeded: number;
  failed: number;
  invalidated: number;
  needsReconnect: number;
  notified: number;
  /** Hits considered and deliberately not notified — self, blocked,
   *  unthreadable — beside `notified`, never folded into it. */
  skipped: number;
  /** Presences whose walk hit the page cap before its cursor. */
  truncated: number;
}

export const CLAIM_DUE_PRESENCES_SQL = `
    WITH due AS (
      SELECT np.id
        FROM network_presences np
        JOIN accounts a ON a.id = np.account_id AND a.status = 'active'
       WHERE np.lifecycle_state = 'active'
         AND np.is_valid = TRUE
         AND np.provenance <> 'concierge'
         AND np.protocol IN ('atproto', 'activitypub')
         AND (np.notifications_attempted_at IS NULL
              OR np.notifications_attempted_at < now() - make_interval(secs => $1))
       ORDER BY np.notifications_attempted_at ASC NULLS FIRST
       LIMIT $2
       FOR UPDATE OF np SKIP LOCKED
    )
    UPDATE network_presences np
       SET notifications_attempted_at = now()
      FROM due
     WHERE np.id = due.id
    RETURNING np.id, np.account_id, np.protocol::text AS protocol, np.external_id,
              np.handle, np.service_url, np.credentials_enc, np.notifications_cursor`;

// The note a remote post answers or quotes, where that remote post is one of
// the member's own cross-posts (rung B's echo, read from the member's side).
// A tombstoned note is nobody's echo.
export const ECHO_NOTE_SQL = `
    SELECT n.id
      FROM outbound_posts op
      JOIN notes n
        ON n.nostr_event_id = op.nostr_event_id AND n.author_id = op.account_id
      JOIN feed_items fi
        ON fi.note_id = n.id AND fi.item_type = 'note' AND fi.deleted_at IS NULL
     WHERE op.account_id = $1
       AND op.protocol = $2::external_protocol
       AND op.external_post_uri = $3
       AND op.status = 'sent'
       AND op.action_type IN ('reply', 'quote', 'original')
     LIMIT 1`;

export const EXTERNAL_NOTIFICATION_INSERT_SQL = `
    INSERT INTO notifications (recipient_id, actor_id, type, external_item_id, note_id)
    VALUES ($1, NULL, $2, $3, $4)
    ON CONFLICT DO NOTHING`;

export const linkedNotificationsPoll: Task = async () => {
  const cfg = await getPlatformConfig();
  const intervalSec = dialInt(cfg, "linked_notifications_poll_seconds");
  const backfillHours = dialInt(cfg, "linked_notifications_backfill_hours");

  const { rows } = await pool.query<PresenceRow>(CLAIM_DUE_PRESENCES_SQL, [
    intervalSec,
    CLAIM_BATCH,
  ]);
  const tally = await pollPresences(rows, { backfillHours });
  if (tally.claimed > 0) logger.info(tally, "linked notifications polled");
};

export async function pollPresences(
  presences: PresenceRow[],
  opts: { backfillHours: number; now?: Date },
): Promise<PollTally> {
  const tally: PollTally = {
    claimed: presences.length,
    succeeded: 0,
    failed: 0,
    invalidated: 0,
    needsReconnect: 0,
    notified: 0,
    skipped: 0,
    truncated: 0,
  };
  const backfillFrom = new Date(
    (opts.now ?? new Date()).getTime() - opts.backfillHours * 3_600_000,
  );
  for (const p of presences) {
    const walk: Walk = { cursor: p.notifications_cursor, notified: 0, skipped: 0, truncated: false };
    let failure: unknown = null;
    try {
      if (p.protocol === "atproto") await pollBluesky(p, backfillFrom, walk);
      else await pollMastodon(p, backfillFrom, walk);
    } catch (err) {
      failure = err;
    }
    tally.notified += walk.notified;
    tally.skipped += walk.skipped;
    if (walk.truncated) tally.truncated++;
    try {
      await recordOutcome(p, walk, failure, tally);
    } catch (err) {
      // The outcome could not be written; the claim still stands, so the
      // presence is retried next interval. Counted, never thrown — one
      // presence's bookkeeping must not stop the others'.
      tally.failed++;
      logger.error({ err, presenceId: p.id }, "linked notifications: outcome write failed");
    }
  }
  return tally;
}

interface Walk {
  cursor: string | null;
  notified: number;
  skipped: number;
  truncated: boolean;
}

class NeedsReconnect extends Error {}

async function recordOutcome(
  p: PresenceRow,
  walk: Walk,
  failure: unknown,
  tally: PollTally,
): Promise<void> {
  if (failure === null) {
    tally.succeeded++;
    await pool.query(
      `UPDATE network_presences
          SET notifications_cursor = $2,
              notifications_polled_at = now(),
              notifications_poll_error = NULL
        WHERE id = $1`,
      [p.id, walk.cursor],
    );
    return;
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  if (failure instanceof NeedsReconnect) {
    tally.needsReconnect++;
  } else {
    tally.failed++;
    if (isCredentialRefusal(failure)) {
      if (await invalidatePresence(pool, p.id, `notification poll: ${message}`))
        tally.invalidated++;
    } else {
      logger.warn(
        { presenceId: p.id, protocol: p.protocol, err: message },
        "linked notifications: poll failed",
      );
    }
  }
  // Progress made before the failure is kept: the cursor stops at the last
  // hit handled, and the heartbeat is left where it was.
  await pool.query(
    `UPDATE network_presences
        SET notifications_cursor = $2, notifications_poll_error = $3
      WHERE id = $1`,
    [p.id, walk.cursor, message.slice(0, 500)],
  );
}

// ─── Bluesky ────────────────────────────────────────────────────────────────

async function pollBluesky(p: PresenceRow, backfillFrom: Date, walk: Walk): Promise<void> {
  // The API pages NEWEST first and nothing else, so the walk collects back to
  // the cursor and then handles what it found oldest first. The boundary is
  // inclusive: a hit sharing the cursor's instant is re-considered, which the
  // unique index makes harmless, where an exclusive one could lose it.
  const since = p.notifications_cursor ?? backfillFrom.toISOString();
  const sinceMs = Date.parse(since);
  const found: BlueskyNotification[] = [];
  let pageCursor: string | undefined;
  let reachedCursor = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listBlueskyNotifications(p.external_id, pageCursor);
    for (const n of res.notifications) {
      if (Date.parse(n.indexedAt) < sinceMs) reachedCursor = true;
      else found.push(n);
    }
    if (reachedCursor || !res.cursor || res.notifications.length === 0) {
      reachedCursor = true;
      break;
    }
    pageCursor = res.cursor;
  }
  if (!reachedCursor) {
    // A descending-only pager cannot resume from the middle, so what lies
    // between the cursor and the oldest page read is not revisited. Said out
    // loud rather than silently.
    walk.truncated = true;
    logger.warn(
      { presenceId: p.id, considered: found.length },
      "linked notifications: Bluesky walk hit the page cap before its cursor",
    );
  }
  found.sort((a, b) => Date.parse(a.indexedAt) - Date.parse(b.indexedAt));
  for (const n of found) {
    const hit = blueskyHit(n);
    if (hit) countOutcome(walk, await handleHit(p, hit));
    else walk.skipped++;
    walk.cursor = n.indexedAt;
  }
}

export function blueskyHit(n: BlueskyNotification): Hit | null {
  const kind: Kind | null =
    n.reason === "reply"
      ? "external_reply"
      : n.reason === "mention"
        ? "external_mention"
        : n.reason === "quote"
          ? "external_quote"
          : null;
  if (!kind) return null;
  const item = normaliseAtprotoPost({
    did: n.author.did,
    uri: n.uri,
    cid: n.cid,
    record: n.record,
    fallbackDate: new Date(n.indexedAt),
    author: { handle: n.author.handle, displayName: n.author.displayName },
  });
  const interactionData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item.interactionData))
    if (v !== undefined && v !== null) interactionData[k] = v;
  return {
    kind,
    protocol: "atproto",
    authorKey: n.author.did,
    targetUri:
      kind === "external_quote"
        ? (n.reasonSubject ?? item.sourceQuoteUri)
        : item.sourceReplyUri,
    node: {
      sourceItemUri: item.sourceItemUri,
      sourceReplyUri: item.sourceReplyUri,
      sourceQuoteUri: item.sourceQuoteUri,
      authorName: n.author.displayName || n.author.handle,
      authorHandle: n.author.handle,
      authorAvatarUrl: n.author.avatar ?? null,
      // The DID, as thread hydration writes it, so the identity trigger files
      // the row under the same external_authors row a thread expand does.
      authorUri: n.author.did,
      contentText: item.contentText,
      contentHtml: item.contentHtml,
      media: item.media,
      interactionData,
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
      publishedAt: item.publishedAt,
    },
  };
}

// ─── Mastodon ───────────────────────────────────────────────────────────────

async function pollMastodon(p: PresenceRow, backfillFrom: Date, walk: Walk): Promise<void> {
  if (!p.service_url || !p.credentials_enc)
    throw new Error("presence has no instance or credentials");
  const creds = decryptJson<MastodonCredentials>(p.credentials_enc);
  for (const scope of ["read:notifications", "read:statuses"] as const) {
    if (!hasMastodonScope(creds.scope, scope))
      throw new NeedsReconnect(`${NOTIFICATIONS_NEEDS_RECONNECT} the token lacks ${scope}`);
  }
  const homeHost = new URL(p.service_url).hostname;
  const parents = new Map<string, MastodonStatus | null>();
  const resolveParent = async (localId: string) => {
    if (!parents.has(localId))
      parents.set(localId, await readHomeInstanceStatus(p.service_url!, creds, localId));
    return parents.get(localId) ?? null;
  };

  const handlePage = async (page: MastodonNotification[], firstPoll: boolean) => {
    for (const n of page) {
      if (!firstPoll || n.status.createdAt >= backfillFrom) {
        const hit = await mastodonHit(p, n, homeHost, resolveParent);
        if (hit) countOutcome(walk, await handleHit(p, hit));
        else walk.skipped++;
      }
      walk.cursor = n.id;
    }
  };

  if (p.notifications_cursor === null) {
    // The first poll reads the newest page only, bounded by the backfill
    // window, and starts the cursor at its newest id — linking an account does
    // not replay its history.
    await handlePage(await listMastodonNotifications(p.service_url, creds, null), true);
    return;
  }
  // A forward walk from the cursor: `min_id` answers the page just after it,
  // so a cap stops at a resume point rather than dropping the oldest.
  for (let page = 0; page < MAX_PAGES; page++) {
    const items = await listMastodonNotifications(p.service_url, creds, walk.cursor);
    const fresh = walk.cursor
      ? items.filter((n) => compareMastodonIds(n.id, walk.cursor!) > 0)
      : items;
    await handlePage(fresh, false);
    if (items.length < MASTODON_PAGE_LIMIT) return;
  }
  walk.truncated = true;
  logger.info({ presenceId: p.id }, "linked notifications: Mastodon walk paused at the page cap");
}

export async function mastodonHit(
  p: { external_id: string },
  n: MastodonNotification,
  homeHost: string,
  resolveParent: (localId: string) => Promise<MastodonStatus | null>,
): Promise<Hit | null> {
  const s = n.status;
  const actor = s.account?.uri ?? null;
  // No actor uri, nowhere to anchor the row and no identity to block on.
  if (!s.account || !actor) return null;
  let sourceReplyUri: string | null = null;
  if (s.inReplyToId) {
    const parent = await resolveParent(s.inReplyToId);
    if (!parent) return null; // the parent is gone: skipped, never filed as a root
    sourceReplyUri = parent.uri;
  }
  const kind: Kind =
    n.type === "quote"
      ? "external_quote"
      : s.inReplyToId && n.inReplyToAccountId === p.external_id
        ? "external_reply"
        : "external_mention";
  return {
    kind,
    protocol: "activitypub",
    authorKey: actor,
    targetUri: kind === "external_quote" ? s.quoteUri : sourceReplyUri,
    node: {
      // `uri`, the federated id — never the human `url` (the id-space rule).
      sourceItemUri: s.uri,
      sourceReplyUri,
      sourceQuoteUri: s.quoteUri,
      authorName: s.account.displayName || s.account.acct,
      // The member's instance names a remote author relative to itself.
      authorHandle: qualifyAcct(s.account.acct, homeHost),
      authorAvatarUrl: s.account.avatar,
      authorUri: actor,
      contentText: stripHtml(s.contentHtml),
      contentHtml: sanitizeContent(s.contentHtml),
      media: s.media.map((m) => ({
        type: m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
        url: m.url,
        thumbnail: m.preview_url ?? undefined,
        alt: m.description ?? undefined,
      })),
      interactionData: { id: s.uri, ...(s.url ? { webUrl: s.url } : {}) },
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
      publishedAt: s.createdAt,
    },
  };
}

// ─── One hit ────────────────────────────────────────────────────────────────

function countOutcome(walk: Walk, outcome: HitOutcome): void {
  if (outcome === "notified") walk.notified++;
  else if (outcome === "self" || outcome === "blocked") walk.skipped++;
}

export async function handleHit(
  p: { id: string; account_id: string; protocol: string; external_id: string },
  hit: Hit,
): Promise<HitOutcome> {
  if (hit.authorKey === p.external_id) return "self";
  if (await isSourceUriBlocked(hit.protocol, hit.authorKey)) return "blocked";
  return withTransaction(async (client) => {
    const source = await ensureShadowSource(hit.protocol, hit.authorKey, client);
    if (!source) throw new Error(`no source row for ${hit.protocol} ${hit.authorKey}`);
    await persistHydratedThreadNodes(source.id, hit.protocol, [hit.node], { client });
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM external_items WHERE protocol = $1::external_protocol AND source_item_uri = $2`,
      [hit.protocol, hit.node.sourceItemUri],
    );
    const itemId = rows[0]?.id;
    if (!itemId) throw new Error(`persisted item not found: ${hit.node.sourceItemUri}`);
    let noteId: string | null = null;
    if (hit.targetUri) {
      const echo = await client.query<{ id: string }>(ECHO_NOTE_SQL, [
        p.account_id,
        hit.protocol,
        hit.targetUri,
      ]);
      noteId = echo.rows[0]?.id ?? null;
    }
    const ins = await client.query(EXTERNAL_NOTIFICATION_INSERT_SQL, [
      p.account_id,
      hit.kind,
      itemId,
      noteId,
    ]);
    return (ins.rowCount ?? 0) > 0 ? "notified" : "duplicate";
  });
}

// ─── Dials ──────────────────────────────────────────────────────────────────

const warnedMalformed = new Set<string>();

/** A fallback is for an ABSENT value; a malformed one falls back too, but
 *  says so once (the ops rule). */
export function dialInt(
  cfg: Map<string, string>,
  key: keyof typeof LINKED_NOTIFICATION_FALLBACKS,
): number {
  const raw = cfg.get(key);
  const fallback = LINKED_NOTIFICATION_FALLBACKS[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  if (!warnedMalformed.has(key)) {
    warnedMalformed.add(key);
    logger.warn({ key, value: raw, fallback }, "platform_config value malformed; using fallback");
  }
  return fallback;
}
