import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import logger from "@platform-pub/shared/lib/logger.js";

// =============================================================================
// AT Protocol (Bluesky) identity resolution helpers.
//
// Phase 3: read-only resolution. We talk to the public AppView — no auth
// required for identity resolution or profile reads:
//
//   com.atproto.identity.resolveHandle — handle → DID
//   app.bsky.actor.getProfile          — DID/handle → display metadata
//
// All fetches go through safeFetch (SSRF-hardened; 10s timeout, 5MB cap,
// 3-redirect max).
//
// Note: we use the AppView for everything rather than resolving handles
// via DNS TXT / .well-known/atproto-did and then hitting the user's PDS
// directly. The AppView does the same work and is the canonical public
// read interface. If/when we add outbound posting (Phase 5) we'll need
// the real PDS URL — we'll do that via the DID doc at that point.
// =============================================================================

const APPVIEW = "https://public.api.bsky.app";

interface AtprotoProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
}

const DID_RE = /^did:(?:plc|web):[A-Za-z0-9._:-]+$/;

export function isDid(s: string): boolean {
  return DID_RE.test(s);
}

// Strip an optional leading @ and normalise to lowercase. AT Protocol handles
// are case-insensitive per the spec.
export function normaliseHandle(h: string): string {
  return h.replace(/^@/, "").toLowerCase();
}

// Extract a handle or DID from a Bluesky profile URL.
// Matches: https://bsky.app/profile/handle.bsky.social
//          https://bsky.app/profile/did:plc:...
export function extractFromBskyUrl(url: URL): string | null {
  if (url.hostname !== "bsky.app" && url.hostname !== "staging.bsky.app")
    return null;
  const m = url.pathname.match(/^\/profile\/([^\/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// =============================================================================
// searchActors: free-text name → candidate profiles (discovery fallback)
//
// app.bsky.actor.searchActors is the public AppView's purpose-built typeahead.
// Unlike resolveHandle/getProfile (exact identifier → one result) this takes a
// partial name ("Guardian") and returns ranked candidate accounts. Used by the
// resolver's discovery fallback (UNIVERSAL-FEED-ADR §V.5.8, branch 1) to turn a
// name the deterministic chains can't resolve into a pickable candidate list.
// No auth required.
// =============================================================================

export async function searchActors(
  query: string,
  limit = 5,
): Promise<AtprotoProfile[]> {
  const q = query.trim();
  if (!q) return [];
  // Clamp to the lexicon's allowed range (1–100) — we only want a short list.
  const clamped = Math.min(Math.max(limit, 1), 100);
  try {
    const res = await safeFetch(
      `${APPVIEW}/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(q)}&limit=${clamped}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return [];
    const data = JSON.parse(res.text) as { actors?: unknown };
    if (!Array.isArray(data.actors)) return [];
    const profiles: AtprotoProfile[] = [];
    for (const raw of data.actors) {
      if (typeof raw !== "object" || raw === null) continue;
      const actor = raw as {
        did?: unknown;
        handle?: unknown;
        displayName?: unknown;
        description?: unknown;
        avatar?: unknown;
      };
      if (typeof actor.did !== "string" || !isDid(actor.did)) continue;
      if (typeof actor.handle !== "string") continue;
      profiles.push({
        did: actor.did,
        handle: actor.handle,
        displayName:
          typeof actor.displayName === "string"
            ? actor.displayName
            : undefined,
        description:
          typeof actor.description === "string"
            ? actor.description
            : undefined,
        avatar: typeof actor.avatar === "string" ? actor.avatar : undefined,
      });
    }
    return profiles;
  } catch (err) {
    logger.warn({ query: q, err }, "searchActors failed");
    return [];
  }
}

// =============================================================================
// getFollows: DID → the accounts this actor follows (FOLLOW-GRAPH-IMPORT-ADR
// §5.1). Public AppView, no auth, paginated at ~100/page; the AppView returns
// most-recently-followed first, so a capped read keeps the freshest slice of
// the graph. Stops at `cap` follows or when the cursor runs out. Returns null
// only when the FIRST page fails (actor unknown / AppView unreachable) —
// a mid-pagination failure returns the partial list rather than discarding
// pages already fetched. `complete` is false whenever the read was BOUNDED —
// cap hit with a cursor remaining, a mid-pagination failure, or a malformed
// page — and must come only from the pagination machinery, never from the
// profile's followsCount (which counts deactivated accounts the AppView
// omits; deriving truncation from it suppressed sync removals for nearly
// every aged account — the 2026-07-12 run-through bug).
// =============================================================================

export interface AtprotoFollow {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

export interface AtprotoFollowsRead {
  follows: AtprotoFollow[];
  complete: boolean;
}

export async function getFollows(
  actorDid: string,
  cap: number,
): Promise<AtprotoFollowsRead | null> {
  const follows: AtprotoFollow[] = [];
  let cursor: string | undefined;
  let firstPage = true;
  // Hard page ceiling — the AppView host is pinned (not attacker-steerable),
  // but loop progress is measured in VALID parsed follows, so an AppView
  // regression emitting non-advancing cursors with empty/unparseable pages
  // would otherwise wedge the import route or sweep in a hot loop. Ceiling
  // hit = truncated read (complete: false), which suppresses sync removals.
  const maxPages = Math.ceil(cap / 100) + 7;
  let pages = 0;
  while (follows.length < cap) {
    if (++pages > maxPages) return { follows, complete: false };
    const limit = Math.min(100, cap - follows.length);
    const params = new URLSearchParams({ actor: actorDid, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    let data: { follows?: unknown; cursor?: unknown };
    try {
      const res = await safeFetch(
        `${APPVIEW}/xrpc/app.bsky.graph.getFollows?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`AppView returned HTTP ${res.status}`);
      data = JSON.parse(res.text) as { follows?: unknown; cursor?: unknown };
    } catch (err) {
      logger.warn(
        { actorDid, page: firstPage ? "first" : "later", err },
        "getFollows failed",
      );
      return firstPage ? null : { follows, complete: false };
    }
    firstPage = false;
    if (!Array.isArray(data.follows))
      return { follows, complete: false };
    let i = 0;
    for (; i < data.follows.length && follows.length < cap; i++) {
      const raw = data.follows[i];
      if (typeof raw !== "object" || raw === null) continue;
      const f = raw as {
        did?: unknown;
        handle?: unknown;
        displayName?: unknown;
        avatar?: unknown;
      };
      if (typeof f.did !== "string" || !isDid(f.did)) continue;
      if (typeof f.handle !== "string") continue;
      follows.push({
        did: f.did,
        handle: f.handle,
        displayName:
          typeof f.displayName === "string" ? f.displayName : undefined,
        avatar: typeof f.avatar === "string" ? f.avatar : undefined,
      });
    }
    const nextCursor =
      typeof data.cursor === "string" && data.cursor !== "" ? data.cursor : null;
    if (follows.length >= cap) {
      // Cap bounded the read: complete only if this page was fully consumed
      // and the AppView reports nothing beyond it.
      return {
        follows,
        complete: i >= data.follows.length && nextCursor === null,
      };
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { follows, complete: true };
}

// =============================================================================
// resolveHandle: handle → DID
// =============================================================================

export async function resolveHandle(handle: string): Promise<string | null> {
  const normalised = normaliseHandle(handle);
  try {
    const res = await safeFetch(
      `${APPVIEW}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalised)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as { did?: unknown };
    return typeof data.did === "string" && isDid(data.did) ? data.did : null;
  } catch (err) {
    logger.warn({ handle, err }, "resolveHandle failed");
    return null;
  }
}

// =============================================================================
// getProfile: DID or handle → display metadata
// =============================================================================

export async function getProfile(
  actor: string,
): Promise<AtprotoProfile | null> {
  const normalised = actor.startsWith("did:") ? actor : normaliseHandle(actor);
  try {
    const res = await safeFetch(
      `${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(normalised)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as {
      did?: unknown;
      handle?: unknown;
      displayName?: unknown;
      description?: unknown;
      avatar?: unknown;
      followersCount?: unknown;
      followsCount?: unknown;
      postsCount?: unknown;
    };
    if (typeof data.did !== "string" || !isDid(data.did)) return null;
    if (typeof data.handle !== "string") return null;
    return {
      did: data.did,
      handle: data.handle,
      displayName:
        typeof data.displayName === "string" ? data.displayName : undefined,
      description:
        typeof data.description === "string" ? data.description : undefined,
      avatar: typeof data.avatar === "string" ? data.avatar : undefined,
      followersCount:
        typeof data.followersCount === "number"
          ? data.followersCount
          : undefined,
      followsCount:
        typeof data.followsCount === "number" ? data.followsCount : undefined,
      postsCount:
        typeof data.postsCount === "number" ? data.postsCount : undefined,
    };
  } catch (err) {
    logger.warn({ actor, err }, "getProfile failed");
    return null;
  }
}
