import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import { fetchApDocument } from "@platform-pub/shared/lib/activitypub-fetch.js";
import { authoritativeId } from "@platform-pub/shared/lib/activitypub-origin.js";
import {
  fetchMastodonAccountByActorUri,
  isSignedFetchRefusal,
  lookupMastodonAccountByAcct,
  mastodonAccountIdentity,
  parseMastodonAccount,
  qualifyAcct,
  readMastodonFollowing,
  readMastodonJson,
  type MastodonAccount,
} from "@platform-pub/shared/lib/mastodon-api.js";
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

interface ActorProfile {
  actorUri: string;
  displayName: string | null;
  description: string | null;
  avatar: string | null;
  handle: string | null; // e.g. alice@mastodon.social
  // Counts an AP actor document does NOT carry: `followers_count` and friends
  // are Mastodon CLIENT-API field names, so the AP arm always left these
  // undefined and `fetchAPProfile` always fell through to its REST count
  // fallback. The client-API arm below really does have them, so on a
  // secure-mode instance the counts now arrive with the profile and that
  // fallback is spared a round trip.
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

/**
 * An actor document, or a verdict on whether the SECOND door is worth trying.
 *
 * `retryable` is the whole point of the shape: an instance in secure mode
 * (`AUTHORIZED_FETCH`) answers 401 to our unsigned GET, and a transport fault
 * or timeout (a reported mastodon.social tarpit, not reproduced) — neither
 * is a fact about the ACCOUNT, and the client API answers both. A 404/410 IS a
 * fact about the account, and a non-authoritative id is a REFUSAL (§2.9): both
 * end here rather than getting a second chance at the same claim.
 */
type ApActorAttempt =
  | { ok: true; profile: ActorProfile }
  | { ok: false; retryable: boolean; signedFetchRefused: boolean };

/**
 * The profile, plus WHY there isn't one.
 *
 * `signedFetchRefused` is the difference between "there is no such account"
 * and "this instance will not let us read, and we cannot make it". They are
 * the same `null` to every caller that only wants the profile, and they are
 * two entirely different sentences to a member who has just pasted a handle —
 * one is their typo, the other is our missing capability. `addSource`'s
 * liveness leg is the surface that has to tell them apart, which is the whole
 * reason this shape exists beside the plain fetcher below.
 */
export interface ApProfileAttempt {
  profile: ActorProfile | null;
  signedFetchRefused: boolean;
}

export async function fetchActorProfileWithVerdict(
  actorUri: string,
): Promise<ApProfileAttempt> {
  const direct = await fetchActorProfileViaAp(actorUri);
  if (direct.ok) return { profile: direct.profile, signedFetchRefused: false };
  if (!direct.retryable)
    return { profile: null, signedFetchRefused: direct.signedFetchRefused };
  const profile = await fetchActorProfileViaMastodonApi(actorUri);
  // The refusal only survives if the client API could not stand in either —
  // a source we CAN read is not a source we are locked out of, whatever the
  // front door said.
  return {
    profile,
    signedFetchRefused: profile === null && direct.signedFetchRefused,
  };
}

export async function fetchActorProfile(
  actorUri: string,
): Promise<ActorProfile | null> {
  return (await fetchActorProfileWithVerdict(actorUri)).profile;
}

async function fetchActorProfileViaAp(
  actorUri: string,
): Promise<ApActorAttempt> {
  try {
    // Unsigned, then SIGNED if the instance refused the unsigned read
    // (`shared/lib/activitypub-fetch.ts`). `signedFetchRefused` means the
    // refusal survived a signature, so the client API is the last door.
    const { res, signedFetchRefused } = await fetchApDocument(actorUri);
    if (!res.ok) {
      if (signedFetchRefused)
        logger.info(
          { actorUri, status: res.status },
          "Actor fetch refused even signed — trying the Mastodon client API",
        );
      return {
        ok: false,
        retryable: isSignedFetchRefusal(res.status),
        signedFetchRefused,
      };
    }
    const actor = JSON.parse(res.text);
    if (!actor || typeof actor !== "object")
      return { ok: false, retryable: true, signedFetchRefused: false };

    // An actor may only claim an id on the origin that served it (§2.9,
    // `shared/lib/activitypub-origin.ts`). The authority is the post-redirect
    // `res.url`, never the uri we asked for; and a document that fails it is
    // REFUSED, where the old `actor.id ?? actorUri` quietly substituted the
    // safe value. This half is less consequential than the ingest half — the
    // uri lands on `external_sources.source_uri`, which the poller then
    // fetches — but the same rule is cheaper than the argument for exempting
    // it.
    const id = authoritativeId(actor.id, res.url);
    if (!id) {
      logger.warn(
        { actorUri, servedBy: res.url },
        "Actor id is not authoritative for the host that served it",
      );
      // NOT retryable: the refusal is the finding. Asking the same host's
      // client API would be giving the claim a second door. And it is OURS,
      // not a signed-fetch refusal — the instance answered us perfectly well.
      return { ok: false, retryable: false, signedFetchRefused: false };
    }
    // `authoritativeId` has already parsed it as an http(s) URL.
    const host = new URL(id).hostname;

    const username =
      typeof actor.preferredUsername === "string"
        ? actor.preferredUsername
        : null;
    const handle = username ? `${username}@${host}` : null;
    const avatar = extractImageUrl(actor.icon);
    const description =
      typeof actor.summary === "string" ? stripTags(actor.summary) : null;

    return {
      ok: true,
      profile: {
        actorUri: id,
        displayName:
          typeof actor.name === "string" && actor.name ? actor.name : handle,
        description,
        avatar,
        handle,
      },
    };
  } catch (err) {
    // A throw is a timeout or a transport fault, never a verdict on the
    // account — and a secure-mode instance tarpitting repeat unsigned actor
    // GETs would arrive here rather than as a 401 (reported for mastodon.social;
    // not reproduced 2026-09-25, when six in a row each answered 401 at once).
    // The client API is worth asking either way; ingest's `fetchActor` does the
    // same.
    logger.warn({ actorUri, err }, "Actor fetch failed");
    return { ok: false, retryable: true, signedFetchRefused: false };
  }
}

/**
 * The same profile, read through the instance's client API. §2.9 holds on this
 * door too — `mastodonAccountIdentity` is the check.
 */
async function fetchActorProfileViaMastodonApi(
  actorUri: string,
): Promise<ActorProfile | null> {
  const account = await fetchMastodonAccountByActorUri(actorUri);
  if (!account) return null;
  return mastodonAccountToProfile(account, actorUri);
}

export function mastodonAccountToProfile(
  account: MastodonAccount,
  askedFor: string,
): ActorProfile | null {
  const identity = mastodonAccountIdentity(account, askedFor);
  if (!identity) return null;
  const { id, host } = identity;
  const handle = qualifyAcct(account.acct, host);
  return {
    actorUri: id,
    displayName: account.displayName ?? handle,
    description: account.note ? stripTags(account.note) : null,
    avatar: account.avatar,
    handle,
    followersCount: account.followersCount ?? undefined,
    followingCount: account.followingCount ?? undefined,
    postsCount: account.statusesCount ?? undefined,
  };
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

/** Re-exported: the entity and its parser live in `shared/lib/mastodon-api.ts`,
 *  because feed-ingest reads the same endpoints through the same shapes. */
export type MastodonApiAccount = MastodonAccount;

export async function lookupMastodonAccount(
  apiOrigin: string,
  acct: string,
): Promise<MastodonApiAccount | null> {
  return lookupMastodonAccountByAcct(apiOrigin, acct);
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
  // Page 1 from the home's endpoint; every later page is the instance's own
  // `rel=next`, origin-checked by `parseNextLink` before it is followed.
  let next: string | null = null;
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
  while ((firstPage || next) && accounts.length < cap) {
    if (++pages > maxPages) return { accounts, complete: false };
    let page: unknown;
    let linkHeader: string | null = null;
    try {
      const read = firstPage
        ? await readMastodonFollowing(apiOrigin, accountId, { accessToken })
        : await readMastodonJson(next!, { accessToken });
      if (!read.ok) throw new Error(`following returned HTTP ${read.status}`);
      linkHeader = read.link;
      page = read.body;
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
      const parsed = parseMastodonAccount(page[i]);
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
