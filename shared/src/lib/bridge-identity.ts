import { nip19 } from "nostr-tools";

// =============================================================================
// Bridge-identity helpers — pure functions joining a protocol bridge's MIRROR
// identity to the NATIVE identity it mirrors, from stored strings alone (no
// remote fetch). Relocated here from feed-ingest/src/tasks/identity-link-detect.ts
// (Slice 8 P3) so the gateway resolver's merge step can consume them too
// (RESOLVER-DISCOVERY-ADR §6.1); feed-ingest re-imports from here and its
// existing tests pin the behaviour.
//
// The three bridge directions, each embedding the original identity in the
// mirror's identifier:
//   • Bridgy Fed, Bluesky→fediverse: the AP mirror's actor URL is
//     https://bsky.brid.gy/ap/<original DID>.
//   • mostr.pub, Nostr→fediverse: the AP mirror's actor URL / acct embeds the
//     original npub → decode to hex.
//   • Bridgy Fed, fediverse→Bluesky: the atproto mirror's handle is
//     <user>.<instance>.ap.brid.gy → reconstruct <user>@<instance>.
//
// Identity keys live in ONE shared key-space so mirror-decoded keys collide
// with native keys: `atproto:<did>` / `nostr:<hex pubkey>` / `ap:<user@domain>`.
// =============================================================================

// Bridge actor hosts (exact hostname, not registrable domain — the subdomain
// carries the meaning: bsky.brid.gy ≠ ap.brid.gy).
export const BRIDGE_HOST_BSKY = "bsky.brid.gy"; // Bluesky→fediverse mirror (an AP source)
export const BRIDGE_HOST_MOSTR = "mostr.pub"; // Nostr→fediverse mirror (an AP source)
export const BRIDGE_SUFFIX_AP = ".ap.brid.gy"; // fediverse→Bluesky mirror (an atproto handle)

/**
 * The minimal source shape the helpers read. snake_case mirrors the
 * external_sources row (feed-ingest's DetectSourceRow is structurally
 * assignable); the resolver adapts its candidate shape into this.
 * `source_uri` is the protocol identity (AP actor URI or acct, atproto DID,
 * nostr hex pubkey, …); `handle` is the human handle where the protocol has
 * one (atproto handle, AP user@domain acct).
 */
export interface BridgeSourceLike {
  protocol: string;
  source_uri: string;
  handle?: string | null;
}

/** Parse a host out of a URL or a bare host string; null if unparseable. Note
 *  an acct-shaped string (`user@domain`) parses with the user part as URL
 *  userinfo, yielding the domain — deliberate, so acct identities resolve to
 *  their instance host. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).hostname || null;
  } catch {
    return null;
  }
}

/** npub → 64-char hex pubkey via NIP-19; null if not a valid npub. Pure. */
export function npubToHex(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub.trim());
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

/** First `did:plc:`/`did:web:` substring of a string, lower-cased; null if none. */
export function extractDid(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/did:(?:plc|web):[a-zA-Z0-9._:%-]+/);
  return m ? m[0].toLowerCase() : null;
}

/** First bech32 `npub1…` substring of a string; null if none. */
export function extractNpub(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/);
  return m ? m[0] : null;
}

/**
 * Decode a Bridgy Fed fediverse→Bluesky handle (`<user>.<instance>.ap.brid.gy`)
 * back to the original fediverse acct (`user@instance`), lower-cased. Returns
 * null when the handle isn't a Bridgy AP handle or can't be split into a
 * user + a host (the instance part must itself look like a domain). Pure.
 */
export function decodeApBridgeHandle(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = handle.trim().toLowerCase();
  if (!h.endsWith(BRIDGE_SUFFIX_AP)) return null;
  const inner = h.slice(0, -BRIDGE_SUFFIX_AP.length); // user.instance.tld
  const dot = inner.indexOf(".");
  if (dot <= 0) return null;
  const user = inner.slice(0, dot);
  const instance = inner.slice(dot + 1);
  if (!user || !instance.includes(".")) return null; // instance must be a host
  return `${user}@${instance}`;
}

/** A source is a bridge mirror when its identity string lives on a bridge host. */
export function isBridgeMirror(row: BridgeSourceLike): boolean {
  if (row.protocol === "activitypub") {
    const host = hostOf(row.source_uri)?.toLowerCase() ?? null;
    return host === BRIDGE_HOST_BSKY || host === BRIDGE_HOST_MOSTR;
  }
  if (row.protocol === "atproto") {
    return (row.handle ?? "").trim().toLowerCase().endsWith(BRIDGE_SUFFIX_AP);
  }
  return false;
}

/**
 * The decoded ORIGINAL identity key(s) a bridge mirror points at, in the
 * native key-space of the bridged-from network (so they collide with that
 * network's `nativeIdentityKey`). Empty for a non-mirror. Pure.
 */
export function bridgeIdentityKeys(row: BridgeSourceLike): string[] {
  const keys: string[] = [];
  if (row.protocol === "activitypub") {
    const host = hostOf(row.source_uri)?.toLowerCase() ?? null;
    if (host === BRIDGE_HOST_BSKY) {
      const did = extractDid(row.source_uri);
      if (did) keys.push(`atproto:${did}`);
    } else if (host === BRIDGE_HOST_MOSTR) {
      const npub = extractNpub(row.source_uri);
      const hex = npub ? npubToHex(npub) : null;
      if (hex) keys.push(`nostr:${hex}`);
    }
  } else if (row.protocol === "atproto") {
    const acct = decodeApBridgeHandle(row.handle);
    if (acct) keys.push(`ap:${acct}`);
  }
  return keys;
}

/** The canonical identity key a NATIVE (non-mirror) source owns. Pure. */
export function nativeIdentityKey(row: BridgeSourceLike): string | null {
  switch (row.protocol) {
    case "atproto":
      return `atproto:${row.source_uri.trim().toLowerCase()}`; // a DID
    case "nostr_external":
      return `nostr:${row.source_uri.trim().toLowerCase()}`; // a hex pubkey
    case "activitypub":
      return row.handle ? `ap:${row.handle.trim().toLowerCase()}` : null; // user@instance
    default:
      return null; // rss/email — never a bridge endpoint
  }
}
