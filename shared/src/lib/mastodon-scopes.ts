// =============================================================================
// Mastodon OAuth scopes — ONE home for what we ask for and what we hold.
//
// The gateway asks for MASTODON_SCOPES when it registers an app and when it
// sends a member to authorize; the feed-ingest outbound adapter asks
// `hasMastodonScope` of the scope string the token exchange GRANTED (stored as
// `scope` inside `network_presences.credentials_enc`) before it calls an
// endpoint. A token minted before a scope was added keeps its narrow grant
// until the member reconnects, so the adapter must never assume one.
//
// Which endpoint needs which scope is pinned against the adapter source by
// `feed-ingest/src/adapters/activitypub-outbound.scopes.test.ts`
// (CROSS-NETWORK-ROUNDTRIP-ADR A3).
// =============================================================================

export const MASTODON_SCOPE_LIST = [
  "read:accounts", // verify_credentials at link time; follow import
  "read:statuses", // GET /api/v1/statuses/:id (poll vote)
  "read:search", // GET /api/v2/search?resolve=true — every remote parent
  "read:notifications", // rung C's poller (asked now so members reconnect once)
  "write:statuses", // post, reply, reblog, poll vote
  "write:favourites", // like
] as const;

export type MastodonScope = (typeof MASTODON_SCOPE_LIST)[number];

export const MASTODON_SCOPES = MASTODON_SCOPE_LIST.join(" ");

/**
 * Does a granted scope string cover `needed`? Mastodon's scopes are
 * hierarchical: a bare `read` or `write` grants every `read:*` / `write:*`
 * beneath it. An absent grant covers nothing.
 */
export function hasMastodonScope(
  granted: string | null | undefined,
  needed: string,
): boolean {
  if (!granted) return false;
  const held = new Set(granted.split(/\s+/).filter(Boolean));
  if (held.has(needed)) return true;
  const parent = needed.split(":")[0];
  return parent !== needed && held.has(parent);
}

/** Does a granted scope string cover every scope in `needed`? */
export function coversMastodonScopes(
  granted: string | null | undefined,
  needed: readonly string[] = MASTODON_SCOPE_LIST,
): boolean {
  return needed.every((s) => hasMastodonScope(granted, s));
}
