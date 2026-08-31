import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// ActivityPub identity resolution
//
// Two entry points:
//   resolveWebFinger(acct)   — resolves acct:user@domain to an actor URI via
//                              https://domain/.well-known/webfinger
//   fetchActorProfile(uri)   — fetches an actor document and returns display
//                              metadata. The universal resolver uses this for
//                              both fediverse handles and Mastodon URLs.
// =============================================================================

const AP_ACCEPT =
  'application/activity+json, application/ld+json;profile="https://www.w3.org/ns/activitystreams", application/json;q=0.9';

interface ActorProfile {
  actorUri: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  handle: string | null; // e.g. alice@mastodon.social
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
}

// -----------------------------------------------------------------------------
// WebFinger: acct:user@domain → actor URI
// -----------------------------------------------------------------------------

export async function resolveWebFinger(acct: string): Promise<string | null> {
  const clean = acct.replace(/^@+/, "");
  const [user, domain] = clean.split("@");
  if (!user || !domain) return null;

  const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${clean}`)}`;
  try {
    const res = await safeFetch(url, {
      headers: { Accept: "application/jrd+json, application/json" },
    });
    if (!res.ok) return null;
    const body = JSON.parse(res.text);
    const links = Array.isArray(body.links) ? body.links : [];
    for (const link of links) {
      if (
        link?.rel === "self" &&
        (link?.type === "application/activity+json" ||
          link?.type ===
            'application/ld+json; profile="https://www.w3.org/ns/activitystreams"') &&
        typeof link.href === "string"
      ) {
        return link.href;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ acct, err }, "WebFinger resolution failed");
    return null;
  }
}

// -----------------------------------------------------------------------------
// Canonical acct shape (user@domain, no leading @) — shared by addSource's
// AP liveness leg (source-liveness.ts, which superseded the §5.2
// resolveApSourceUri normaliser 2026-07-10, audit F1) so the malformed /
// unreachable error split keys off the same shape webfinger accepts.
// -----------------------------------------------------------------------------

const ACCT_SHAPE = /^[\w.+-]+@[\w.-]+\.[\w.]+$/;

export function isAcctShape(s: string): boolean {
  return ACCT_SHAPE.test(s);
}

// -----------------------------------------------------------------------------
// Actor fetch → profile metadata
// -----------------------------------------------------------------------------

export async function fetchActorProfile(
  actorUri: string,
): Promise<ActorProfile | null> {
  try {
    const res = await safeFetch(actorUri, { headers: { Accept: AP_ACCEPT } });
    if (!res.ok) return null;
    const actor = JSON.parse(res.text);
    if (!actor || typeof actor !== "object") return null;

    const id = typeof actor.id === "string" ? actor.id : actorUri;
    let host: string;
    try {
      host = new URL(id).hostname;
    } catch {
      return null;
    }

    const username =
      typeof actor.preferredUsername === "string"
        ? actor.preferredUsername
        : null;
    const handle = username ? `${username}@${host}` : null;
    const avatar = extractImageUrl(actor.icon);
    const description =
      typeof actor.summary === "string" ? stripTags(actor.summary) : null;

    return {
      actorUri: id,
      displayName:
        typeof actor.name === "string" && actor.name ? actor.name : handle,
      description,
      avatar,
      handle,
      followersCount:
        typeof actor.followers_count === "number"
          ? actor.followers_count
          : undefined,
      followingCount:
        typeof actor.following_count === "number"
          ? actor.following_count
          : undefined,
      postsCount:
        typeof actor.statuses_count === "number"
          ? actor.statuses_count
          : undefined,
    };
  } catch (err) {
    logger.warn({ actorUri, err }, "Actor fetch failed");
    return null;
  }
}

function extractImageUrl(obj: any): string | null {
  if (!obj) return null;
  if (typeof obj === "string") return obj;
  if (typeof obj.url === "string") return obj.url;
  if (Array.isArray(obj) && obj.length > 0) return extractImageUrl(obj[0]);
  return null;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// -----------------------------------------------------------------------------
// URL patterns — a Mastodon profile URL can take several shapes:
//   https://mastodon.social/@alice
//   https://mastodon.social/users/alice
//   https://mastodon.social/@alice@other.instance  (remote profile view)
//
// Returns an `acct:` handle ready for WebFinger, or an actor URI if the URL
// is already actor-shaped.
// -----------------------------------------------------------------------------

export function extractFromMastodonUrl(
  url: URL,
): { acct?: string; actorUri?: string } | null {
  const path = url.pathname;

  // /@alice or /@alice@remote.host
  const atMatch = path.match(/^\/@([^/@]+)(?:@([^/]+))?\/?$/);
  if (atMatch) {
    const user = atMatch[1];
    const remoteHost = atMatch[2] ?? url.hostname;
    return { acct: `${user}@${remoteHost}` };
  }

  // /users/alice → looks actor-shaped, return as-is
  const usersMatch = path.match(/^\/users\/([^/]+)\/?$/);
  if (usersMatch) {
    return { actorUri: `${url.origin}/users/${usersMatch[1]}` };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Mastodon-API follow graph (FOLLOW-GRAPH-IMPORT-ADR §5.3, Phase 1c)
//
// The graph read is the Mastodon client API, not raw ActivityPub (AP
// `following` collections are commonly hidden or unpaged; the client API is
// what both the authed linked-token path and the public pasted-handle path
// speak). Live-verified against mastodon.social 2026-07-12:
//   - GET /api/v1/accounts/lookup?acct=…  is public and returns the numeric
//     account id + following_count + the actor `uri`
//   - GET /api/v1/accounts/:id/following  is public unless the account hides
//     follows (then it returns an EMPTY LIST, not an error — detection is
//     empty + following_count > 0); with a token it authorises scope
//     `read` ∪ `read:accounts` (mastodon/mastodon main,
//     following_accounts_controller.rb) — our linked tokens carry
//     `read:accounts` — and the self-call bypasses hidden-follows entirely
//   - pagination is a Link header rel="next" with max_id, newest follow
//     first, ≤80/page — so a capped read keeps the freshest slice
//   - each entry is an Account entity whose `uri` IS the canonical actor URI
//     (local and remote alike), so canonicalisation is free on ≥4.2 origin
//     instances; WebFinger is only the fallback for older serializers
// -----------------------------------------------------------------------------

export interface MastodonApiAccount {
  id: string;
  acct: string;
  /** Actor URI (canonical stored form) — absent on pre-4.2 origin instances. */
  uri: string | null;
  displayName: string | null;
  avatar: string | null;
  followingCount: number | null;
}

function parseApiAccount(raw: unknown): MastodonApiAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || typeof a.acct !== "string") return null;
  let uri: string | null = null;
  if (typeof a.uri === "string") {
    try {
      if (new URL(a.uri).protocol === "https:") uri = a.uri;
    } catch {
      // not a URL — leave null, the WebFinger fallback handles it
    }
  }
  return {
    id: a.id,
    acct: a.acct,
    uri,
    displayName:
      typeof a.display_name === "string" && a.display_name
        ? a.display_name
        : null,
    avatar: typeof a.avatar === "string" ? a.avatar : null,
    followingCount:
      typeof a.following_count === "number" ? a.following_count : null,
  };
}

export async function lookupMastodonAccount(
  apiOrigin: string,
  acct: string,
): Promise<MastodonApiAccount | null> {
  try {
    const res = await safeFetch(
      `${apiOrigin}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    return parseApiAccount(JSON.parse(res.text));
  } catch (err) {
    logger.warn({ apiOrigin, acct, err }, "Mastodon account lookup failed");
    return null;
  }
}

// Link: <https://host/api/v1/accounts/1/following?max_id=…>; rel="next", …
// Only a same-origin next URL is honoured — the header is remote-controlled
// input and the pager must never be steered off the instance it started on.
export function parseNextLink(
  linkHeader: string | null,
  apiOrigin: string,
): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (!m) continue;
    try {
      const url = new URL(m[1]);
      if (url.origin === new URL(apiOrigin).origin) return url.toString();
    } catch {
      // malformed — ignore
    }
    return null;
  }
  return null;
}

// Page through /following. Mirrors atproto getFollows' failure contract:
// null only when the FIRST page fails (bad token / account gone / instance
// not speaking the Mastodon API); a mid-pagination failure returns the
// partial list rather than discarding pages already fetched. `complete` is
// false whenever the read was BOUNDED (cap hit with a next link remaining,
// mid-pagination failure, malformed page) — pagination's own verdict, never
// the actor's following_count, which drifts (suspended/moved accounts) and
// would falsely suppress sync removals.
export interface MastodonFollowingRead {
  accounts: MastodonApiAccount[];
  complete: boolean;
}

export async function fetchMastodonFollowing(
  apiOrigin: string,
  accountId: string,
  cap: number,
  accessToken?: string,
): Promise<MastodonFollowingRead | null> {
  const accounts: MastodonApiAccount[] = [];
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let next: string | null =
    `${apiOrigin}/api/v1/accounts/${encodeURIComponent(accountId)}/following?limit=80`;
  let firstPage = true;
  // Hard page ceiling. The origin is attacker-steerable (it derives from a
  // user-pasted handle) and loop progress is measured in PARSED accounts, so
  // a hostile instance serving non-empty pages of unparseable entries plus an
  // endless same-origin rel=next chain would otherwise never terminate.
  // cap/80 pages covers a well-behaved graph; the slack absorbs sparse pages.
  // Hitting the ceiling is a truncated read (complete: false), which the sync
  // engine already treats as removal-suppressing.
  const maxPages = Math.ceil(cap / 80) + 7;
  let pages = 0;
  while (next && accounts.length < cap) {
    if (++pages > maxPages) return { accounts, complete: false };
    let page: unknown;
    let linkHeader: string | null = null;
    try {
      const res = await safeFetch(next, { headers });
      if (!res.ok) throw new Error(`following returned HTTP ${res.status}`);
      linkHeader = res.headers?.get?.("link") ?? null;
      page = JSON.parse(res.text);
    } catch (err) {
      logger.warn(
        { apiOrigin, accountId, page: firstPage ? "first" : "later", err },
        "Mastodon following fetch failed",
      );
      return firstPage ? null : { accounts, complete: false };
    }
    firstPage = false;
    if (!Array.isArray(page)) return { accounts, complete: false };
    if (page.length === 0) return { accounts, complete: true };
    let i = 0;
    for (; i < page.length && accounts.length < cap; i++) {
      const parsed = parseApiAccount(page[i]);
      if (parsed) accounts.push(parsed);
    }
    next = parseNextLink(linkHeader, apiOrigin);
    if (accounts.length >= cap) {
      // Cap bounded the read: complete only if this page was fully consumed
      // and the instance reports no further page.
      return { accounts, complete: i >= page.length && next === null };
    }
  }
  return { accounts, complete: true };
}

// -----------------------------------------------------------------------------
// Threadiverse URL patterns — Lemmy, PieFed, and Mbin use different path
// conventions from Mastodon. All support WebFinger, so we extract an acct
// handle and let the standard resolution path take it from there.
//
//   Lemmy:  /c/community, /u/user
//   Mbin:   /m/magazine,  /u/user
//   PieFed: /c/community, /u/user (same as Lemmy)
// -----------------------------------------------------------------------------

export function extractFromThreadiverseUrl(url: URL): { acct: string } | null {
  const path = url.pathname;

  // /c/community or /m/magazine (community/magazine actor)
  const communityMatch = path.match(/^\/[cm]\/([A-Za-z0-9_]+)\/?$/);
  if (communityMatch) {
    return { acct: `${communityMatch[1]}@${url.hostname}` };
  }

  // /u/user (user actor)
  const userMatch = path.match(/^\/u\/([A-Za-z0-9_]+)\/?$/);
  if (userMatch) {
    return { acct: `${userMatch[1]}@${url.hostname}` };
  }

  return null;
}
