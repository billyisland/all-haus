import { nip19 } from "nostr-tools";
import { safeFetch } from "@platform-pub/shared/lib/http-client.js";
import {
  getProfile as atprotoGetProfile,
  isDid as isAtprotoDid,
} from "./atproto-resolve.js";
import {
  resolveWebFinger,
  fetchActorProfile,
  isAcctShape,
} from "./activitypub-resolve.js";
import {
  fetchNostrProfile,
  getDefaultProfileRelays,
} from "./nostr-search.js";

// =============================================================================
// Source liveness verification for addSource (2026-07-09 resolver audit F1).
//
// addSource's (protocol, sourceUri) branch historically validated SYNTAX only
// — a well-formed dead RSS URL, nonexistent DID, or random hex pubkey got 201
// Created plus a live subscription, and the failure surfaced solely as an
// asynchronously climbing error_count the user never saw. All real
// verification lived in /resolve, which sat on the write path by frontend
// convention only. This module makes addSource self-sufficient: every
// (protocol, sourceUri) input is normalised to its canonical stored form
// (acct → actor URI, atproto handle → DID, npub/nprofile → hex — the
// omnivorous-input rule) and probed for liveness before any write.
//
// The two failure modes are distinguished (the audit's error-space split):
//   malformed   — the input can never name a source in this protocol (→ 400)
//   unreachable — well-formed, but no live target answered for it     (→ 422)
//
// Operator brake: SOURCE_LIVENESS_ENFORCED=0 skips the network PROBE for
// inputs already in canonical form (pre-F1 behaviour, e.g. if the default
// nostr relays are collectively down), but normalisation of non-canonical
// forms always runs — an acct or handle cannot be stored un-resolved.
//
// All probes ride the SSRF-hardened client (safeFetch /
// pinnedWebSocketOptions) via the per-protocol resolve libs.
// =============================================================================

export type SourceLiveness =
  | {
      ok: true;
      /** Canonical URI to store (may differ from the input: acct → actor
       *  URI, handle → DID, npub → hex, actor URL → the actor document id). */
      sourceUri: string;
      // Probe metadata, used as display fallbacks when the caller sent none.
      displayName?: string;
      description?: string;
      avatarUrl?: string;
    }
  | { ok: false; reason: "malformed" | "unreachable"; message: string };

function malformed(message: string): SourceLiveness {
  return { ok: false, reason: "malformed", message };
}

function unreachable(message: string): SourceLiveness {
  return { ok: false, reason: "unreachable", message };
}

function livenessEnforced(): boolean {
  return process.env.SOURCE_LIVENESS_ENFORCED !== "0";
}

export async function verifySourceLiveness(
  protocol: "rss" | "atproto" | "activitypub" | "nostr_external",
  sourceUri: string,
  relayUrls?: string[],
): Promise<SourceLiveness> {
  switch (protocol) {
    case "rss":
      return verifyRss(sourceUri.trim());
    case "atproto":
      return verifyAtproto(sourceUri.trim());
    case "activitypub":
      return verifyActivityPub(sourceUri.trim());
    case "nostr_external":
      return verifyNostr(sourceUri.trim(), relayUrls);
  }
}

// -----------------------------------------------------------------------------
// rss — fetch and confirm the URL actually serves a parseable feed, the same
// bar as the ingest adapter: XML via rss-parser, or JSON Feed (which the
// adapter fully supports — rejecting it here would refuse URLs ingest handles).
// -----------------------------------------------------------------------------

function parseJsonFeedMeta(
  text: string,
): { title?: string; description?: string } | null {
  try {
    const feed = JSON.parse(text) as {
      version?: unknown;
      title?: unknown;
      description?: unknown;
    };
    if (
      typeof feed?.version !== "string" ||
      !feed.version.startsWith("https://jsonfeed.org/version/")
    )
      return null;
    return {
      title: typeof feed.title === "string" ? feed.title : undefined,
      description:
        typeof feed.description === "string" ? feed.description : undefined,
    };
  } catch {
    return null;
  }
}

async function verifyRss(sourceUri: string): Promise<SourceLiveness> {
  let url: URL;
  try {
    url = new URL(sourceUri);
  } catch {
    return malformed("Not a valid feed URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return malformed("Feed URLs must use http:// or https://");

  if (!livenessEnforced()) return { ok: true, sourceUri };

  let res;
  try {
    res = await safeFetch(sourceUri, {
      headers: {
        Accept:
          "application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
      },
    });
  } catch {
    return unreachable("The feed URL could not be fetched");
  }
  if (!res.ok)
    return unreachable(`The feed URL returned HTTP ${res.status}`);

  const text = res.text;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("json") || text.trimStart().startsWith("{")) {
    const jsonFeed = parseJsonFeedMeta(text);
    if (jsonFeed)
      return {
        ok: true,
        sourceUri,
        displayName: jsonFeed.title,
        description: jsonFeed.description,
      };
  }
  try {
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser({ timeout: 5000 });
    const feed = await parser.parseString(text);
    return {
      ok: true,
      sourceUri,
      displayName: feed.title ?? undefined,
      description: feed.description ?? undefined,
    };
  } catch {
    return unreachable(
      "The URL did not return a readable RSS, Atom, or JSON feed",
    );
  }
}

// -----------------------------------------------------------------------------
// atproto — accept a DID or a handle (getProfile takes either and returns the
// canonical DID, so handle input is normalised for free). Handle → DID needs
// the network regardless of the enforcement flag: a handle cannot be stored.
// -----------------------------------------------------------------------------

// Hostname-shaped, optional leading @ (alice.bsky.social). Deliberately loose
// — getProfile is the real validator; this only splits the malformed error.
const ATPROTO_HANDLE_SHAPE =
  /^@?[a-z0-9][a-z0-9._-]*\.[a-z][a-z0-9-]*[a-z0-9]$/i;

async function verifyAtproto(sourceUri: string): Promise<SourceLiveness> {
  const isDid = isAtprotoDid(sourceUri);
  if (!isDid && !ATPROTO_HANDLE_SHAPE.test(sourceUri))
    return malformed(
      "Expected a DID (did:plc:… / did:web:…) or a Bluesky handle",
    );

  if (isDid && !livenessEnforced()) return { ok: true, sourceUri };

  const profile = await atprotoGetProfile(sourceUri);
  if (!profile)
    return unreachable(
      isDid
        ? "No account found for this DID on the AT Protocol network"
        : "No account found for this handle on the AT Protocol network",
    );
  return {
    ok: true,
    sourceUri: profile.did,
    displayName: profile.displayName,
    description: profile.description,
    avatarUrl: profile.avatar,
  };
}

// -----------------------------------------------------------------------------
// nostr — accept 64-hex, npub, or nprofile (decoded offline; nprofile relay
// hints join the probe set). Liveness = a kind-0 profile on the hint relays ∪
// the default profile relays.
// -----------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/i;

async function verifyNostr(
  sourceUri: string,
  relayUrls?: string[],
): Promise<SourceLiveness> {
  let pubkey: string | null = null;
  let hintRelays: string[] = relayUrls ?? [];

  if (HEX_64.test(sourceUri)) {
    pubkey = sourceUri.toLowerCase();
  } else if (/^n(pub|profile)1/i.test(sourceUri)) {
    try {
      const decoded = nip19.decode(sourceUri.toLowerCase());
      if (decoded.type === "npub") {
        pubkey = decoded.data;
      } else if (decoded.type === "nprofile") {
        pubkey = decoded.data.pubkey;
        hintRelays = [...hintRelays, ...(decoded.data.relays ?? [])];
      }
    } catch {
      // falls through to malformed
    }
  }
  if (!pubkey)
    return malformed("Expected a 64-character hex pubkey, npub, or nprofile");

  if (!livenessEnforced()) return { ok: true, sourceUri: pubkey };

  const relays = [...new Set([...hintRelays, ...getDefaultProfileRelays()])];
  const profile = await fetchNostrProfile(pubkey, relays);
  if (!profile)
    return unreachable(
      "No Nostr profile (kind 0) found for this key on the queried relays",
    );
  return {
    ok: true,
    sourceUri: pubkey,
    displayName: profile.displayName,
    description: profile.about,
    avatarUrl: profile.picture,
  };
}

// -----------------------------------------------------------------------------
// activitypub — accept an https actor URL or a user@domain acct (optional
// leading @; RESOLVER-DISCOVERY-ADR §5.2's acct handling, folded in here).
// The acct → actor URI webfinger always runs (it's normalisation, not just
// liveness); the actor-document fetch is the probe, and its returned id is
// the canonical stored URI.
// -----------------------------------------------------------------------------

async function verifyActivityPub(sourceUri: string): Promise<SourceLiveness> {
  let actorUri: string | null = null;

  let isUrl = false;
  try {
    const u = new URL(sourceUri);
    isUrl = true;
    if (u.protocol !== "https:")
      return malformed("ActivityPub actor URLs must use https://");
    actorUri = sourceUri;
  } catch {
    // Not a URL — try the acct shape.
  }

  if (!isUrl) {
    const clean = sourceUri.replace(/^@+/, "");
    if (!isAcctShape(clean))
      return malformed(
        "Expected an https actor URL or a user@domain fediverse handle",
      );
    const resolved = await resolveWebFinger(clean);
    if (!resolved)
      return unreachable(`Could not resolve @${clean} via WebFinger`);
    try {
      if (new URL(resolved).protocol !== "https:")
        return unreachable(`@${clean} resolved to a non-https actor URI`);
    } catch {
      return unreachable(`@${clean} resolved to an invalid actor URI`);
    }
    actorUri = resolved;
  }

  // Flag off: the acct → actor webfinger (above) still ran — it's
  // normalisation — but the confirmatory actor-document probe is skipped.
  if (!livenessEnforced()) return { ok: true, sourceUri: actorUri! };

  const profile = await fetchActorProfile(actorUri!);
  if (!profile)
    return unreachable(
      "The address did not return an ActivityPub actor document",
    );
  return {
    ok: true,
    sourceUri: profile.actorUri,
    displayName: profile.displayName ?? undefined,
    description: profile.description ?? undefined,
    avatarUrl: profile.avatar ?? undefined,
  };
}
