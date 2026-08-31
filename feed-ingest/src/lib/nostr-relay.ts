// Read-only Nostr relay access for periodic engagement refresh. The base
// per-source ingest (feed-ingest-nostr.ts) filters on `authors:[pubkey]`, so it
// never sees engagement — reactions (kind 7) and replies (kind 1) come from
// OTHER pubkeys. external-engagement-refresh.ts uses these helpers to fetch them
// by `#e`-tagging a batch of the source's notes and tally per note.
//
// All sockets are pinned through the SSRF-hardened helper. Best-effort and
// bounded (relay cap, id chunking, per-REQ timeout); a flaky relay just yields
// fewer events, never an exception that aborts the run.
import {
  pinnedWebSocketOptions,
  type PinnedWebSocketOptions,
} from "@platform-pub/shared/lib/http-client.js";
import {
  relayCandidates,
  relayReq,
  type RelayEventLike as RelayEvent,
} from "@platform-pub/shared/lib/nostr-relay-req.js";

const RELAY_CAP = 5;
const ID_CHUNK = 100; // `#e` filter ids per REQ
const FETCH_LIMIT = 500; // per-filter relay cap
const REQ_TIMEOUT_MS = 6_000;

export interface EngagementCount {
  like: number;
  reply: number;
}

// NIP-10 reply target of a kind-1 event (explicit "reply" marker, else last `e`).
function replyTargetId(ev: RelayEvent): string | null {
  const eTags = ev.tags.filter((t) => t[0] === "e" && t[1]);
  const tag =
    eTags.find((t) => t[3] === "reply") ??
    (eTags.length > 0 ? eTags[eTags.length - 1] : null);
  return tag ? tag[1] : null;
}

// NIP-25 reaction target: the last `e` tag the reaction carries.
function reactionTargetId(ev: RelayEvent): string | null {
  const eTags = ev.tags.filter((t) => t[0] === "e" && t[1]);
  return eTags.length > 0 ? eTags[eTags.length - 1][1] : null;
}

// Fetch reactions + replies that `#e`-tag any of `noteIds` (raw hex event ids)
// and tally per note. Returns a Map keyed on the lowercased hex id; absent ids
// had no engagement reachable on the relay set. Counts are absolute over what
// the relays returned (the caller writes them monotonically, so a partial
// relay set can only under-report, never flicker a stored count down).
export async function fetchNostrEngagementCounts(
  noteIds: string[],
  hintRelays: string[],
): Promise<Map<string, EngagementCount>> {
  const ids = noteIds.filter((id) => /^[0-9a-f]{64}$/i.test(id));
  const out = new Map<string, EngagementCount>();
  if (ids.length === 0) return out;

  const relays = relayCandidates(hintRelays, RELAY_CAP);
  if (relays.length === 0) return out;

  const known = new Set(ids.map((id) => id.toLowerCase()));

  // Resolve each relay's pinned options once, up front.
  const opened = (
    await Promise.all(
      relays.map(async (url) => {
        try {
          return { url, opts: await pinnedWebSocketOptions(url) };
        } catch {
          return null; // unresolvable / blocked host
        }
      }),
    )
  ).filter((r): r is { url: string; opts: PinnedWebSocketOptions } => !!r);

  const byId = new Map<string, RelayEvent>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const filters = [
      { kinds: [7], "#e": chunk, limit: FETCH_LIMIT },
      { kinds: [1], "#e": chunk, limit: FETCH_LIMIT },
    ];
    const perRelay = await Promise.all(
      opened.map(({ url, opts }) =>
        relayReq(url, filters, {
          wsOpts: opts,
          timeoutMs: REQ_TIMEOUT_MS,
          subIdPrefix: "fi-eng",
        }).catch(() => [] as RelayEvent[]),
      ),
    );
    for (const evs of perRelay) {
      for (const ev of evs) {
        if (ev?.id && !byId.has(ev.id)) byId.set(ev.id, ev);
      }
    }
  }

  const bump = (id: string, key: keyof EngagementCount) => {
    const cur = out.get(id) ?? { like: 0, reply: 0 };
    cur[key] += 1;
    out.set(id, cur);
  };
  for (const ev of byId.values()) {
    if (ev.kind === 7) {
      // NIP-25: "-" content is a downvote/dislike; only non-negative is a like.
      if (ev.content.trim() === "-") continue;
      const target = reactionTargetId(ev)?.toLowerCase();
      if (target && known.has(target)) bump(target, "like");
    } else if (ev.kind === 1) {
      const target = replyTargetId(ev)?.toLowerCase();
      if (target && known.has(target)) bump(target, "reply");
    }
  }
  return out;
}
