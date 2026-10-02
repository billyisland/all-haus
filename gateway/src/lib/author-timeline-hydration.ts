// Profile-view timeline hydration (EXTERNAL-AUTHOR-HISTORY-ADR §3) — the
// profile twin of thread hydration (external-hydration.ts): an on-demand,
// best-effort fetch of an external author's recent timeline into the DB
// substrate GET /author/:id/posts reads, kicked in the background when a
// profile is viewed. Rows are written is_context_only = TRUE (feed-excluded,
// context-GC'd, thread-expandable) AND is_profile_hydrated = TRUE (included in
// /posts). Never throws: every failure logs and returns.
//
// nostr_external (Phase 3), atproto + activitypub (Phase 4). rss/email are out
// of scope (no external_authors record, no /author route).
import { verifyEvent } from "nostr-tools";
import { pool } from "@platform-pub/shared/db/client.js";
import logger from "@platform-pub/shared/lib/logger.js";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  blueskyInteractionData,
  type AtprotoReplyRefs,
} from "@platform-pub/shared/lib/atproto-reply-refs.js";
import { sanitizeContent } from "@platform-pub/shared/lib/sanitize.js";
import { mergeNostrRelayUrls } from "@platform-pub/shared/lib/nip65.js";
import {
  mastodonRefFromActorUri,
  readMastodonAccount,
  readMastodonAccountStatuses,
} from "@platform-pub/shared/lib/mastodon-api.js";
import { authoritativeId } from "@platform-pub/shared/lib/activitypub-origin.js";
import {
  fetchNostrWriteRelays,
  relayCandidates,
} from "@platform-pub/shared/lib/nostr-relay-req.js";
import { fetchNostrEvents } from "./nostr-relay.js";
import {
  parseNostrProfile,
  normaliseNostrThreadNode,
  type RawNostrEvent,
  type NostrProfile,
} from "./nostr-thread.js";
import {
  ensureShadowSource,
  persistHydratedThreadNodes,
} from "@platform-pub/shared/lib/context-persist.js";
import {
  APPVIEW,
  CACHE_MAX_ENTRIES,
  NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  extractBlueskyViewMedia,
  extractBlueskyViewQuoteUri,
  stripHtmlTags,
} from "./external-items-shared.js";

const HYDRATABLE_PROTOCOLS = new Set([
  "nostr_external",
  "atproto",
  "activitypub",
]);

// Match the thread-hydration budget/caps (external-hydration.ts).
const TIMELINE_RELAY_CAP = 6;
const TIMELINE_REQ_TIMEOUT_MS = 6_000;
const TIMELINE_FETCH_LIMIT = 50;
const TIMELINE_ATPROTO_LIMIT = 30;
const TIMELINE_AP_LIMIT = 30;

// Kill switch (§3.7): Part B is the platform's first request-path-triggered
// outbound fetch fan-out — even bounded and backgrounded it deserves an
// operator brake that doesn't need a deploy. Default ON; "0"/"false" disables.
export function authorTimelineHydrationEnabled(): boolean {
  const v = process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  return v !== "0" && v !== "false";
}

// Per-AUTHOR TTL guard — hydrateGuard's shape including its size-capped
// eviction, but 10 minutes rather than 60s: a hot profile hydrates once, not
// per viewer, and a stale cache refreshes on the next view past the TTL.
const timelineGuard = new Map<string, number>();
const TIMELINE_TTL_MS = 10 * 60_000;

// Would a hydrate run right now (kill switch on, protocol supported, guard
// clear)? Lets the /posts handler decide synchronously whether to kick
// background hydration and flag the response `hydrating`.
export function willHydrateAuthorTimeline(
  authorId: string,
  protocol: string,
): boolean {
  if (!authorTimelineHydrationEnabled()) return false;
  if (!HYDRATABLE_PROTOCOLS.has(protocol)) return false;
  const until = timelineGuard.get(authorId);
  return !(until && until > Date.now());
}

// Exposed for tests only — the guard is otherwise stamped by
// hydrateAuthorTimeline itself.
export function resetAuthorTimelineGuard(): void {
  timelineGuard.clear();
}

function stampGuard(authorId: string): void {
  timelineGuard.set(authorId, Date.now() + TIMELINE_TTL_MS);
  if (timelineGuard.size > CACHE_MAX_ENTRIES) {
    const oldest = timelineGuard.keys().next().value;
    if (oldest !== undefined) timelineGuard.delete(oldest);
  }
}

// ensureShadowSource — the §3.2 storage anchor for an unfollowed author —
// lives in shared/src/lib/context-persist.ts (the notification poller anchors
// on it too) and is re-exported here.
export { ensureShadowSource };

export interface AuthorTimelineTarget {
  authorId: string; // external_authors.id — the TTL-guard key
  protocol: string;
  followUri: string; // authorFollowUri(xa) — the subscribe-path identity
  // external_authors.stable_handle — the EXACT key the profile is served
  // under. Hydrated rows must attribute to THIS author record, and the
  // feed_items identity trigger mints external_authors from
  // external_items.author_uri for atproto/activitypub — so those fetchers pin
  // author_uri to this value verbatim. (Thread hydration's origin-shaped
  // author_uri — bsky.app URL / account web URL — can differ from an
  // ingest-minted stable handle, which would file the timeline under a
  // DIFFERENT author id and never show in /posts.) Unused for nostr, whose
  // trigger keys on interaction_data->>'pubkey'.
  stableHandle: string;
}

// ── nostr_external (§3.5 phase 1) ───────────────────────────────────────────

async function hydrateNostrTimeline(target: AuthorTimelineTarget): Promise<void> {
  const pubkey = target.followUri.toLowerCase();
  const source = await ensureShadowSource(target.protocol, target.followUri);
  if (!source) return;
  const hints = source.relay_urls ?? [];

  // NIP-65 write relays ∪ shadow/real source relay_urls ∪ fallbacks, cap 6.
  const writeRelays = await fetchNostrWriteRelays(pubkey, hints);
  const relays = relayCandidates(writeRelays, TIMELINE_RELAY_CAP, hints);
  if (relays.length === 0) return;

  // One REQ — a request-path warm, not an archive pull; depth is the backfill
  // task's job (Part A).
  const events = await fetchNostrEvents(
    relays,
    [
      { kinds: [1, 30023], authors: [pubkey], limit: TIMELINE_FETCH_LIMIT },
      { kinds: [0], authors: [pubkey], limit: 1 },
    ],
    TIMELINE_REQ_TIMEOUT_MS,
  );

  // Pubkey match + signature verification. The gateway trusts relays for
  // thread hydration, but an author timeline feeds a profile claiming to BE
  // this author — verification is required here.
  const valid = events.filter(
    (ev) =>
      ev?.pubkey?.toLowerCase() === pubkey &&
      verifyEvent(ev as unknown as Parameters<typeof verifyEvent>[0]),
  );

  let latestProfile: RawNostrEvent | null = null;
  const items: RawNostrEvent[] = [];
  for (const ev of valid) {
    if (ev.kind === 0) {
      if (!latestProfile || ev.created_at > latestProfile.created_at) {
        latestProfile = ev;
      }
    } else if (ev.kind === 1 || ev.kind === 30023) {
      items.push(ev);
    }
  }

  const profile: NostrProfile = latestProfile
    ? parseNostrProfile(latestProfile.content)
    : { name: null, picture: null, nip05: null, about: null, website: null, lud16: null };

  const nodes = items.map((ev) => normaliseNostrThreadNode(ev, relays, profile));
  await persistHydratedThreadNodes(source.id, "nostr_external", nodes, {
    profileHydrated: true,
  });

  // Persist the discovered write relays onto the shadow row (same union/cap
  // rule as the backfill, §2.2) so a later real subscribe inherits a working
  // relay set.
  if (writeRelays.length > 0) {
    const merged = mergeNostrRelayUrls(hints, writeRelays);
    if (merged.length !== hints.length || merged.some((r, i) => r !== hints[i])) {
      await pool.query(
        `UPDATE external_sources SET relay_urls = $2, updated_at = now()
          WHERE id = $1`,
        [source.id, merged],
      );
    }
  }

  logger.debug(
    {
      authorId: target.authorId,
      relays: relays.length,
      nip65Relays: writeRelays.length,
      fetched: events.length,
      persisted: nodes.length,
    },
    "author timeline hydrate complete",
  );
}

// ── atproto (§3.5 phase 2) ──────────────────────────────────────────────────

interface AtprotoFeedViewPost {
  post?: {
    uri: string;
    cid: string;
    author: { did: string; handle: string; displayName?: string; avatar?: string };
    record?: {
      $type?: string;
      text?: string;
      createdAt?: string;
      reply?: AtprotoReplyRefs;
    };
    embed?: unknown;
    likeCount?: number;
    replyCount?: number;
    repostCount?: number;
  };
  reason?: { $type: string }; // reasonRepost — skip
}

// Map one getAuthorFeed page into hydrated nodes. Pure (exported for tests):
// skips reposts and foreign-DID entries; author_uri is pinned to the profile's
// stable_handle so the identity trigger attributes every row to the exact
// external_authors record the profile is keyed on.
export function extractAtprotoTimelineNodes(
  feed: AtprotoFeedViewPost[],
  did: string,
  stableHandle: string,
) {
  const out = [];
  const seen = new Set<string>();
  for (const entry of feed) {
    if (entry.reason) continue; // repost of someone else's post
    const post = entry.post;
    if (!post?.uri || seen.has(post.uri)) continue;
    if (post.author?.did !== did) continue;
    if (post.record?.$type && post.record.$type !== "app.bsky.feed.post")
      continue;
    seen.add(post.uri);
    out.push({
      sourceItemUri: post.uri,
      sourceReplyUri: post.record?.reply?.parent.uri ?? null,
      sourceQuoteUri: extractBlueskyViewQuoteUri(post.embed),
      authorName: post.author.displayName || post.author.handle,
      authorHandle: post.author.handle,
      authorAvatarUrl: post.author.avatar ?? null,
      authorUri: stableHandle,
      contentText: post.record?.text ?? null,
      contentHtml: null,
      media: extractBlueskyViewMedia(post.embed),
      interactionData: blueskyInteractionData(post),
      likeCount: post.likeCount ?? 0,
      replyCount: post.replyCount ?? 0,
      repostCount: post.repostCount ?? 0,
      publishedAt: new Date(post.record?.createdAt ?? Date.now()),
    });
  }
  return out;
}

async function hydrateAtprotoTimeline(
  target: AuthorTimelineTarget,
): Promise<void> {
  const did = target.followUri;
  const source = await ensureShadowSource("atproto", did);
  if (!source) return;

  // One public AppView page — no auth, same endpoint as the backfill task.
  const url = new URL(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed`);
  url.searchParams.set("actor", did);
  url.searchParams.set("limit", String(TIMELINE_ATPROTO_LIMIT));
  url.searchParams.set("filter", "posts_no_replies");
  const res = await safeFetch(url.toString(), {
    headers: { Accept: "application/json" },
    timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS,
  });
  // Transient trouble (rate limit / server error) must THROW so the catch in
  // hydrateAuthorTimeline clears the TTL guard — a silent return here read as
  // settled and froze this author's timeline hydration for the full 10-minute
  // TTL (§0k.2, the thread-hydration §0f-5 pattern). A definitive 4xx
  // (deleted/blocked account) has nothing to hydrate and stays a clean settle.
  if (res.status === 429 || res.status >= 500)
    throw new Error(`appview author feed fetch failed: ${res.status}`);
  if (!res.ok) return;
  const data = JSON.parse(res.text) as { feed?: AtprotoFeedViewPost[] };

  const nodes = extractAtprotoTimelineNodes(
    data.feed ?? [],
    did,
    target.stableHandle,
  );
  await persistHydratedThreadNodes(source.id, "atproto", nodes, {
    profileHydrated: true,
  });
  logger.debug(
    { authorId: target.authorId, persisted: nodes.length },
    "author timeline hydrate complete (atproto)",
  );
}

// ── activitypub (§3.5 phase 2) ──────────────────────────────────────────────

interface MastodonTimelineStatus {
  id: string;
  uri?: string;
  url?: string;
  content?: string;
  created_at: string;
  in_reply_to_id: string | null;
  reblog?: unknown | null;
  account: { acct: string; display_name?: string; url?: string; avatar?: string };
  media_attachments?: Array<{
    type: string;
    url: string;
    preview_url?: string;
    description?: string;
  }>;
  favourites_count?: number;
  replies_count?: number;
  reblogs_count?: number;
}

// Map a Mastodon-REST statuses page into hydrated nodes. Pure (exported for
// tests): replies and reblogs are skipped (a timeline warm, not a thread
// walk — reblogged content belongs to its own author); statuses are keyed on
// the federated `uri` (the id-space ingest uses), and author_uri is pinned to
// the profile's stable_handle (see AuthorTimelineTarget).
//
// AND A STATUS MAY CLAIM ITS ID ONLY ON THE ORIGIN THAT SERVED THE PAGE
// (CA-A10, 2026-09-29): `apiOrigin` is the instance asked, and a status whose
// federated `uri` names another host is skipped — never keyed on its web url
// instead. The author is already pinned to `stableHandle`, which passed the
// same check when the target was resolved.
export function extractMastodonTimelineNodes(
  statuses: MastodonTimelineStatus[],
  stableHandle: string,
  apiOrigin: string,
) {
  const out = [];
  const seen = new Set<string>();
  for (const s of statuses) {
    const uri = authoritativeId(s.uri, apiOrigin);
    if (!uri || seen.has(uri)) continue;
    if (s.in_reply_to_id != null) continue;
    if (s.reblog) continue;
    seen.add(uri);
    out.push({
      sourceItemUri: uri,
      sourceReplyUri: null,
      sourceQuoteUri: null,
      authorName: s.account.display_name || s.account.acct,
      authorHandle: s.account.acct,
      authorAvatarUrl: s.account.avatar ?? null,
      authorUri: stableHandle,
      contentText: stripHtmlTags(s.content ?? ""),
      contentHtml: sanitizeContent(s.content ?? ""),
      media: (s.media_attachments ?? []).map((m) => ({
        type:
          m.type === "image" ? "image" : m.type === "video" ? "video" : "link",
        url: m.url,
        thumbnail: m.preview_url,
        alt: m.description,
      })),
      interactionData: { id: uri, webUrl: s.url },
      likeCount: s.favourites_count ?? 0,
      replyCount: s.replies_count ?? 0,
      repostCount: s.reblogs_count ?? 0,
      publishedAt: new Date(s.created_at),
    });
  }
  return out;
}

async function hydrateActivityPubTimeline(
  target: AuthorTimelineTarget,
): Promise<void> {
  const actor = target.followUri;
  const source = await ensureShadowSource("activitypub", actor);
  if (!source) return;

  // Mastodon REST (the profile header's established fallback): resolve the
  // account id from the actor handle, then one public statuses page.
  const apiOrigin = `https://${new URL(actor).hostname}`;
  const ref = mastodonRefFromActorUri(actor);
  if (!ref) return;
  const opts = { timeout: NEIGHBOURHOOD_FETCH_TIMEOUT_MS };
  const lookup = await readMastodonAccount(apiOrigin, ref, opts);
  // Same transient/definitive split as the atproto fetch above (§0k.2).
  if (lookup.status === 429 || lookup.status >= 500)
    throw new Error(`mastodon account lookup failed: ${lookup.status}`);
  if (!lookup.ok) return;
  const account = lookup.body as { id?: string } | null;
  if (!account?.id || !/^[A-Za-z0-9_-]+$/.test(account.id)) return;

  const res = await readMastodonAccountStatuses(
    apiOrigin,
    account.id,
    { limit: TIMELINE_AP_LIMIT, excludeReplies: true, excludeReblogs: true },
    opts,
  );
  if (res.status === 429 || res.status >= 500)
    throw new Error(`mastodon statuses fetch failed: ${res.status}`);
  if (!res.ok) return;
  const statuses = res.body as MastodonTimelineStatus[];
  if (!Array.isArray(statuses)) return;

  const nodes = extractMastodonTimelineNodes(statuses, target.stableHandle, apiOrigin);
  await persistHydratedThreadNodes(source.id, "activitypub", nodes, {
    profileHydrated: true,
  });
  logger.debug(
    { authorId: target.authorId, persisted: nodes.length },
    "author timeline hydrate complete (activitypub)",
  );
}

// Public entrypoint: best-effort, TTL-guarded hydration of an external
// author's recent timeline. Kicked `void` (never awaited) from the /posts
// handler; never throws.
export async function hydrateAuthorTimeline(
  target: AuthorTimelineTarget,
): Promise<void> {
  if (!willHydrateAuthorTimeline(target.authorId, target.protocol)) return;
  stampGuard(target.authorId);
  try {
    if (target.protocol === "nostr_external") {
      await hydrateNostrTimeline(target);
    } else if (target.protocol === "atproto") {
      await hydrateAtprotoTimeline(target);
    } else if (target.protocol === "activitypub") {
      await hydrateActivityPubTimeline(target);
    }
  } catch (err) {
    // A failed run must not consume the TTL: clear the guard so the next
    // profile view retries, instead of one transient error freezing this
    // author's timeline hydration for the full 10 minutes (§0k.2 — the D1
    // guard-clear semantics from external-hydration.ts).
    timelineGuard.delete(target.authorId);
    logger.debug(
      {
        err: err instanceof Error ? err.message : String(err),
        authorId: target.authorId,
        protocol: target.protocol,
      },
      "Author timeline hydration failed",
    );
  }
}
