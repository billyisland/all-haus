// =============================================================================
// The one Nostr REQ/EOSE socket dance.
//
// Before this file the same WebSocket lifecycle — open, send REQ, collect
// EVENTs, stop at EOSE-or-timeout, send a polite CLOSE, tear down — was written
// out four times: twice in the gateway (`lib/nostr-relay.ts`'s fan-out and
// `lib/nostr-search.ts`'s two independent dances) and twice in feed-ingest
// (`lib/nostr-relay.ts`'s engagement tally and `lib/nostr-ingest.ts`'s generic
// runner). Each copy had drifted in a different direction, and each carried its
// own partial set of the guards the others had learned the hard way.
// STRUCTURAL-SIMPLIFICATION-ADR-2026-08-26 §9.
//
// What is deliberately NOT here: the fan-out policy. Who to ask, how many
// relays, when to stop waiting, and how to reconcile disagreeing answers are
// caller decisions with real semantics attached — the gateway's early-resolve
// modes (THREAD-HYDRATION-LATENCY-ADR D3) and feed-ingest's id-chunked batch
// tally are not the same policy and must not be collapsed into one. This module
// owns exactly one socket, and `openRelayReq` hands the caller the handle it
// needs to build a fan-out on top.
//
// SSRF: pinning is MANDATORY and internal. A caller cannot open an unpinned
// socket through this module — either it passes options it already got from
// `pinnedWebSocketOptions` (the batch case, which pins once and reuses across
// chunks) or this module pins for it. A pin failure is a dead relay, never an
// exception (see `onPinError` for the callers that want to log it).
// =============================================================================
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  pinnedWebSocketOptions,
  type PinnedWebSocketOptions,
} from "./http-client.js";
import { pickNostrWriteRelays } from "./nip65.js";

// The shape every relay event shares. Callers with richer local types (the
// gateway's RawNostrEvent, feed-ingest's NostrEvent) narrow on the way out;
// this module reads only `id` and passes the rest through untouched.
export interface RelayEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

// High-coverage public relays/aggregators, merged in *behind* a post's, item's
// or source's own relay hints (which are often just 1–2 relays that no longer
// carry the whole thread / a current profile). relay.nostr.band is a broad
// indexer; the rest are large general relays.
//
// One home: the gateway and feed-ingest each carried a byte-identical copy.
export const NOSTR_FALLBACK_RELAYS = [
  "wss://relay.nostr.band",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

// Build the relay set for a lookup: the caller's hints first (they are the most
// specific), then any extra sets, then the broad fallbacks — deduped, filtered
// to ws:/wss:, and capped. The cap is the caller's, because what it bounds
// differs per call site (profile lookups fan out to 6, the engagement tally to
// 5) — but the ORDER matters everywhere and is fixed here: hints before
// fallbacks, so a cap can never evict a post's own relay in favour of an
// aggregator.
//
// This idiom was written out eight times across the two workspaces.
export function relayCandidates(
  hintRelays: readonly string[],
  cap: number,
  ...extra: ReadonlyArray<readonly string[]>
): string[] {
  return [
    ...new Set([...hintRelays, ...extra.flat(), ...NOSTR_FALLBACK_RELAYS]),
  ]
    .filter((r) => r.startsWith("ws://") || r.startsWith("wss://"))
    .slice(0, cap);
}

export interface RelayReqOptions<T extends RelayEventLike = RelayEventLike> {
  /** Hard bound on the whole request. Resolves with whatever arrived. */
  timeoutMs?: number;
  /** Prefix for the subscription id, so relay logs name the caller. */
  subIdPrefix?: string;
  /**
   * Pre-pinned socket options. Pass these when one caller opens many REQs
   * against the same relay (the id-chunked engagement tally) so the DNS pin is
   * paid once. Omit and this module pins per call.
   */
  wsOpts?: PinnedWebSocketOptions;
  /**
   * Per-event hook, called before the event is collected. Callers that need
   * newest-wins, cross-relay dedup or an early stop do their bookkeeping here.
   * Return `false` to drop the event from the collected array.
   */
  onEvent?: (ev: T) => boolean | void;
  /** Called when the relay signals end-of-stored-events, before settling. */
  onEose?: () => void;
  /** Called when the SSRF pin rejects the URL — the callers that log, log here. */
  onPinError?: (err: unknown) => void;
  /**
   * What a socket `error` means. `resolve` (default) treats a broken relay as
   * one that returned less — correct for every fail-soft candidate pool.
   * `reject` preserves feed-ingest's ingest-path contract, where a relay
   * failure must reach the job rather than read as "this author posted
   * nothing": that silence is the same reassuring-absence bug class the
   * heartbeat rule exists to close, one layer down.
   */
  onSocketError?: "resolve" | "reject";
}

export interface RelayReqHandle<T extends RelayEventLike = RelayEventLike> {
  /** Settles with the events collected so far. */
  done: Promise<T[]>;
  /**
   * Hang up now and settle with what has arrived. Safe at any point in the
   * lifecycle, INCLUDING before the socket exists — a fan-out that resolves
   * early while this relay is still pinning DNS must not leave a socket
   * opening behind it.
   */
  close: () => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Open one REQ against one relay. Returns immediately with a handle; the socket
 * is pinned and opened in the background.
 *
 * Every guard below was paid for by an incident and is preserved verbatim from
 * whichever copy learned it:
 *
 * - A synchronous `new WebSocket()` throw settles the handle. Left unhandled it
 *   rejected a void'd async IIFE, the fan-out's pending count never decremented,
 *   and the caller hung forever with no backstop timer (gateway §0i.8).
 * - The CLOSE frame is sent before the socket is torn down, and only when the
 *   socket is actually OPEN — some relays flag an abrupt disconnect with no
 *   prior CLOSE as abuse (feed-ingest).
 * - Timeout, EOSE, `error` and `close` all funnel through one idempotent
 *   `finish`, so a relay that fires several of them settles once.
 */
export function openRelayReq<T extends RelayEventLike = RelayEventLike>(
  relayUrl: string,
  filters: Record<string, unknown>[],
  opts: RelayReqOptions<T> = {},
): RelayReqHandle<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    subIdPrefix = "req",
    wsOpts: presetOpts,
    onEvent,
    onEose,
    onPinError,
    onSocketError = "resolve",
  } = opts;

  const subId = `${subIdPrefix}-${randomUUID()}`;
  const events: T[] = [];
  let settled = false;
  let closedEarly = false;
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | undefined;

  let settle!: (evs: T[]) => void;
  let fail!: (err: unknown) => void;
  const done = new Promise<T[]>((res, rej) => {
    settle = res;
    fail = rej;
  });

  const finish = (err?: unknown) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(["CLOSE", subId]));
        }
      } catch {
        /* draining */
      }
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (err !== undefined && onSocketError === "reject") fail(err);
    else settle(events);
  };

  void (async () => {
    let resolvedOpts: PinnedWebSocketOptions;
    if (presetOpts) {
      resolvedOpts = presetOpts;
    } else {
      try {
        resolvedOpts = await pinnedWebSocketOptions(relayUrl);
      } catch (err) {
        onPinError?.(err);
        finish(); // unresolvable / blocked host — a dead relay, not an error
        return;
      }
    }
    // Hung up while we were pinning DNS: do not open the socket at all.
    if (closedEarly || settled) {
      finish();
      return;
    }
    try {
      ws = new WebSocket(relayUrl, resolvedOpts);
    } catch (err) {
      finish(onSocketError === "reject" ? err : undefined);
      return;
    }
    timer = setTimeout(() => finish(), timeoutMs);
    ws.on("open", () => {
      try {
        ws?.send(JSON.stringify(["REQ", subId, ...filters]));
      } catch {
        finish();
      }
    });
    ws.on("message", (raw: { toString(): string }) => {
      try {
        const msg = JSON.parse(raw.toString()) as unknown[];
        if (msg[0] === "EVENT" && msg[1] === subId) {
          const ev = msg[2] as T;
          if (onEvent?.(ev) !== false) events.push(ev);
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          onEose?.();
          finish();
        }
      } catch {
        /* ignore parse errors */
      }
    });
    ws.on("error", (err: unknown) => finish(err ?? new Error("relay socket error")));
    ws.on("close", () => finish());
  })();

  return {
    done,
    close: () => {
      closedEarly = true;
      finish();
    },
  };
}

/** `openRelayReq` for the callers that never need to hang up early. */
export function relayReq<T extends RelayEventLike = RelayEventLike>(
  relayUrl: string,
  filters: Record<string, unknown>[],
  opts: RelayReqOptions<T> = {},
): Promise<T[]> {
  return openRelayReq<T>(relayUrl, filters, opts).done;
}

// =============================================================================
// NIP-65 write-relay discovery
//
// The gateway and feed-ingest each carried a full copy of this — same relay
// cap, same timeout, same filter, same fallback semantics, differing only in
// which local REQ runner they reached for. `nip65.ts` had already been split
// out so the PARSING rules could not drift; the fetch around it drifted
// instead. One home now.
// =============================================================================
const NIP65_RELAY_CAP = 6;
const NIP65_REQ_TIMEOUT_MS = 6_000;

/**
 * Fetch an author's kind-10002 relay list over the hint set + fallbacks and
 * pick their write relays (EXTERNAL-AUTHOR-HISTORY-ADR §4.1).
 *
 * Best-effort: a relay that fails just contributes no candidate events. Every
 * reachable relay's answer is collected and the shared parser keeps the newest
 * — kind 10002 is replaceable, so a fast relay holding a stale list must not
 * win a race against a slower relay holding the current one. Returns [] when
 * no 10002 is reachable at all, which callers read as "fall back to hints +
 * NOSTR_FALLBACK_RELAYS".
 */
export async function fetchNostrWriteRelays(
  pubkey: string,
  hintRelays: string[] = [],
): Promise<string[]> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return [];
  const relays = relayCandidates(hintRelays, NIP65_RELAY_CAP);
  if (relays.length === 0) return [];

  const filters = [{ kinds: [10002], authors: [pubkey.toLowerCase()], limit: 1 }];
  const perRelay = await Promise.all(
    relays.map((url) =>
      relayReq(url, filters, {
        timeoutMs: NIP65_REQ_TIMEOUT_MS,
        subIdPrefix: "nip65",
      }),
    ),
  );
  return pickNostrWriteRelays(perRelay.flat());
}
