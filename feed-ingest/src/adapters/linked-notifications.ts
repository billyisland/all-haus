import { getAtprotoClient } from "@platform-pub/shared/lib/atproto-oauth.js";
import type { BskyPostRecord } from "./atproto.js";

// =============================================================================
// Linked-account notifications — READ from the member's own network, as them
// (CROSS-NETWORK-ROUNDTRIP-ADR C1). The Bluesky reader is here; the two
// Mastodon reads are in activitypub-outbound.ts, the one file where an
// AUTHENTICATED call on a member's own instance is spelled (the endpoint→scope
// pin reads that file, and the public-read guard names it as the exception).
//
// Why the notifications API and not the firehose: it is the network's own
// answer to "what was addressed to this person". It covers mentions and quotes
// as well as replies, it has already applied the member's own remote mutes and
// blocks (C-Q3), and Mastodon has no firehose at all.
//
// Both readers answer a page or THROW. The caller (the poll task) splits the
// throw: a refused credential invalidates the presence, anything else is a
// failed poll that leaves the cursor where it was.
// =============================================================================

/** The three reasons rung C notifies on (C-Q1). Likes, reposts and follows are
 *  deliberately not asked for: high volume, low signal. */
export const BLUESKY_REASONS = ["reply", "mention", "quote"] as const;

export interface BlueskyNotification {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  reason: string;
  /** For a reply/quote, the post of the member's that was answered/quoted. */
  reasonSubject?: string;
  record: BskyPostRecord;
  indexedAt: string;
}

export interface BlueskyNotificationPage {
  notifications: BlueskyNotification[];
  /** The API's own paging cursor (older), absent on the last page. */
  cursor?: string;
}

const BSKY_PAGE_LIMIT = 50;

/**
 * One page of the member's notifications, NEWEST first — the only order
 * `listNotifications` offers. Through the member's OAuth session, whose
 * `transition:generic` grant covers app.bsky reads; the PDS proxies the call
 * to its AppView. `restore` throws the OAuth client's own TokenRevokedError /
 * TokenInvalidError for a session that is gone (presence-health reads them).
 */
export async function listBlueskyNotifications(
  did: string,
  pageCursor?: string,
): Promise<BlueskyNotificationPage> {
  const client = await getAtprotoClient();
  const session = await client.restore(did);
  const qs = new URLSearchParams({ limit: String(BSKY_PAGE_LIMIT) });
  for (const r of BLUESKY_REASONS) qs.append("reasons", r);
  if (pageCursor) qs.set("cursor", pageCursor);
  const res = await session.fetchHandler(
    `/xrpc/app.bsky.notification.listNotifications?${qs.toString()}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Bluesky listNotifications HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as {
    notifications?: unknown[];
    cursor?: string;
  };
  const notifications = (body.notifications ?? []).filter(
    isBlueskyNotification,
  );
  return { notifications, cursor: body.cursor };
}

function isBlueskyNotification(raw: unknown): raw is BlueskyNotification {
  if (typeof raw !== "object" || raw === null) return false;
  const n = raw as Record<string, unknown>;
  const a = n.author as Record<string, unknown> | undefined;
  const rec = n.record as Record<string, unknown> | undefined;
  return (
    typeof n.uri === "string" &&
    typeof n.cid === "string" &&
    typeof n.reason === "string" &&
    typeof n.indexedAt === "string" &&
    typeof a?.did === "string" &&
    typeof a?.handle === "string" &&
    typeof rec?.text === "string"
  );
}
