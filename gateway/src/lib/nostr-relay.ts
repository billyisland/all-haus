// Read-only Nostr relay access for the gateway request path. The low-level REQ
// runner (fetchNostrEvents) and the high-coverage fallback relay set were lifted
// out of routes/external-items.ts so both thread hydration AND the author hover
// bio (routes/author.ts) can reuse one implementation instead of duplicating the
// WebSocket REQ dance. All sockets are pinned via the SSRF-hardened helper.
import {
  openRelayReq,
  relayCandidates,
  type RelayReqHandle,
} from "@platform-pub/shared/lib/nostr-relay-req.js";
import { parseNostrProfile, type RawNostrEvent, type NostrProfile } from "./nostr-thread.js";

// Early-resolve strategy for fetchNostrEvents (THREAD-HYDRATION-LATENCY-ADR D3).
// The default is `exhaustive` — wait every relay to EOSE-or-timeout — so no
// existing caller silently changes behaviour. The two opt-in modes let the
// latency-sensitive thread-hydration phases stop waiting for the slowest relay:
//
// - `first-event`: resolve the moment ANY relay returns an EVENT. Correct ONLY
//   for content-addressed `{ ids: [x] }` lookups — an event id uniquely
//   identifies its content, so the first hit is authoritative (there is no
//   "newer" copy to wait for). Never use for replaceable-by-author kind 0/3/10002
//   lookups, where a relay may return a STALE event and the caller reduces to
//   newest-by-created_at — first-hit there imports the wrong copy.
// - `k-of-n`: resolve once `k` relays have EOSE'd OR a soft deadline elapses,
//   whichever first (the broad `#e`-tag reply nets). Slower relays are dropped;
//   the hard `timeoutMs` still bounds the whole call.
export type NostrFetchResolve =
  | { mode: "exhaustive" }
  | { mode: "first-event" }
  | { mode: "k-of-n"; k: number; softDeadlineMs: number };

// Open one REQ against each relay (in parallel), collect EVENTs until EOSE or a
// short timeout, dedupe by event id. Mirrors feed-ingest's fetchFromRelay but
// takes arbitrary filters and runs read-only in the gateway request path.
//
// `resolve` (default exhaustive) selects the D3 early-resolve mode above. When
// an early condition fires, every still-open relay socket is closed and the
// events collected so far are returned — the point is to not pay a hung relay's
// full timeout on every phase.
export async function fetchNostrEvents(
  relays: string[],
  filters: Record<string, unknown>[],
  timeoutMs: number,
  resolve: NostrFetchResolve = { mode: "exhaustive" },
): Promise<RawNostrEvent[]> {
  const byId = new Map<string, RawNostrEvent>();

  // first-event is documented as ids-only; hold it to that. The first EVENT
  // hangs up every other relay, so an unverified junk copy from one broken or
  // malicious relay would become the EXCLUSIVE result — the id-match check is
  // the cheap guard (§0i.8). Empty set ⇒ a caller misusing first-event without
  // an ids filter keeps the old any-event behaviour.
  const requestedIds =
    resolve.mode === "first-event"
      ? new Set(
          filters.flatMap((f) =>
            Array.isArray(f.ids) ? (f.ids as string[]) : [],
          ),
        )
      : null;

  await new Promise<void>((resolveOuter) => {
    let outerSettled = false;
    let pending = relays.length;
    let eoseCount = 0;
    // Per-relay handles, so an early resolve can hang up the stragglers —
    // including one still pinning DNS, which the shared primitive will then
    // never open a socket for at all.
    const handles: RelayReqHandle<RawNostrEvent>[] = [];
    const softTimer =
      resolve.mode === "k-of-n"
        ? setTimeout(() => finishOuter(), resolve.softDeadlineMs)
        : undefined;

    function finishOuter() {
      if (outerSettled) return;
      outerSettled = true;
      if (softTimer) clearTimeout(softTimer);
      // Hang up whatever is still connected; we already have our snapshot.
      for (const handle of handles) handle.close();
      resolveOuter();
    }

    function onRelayDone() {
      // Stragglers keep decrementing after an early resolve (k-of-n /
      // first-event) has already settled the outer promise, so `pending` can
      // legitimately go negative post-resolve. Harmless: finishOuter is
      // guarded by outerSettled, so the extra calls are no-ops (§0f-18).
      pending--;
      if (pending <= 0) finishOuter();
    }

    if (relays.length === 0) {
      finishOuter();
      return;
    }

    for (const relayUrl of relays) {
      // k-of-n bookkeeping, per relay: only a relay that DELIVERED at least
      // one event counts toward k — two fast relays that don't carry the
      // thread would otherwise settle the broad net near-instantly and the
      // reply-light result caches for 60s (§0h.3). And each relay counts at
      // most once, so a misbehaving relay repeating EOSE can't reach k alone
      // (§0i.8).
      let delivered = false;
      let eoseCounted = false;
      const handle = openRelayReq<RawNostrEvent>(relayUrl, filters, {
        timeoutMs,
        subIdPrefix: "gw",
        onEvent: (ev) => {
          const wanted =
            !requestedIds || requestedIds.size === 0 || requestedIds.has(ev?.id ?? "");
          if (ev?.id && wanted && !byId.has(ev.id)) byId.set(ev.id, ev);
          delivered = delivered || (Boolean(ev?.id) && wanted);
          if (resolve.mode === "first-event" && wanted && ev?.id) {
            finishOuter();
          }
          return false; // cross-relay dedup is the map above, not the primitive's array
        },
        onEose: () => {
          if (
            resolve.mode === "k-of-n" &&
            delivered &&
            !eoseCounted &&
            ++eoseCount >= resolve.k
          ) {
            finishOuter();
          }
          if (delivered) eoseCounted = true;
        },
      });
      handles.push(handle);
      void handle.done.then(onRelayDone, onRelayDone);
    }
  });

  return [...byId.values()];
}

const NOSTR_PROFILE_RELAY_CAP = 6;
const NOSTR_PROFILE_REQ_TIMEOUT_MS = 5_000;
const CONTACTS_REQ_TIMEOUT_MS = 8_000;

// One followed account from a kind-3 contact list. The relay hint is
// connection metadata ONLY — it may seed external_sources.relay_urls but must
// never enter the source identity (relay-free Nostr identity invariant).
export interface NostrContact {
  pubkey: string; // 64-hex, lowercase — the canonical source identity
  relayHint?: string;
}

// Fetch an author's kind-3 contact list (FOLLOW-GRAPH-IMPORT-ADR §5.2).
// Every reachable relay's answer is collected and the newest event wins
// (replaceable-event semantics across a fallback-relay race). Returns the
// deduped contacts in the list's own append order — kind-3 `p` tags are
// append-ordered oldest-first, so callers wanting "most recently followed
// first" take the TAIL and reverse. A duplicate pubkey keeps its LAST
// occurrence (the more recent follow). Returns null when no kind 3 is
// reachable at all — distinct from a reachable-but-empty list ([]).
export async function fetchNostrContacts(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<NostrContact[] | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = relayCandidates(hintRelays, NOSTR_PROFILE_RELAY_CAP);
  if (relays.length === 0) return null;

  const events = await fetchNostrEvents(
    relays,
    [{ kinds: [3], authors: [pubkey.toLowerCase()], limit: 1 }],
    CONTACTS_REQ_TIMEOUT_MS,
  );
  if (events.length === 0) return null;
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));

  const byPubkey = new Map<string, NostrContact>();
  for (const tag of newest.tags ?? []) {
    if (!Array.isArray(tag) || tag[0] !== "p") continue;
    const contactPk = typeof tag[1] === "string" ? tag[1].toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(contactPk)) continue;
    const hint =
      typeof tag[2] === "string" &&
      (tag[2].startsWith("ws://") || tag[2].startsWith("wss://"))
        ? tag[2]
        : undefined;
    // Keep the LAST occurrence's position: delete-then-set so a re-follow
    // moves the contact to its newer place in the append order.
    byPubkey.delete(contactPk);
    byPubkey.set(contactPk, { pubkey: contactPk, relayHint: hint });
  }
  return [...byPubkey.values()];
}

// NIP-65 write-relay discovery moved to
// `@platform-pub/shared/lib/nostr-relay-req.js::fetchNostrWriteRelays` — this
// file and feed-ingest's nostr-ingest.ts each carried a full copy of the same
// wrapper (STRUCTURAL-SIMPLIFICATION-ADR §9). Callers import it from shared.

// Fetch a single author's kind-0 profile metadata live from the relay graph,
// keeping the newest one. Nostr has no profile REST API (unlike Bluesky /
// Mastodon), so the hover bio falls back to this read-through fetch — the source
// hints first, then the broad fallback aggregators. Returns null when no current
// kind-0 is reachable (⇒ the caller shows stored fields only / marks partial).
export async function fetchNostrAuthorProfile(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<NostrProfile | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = relayCandidates(hintRelays, NOSTR_PROFILE_RELAY_CAP);
  if (relays.length === 0) return null;

  const events = await fetchNostrEvents(
    relays,
    [{ kinds: [0], authors: [pubkey.toLowerCase()], limit: 1 }],
    NOSTR_PROFILE_REQ_TIMEOUT_MS,
  );
  if (events.length === 0) return null;
  // A relay may return a stale cached kind-0; keep the newest by created_at.
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return parseNostrProfile(newest.content);
}
