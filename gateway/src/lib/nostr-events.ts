import type { EventTemplate } from "nostr-tools";

// =============================================================================
// Nostr discovery event templates (NOSTR-OUTBOUND-INTEROP-ADR §3.1)
//
// Pure builders for the three replaceable discovery events that make an
// all.haus user discoverable on the wider Nostr mesh. They produce unsigned
// EventTemplates; the caller signs via key-custody (signed by the *user's*
// custodial key, signerType 'account') and enqueues into relay_outbox.
//
// Replaceable-event note: each build stamps a fresh created_at (1s resolution).
// Relays keep only the latest per (pubkey, kind); on a created_at tie they
// tie-break on the lexically-larger id. The follow-list publisher therefore
// rebuilds from current DB state at run time (never snapshots), so the
// surviving event always reflects final state — see discovery-publish.ts.
// =============================================================================

// Master switch for outbound discovery publishing (triggers + scheduler sweep
// + dirty marking). Off by default so the feature ships dark; the operator
// flips this on, and PUBLIC_FANOUT_RELAY_URLS separately controls public reach
// (empty ⇒ in-house relay only). The NIP-05 endpoint is read-only and stays on
// regardless of this flag.
export function discoveryEnabled(): boolean {
  return process.env.DISCOVERY_PUBLISH_ENABLED === "1";
}

// The public host used for NIP-05 identifiers (<username>@<domain>).
export function nip05Domain(): string {
  return process.env.NIP05_DOMAIN ?? "all.haus";
}

// The relay URL we *advertise* to the outside world (kind 10002 / NIP-05
// relays map). Distinct from the fan-out publish target: this is where outside
// clients are told to *read* our events, not the internal strfry socket.
export function publicRelayUrl(): string {
  return (
    process.env.PUBLIC_RELAY_URL ??
    process.env.NEXT_PUBLIC_RELAY_URL ??
    `wss://${nip05Domain()}/relay`
  );
}

// Fan-out publish targets for discovery events: the in-house relay first, then
// any opt-in public relays. Empty PUBLIC_FANOUT_RELAY_URLS ⇒ in-house only, so
// the whole feature ships dark until configured (ADR §3.3).
export function discoveryRelayTargets(): string[] {
  const platform = process.env.PLATFORM_RELAY_WS_URL;
  const pub = (process.env.PUBLIC_FANOUT_RELAY_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...(platform ? [platform] : []), ...pub];
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// kind 0 — profile metadata
// ---------------------------------------------------------------------------

export interface ProfileFields {
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarBlossomUrl: string | null;
}

export function buildProfileEvent(account: ProfileFields): EventTemplate {
  const meta: Record<string, string> = {};
  if (account.username) meta.name = account.username;
  if (account.displayName) meta.display_name = account.displayName;
  if (account.bio) meta.about = account.bio;
  if (account.avatarBlossomUrl) meta.picture = account.avatarBlossomUrl;
  if (account.username) meta.nip05 = `${account.username}@${nip05Domain()}`;

  return {
    kind: 0,
    content: JSON.stringify(meta),
    tags: [],
    created_at: nowSec(),
  };
}

// ---------------------------------------------------------------------------
// kind 3 — follow list (NIP-02). One `p` tag per followed pubkey (hex).
// ---------------------------------------------------------------------------

export function buildFollowListEvent(followeePubkeys: string[]): EventTemplate {
  return {
    kind: 3,
    content: "",
    tags: followeePubkeys.map((pk) => ["p", pk]),
    created_at: nowSec(),
  };
}

// ---------------------------------------------------------------------------
// kind 10002 — relay list (NIP-65). A single read+write relay (no marker).
// ---------------------------------------------------------------------------

export interface RelayListFields {
  hostingType: string | null;
  selfHostedRelayUrl: string | null;
}

export function relayForAccount(account: RelayListFields): string {
  if (account.hostingType === "self_hosted" && account.selfHostedRelayUrl) {
    return account.selfHostedRelayUrl;
  }
  return publicRelayUrl();
}

export function buildRelayListEvent(account: RelayListFields): EventTemplate {
  return {
    kind: 10002,
    content: "",
    tags: [["r", relayForAccount(account)]],
    created_at: nowSec(),
  };
}
