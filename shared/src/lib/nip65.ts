// NIP-65 relay-list parsing (EXTERNAL-AUTHOR-HISTORY-ADR §4.1).
//
// Pure, dependency-free parser shared by the gateway (profile-view timeline
// hydration) and feed-ingest (subscribe-time nostr backfill) — both packages
// fetch kind-10002 events with their own relay runners, then feed them here so
// the parsing rules cannot drift between packages.

export interface Nip65Event {
  created_at: number;
  tags: string[][];
}

const WRITE_RELAY_CAP = 8;

// Pick an author's WRITE relays from their kind-10002 relay-list events.
// Multiple events may arrive (one per relay queried); kind 10002 is replaceable,
// so only the newest by created_at counts. An `r` tag with no marker means
// read+write; marker "write" means write-only; marker "read" is excluded.
// Scheme-checked (ws:// / wss://), deduped, capped. Empty input / no usable
// tags ⇒ [] (callers fall back to hints + NOSTR_FALLBACK_RELAYS).
// Persistence union for external_sources.relay_urls (§2.2 step 3 / §3.2):
// existing entries first (user-supplied relays are never dropped), discovered
// write relays appended, deduped, scheme-checked, capped. Shared by the
// feed-ingest backfill and the gateway profile-view hydration so the rule
// cannot drift.
export function mergeNostrRelayUrls(
  existing: string[],
  discovered: string[],
  cap = 10,
): string[] {
  return [...new Set([...existing, ...discovered])]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, cap);
}

export function pickNostrWriteRelays(events: Nip65Event[]): string[] {
  if (events.length === 0) return [];
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of newest.tags) {
    if (!Array.isArray(tag) || tag[0] !== "r") continue;
    const url = typeof tag[1] === "string" ? tag[1].trim() : "";
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) continue;
    const marker = tag[2];
    if (marker !== undefined && marker !== "" && marker !== "write") continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= WRITE_RELAY_CAP) break;
  }
  return out;
}
