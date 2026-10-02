import { useCallback, useEffect, useRef } from "react";
import { useFeedSeen } from "../stores/feedSeen";

// =============================================================================
// useSeenPolling — the counts' only refresh (WORKSPACE-QUEUE-ADR §IV.9), and
// the queue's buffer (§VI.5 *Fetched on a timer, shown on a gesture*).
//
// Two callers, one clock each. The floor polls the window every SEEN_POLL_MS.
// The queue passes its own `fire` (page one into the buffer, and the window)
// and a slower interval, and takes the returned `poke`: a pull fires its feed
// now and restarts that feed's clock, so the timer never re-reads a feed the
// reader has just refreshed.
//
// There is no push channel, so each listed feed's window is fetched every
// SEEN_POLL_MS — `GET …/seen`, ids and no bodies — staggered evenly across the
// interval so n feeds cost n evenly-spaced queries, not a burst of n. A poll
// updates COUNTS, never content: the store adopts the window and prunes the
// passed set at its floor; nothing else is fetched.
//
//   · First contact, and every return to a visible tab, is one pass spread
//     over SEEN_RETURN_SPREAD_MS — a feed has no badge until its first window
//     lands, so that pass cannot wait a whole interval. The queue's first
//     pass is instead spread over its whole interval (`firstPass:
//     "interval"`): it enters on fresh pages and has its windows read by its
//     own first sort.
//     The queue passes `onReturn: "due"`: its read carries page one, not
//     just ids, so a return reads only the feeds whose read FELL DUE while
//     the tab was hidden (spread over the same pass), and every other feed
//     keeps the time it was due at.
//   · Paused while the page is hidden.
//   · ONE READ PER FEED AT A TIME. A read asked for while one is in flight —
//     a poke, a timer, a return — asks for exactly one more after it, never
//     a second concurrent one: repeated pulls stack nothing, and a publish
//     still gets a read that started after it.
//   · A failure backs off per feed (×2, capped at 15 min) and is logged,
//     never surfaced: an absent badge is already the honest display.
//
// A single constant, not a platform_config dial: it moves nobody's money and
// no operator needs to turn it.
// =============================================================================

export const SEEN_POLL_MS = 120_000;
const SEEN_RETURN_SPREAD_MS = 10_000;
const SEEN_BACKOFF_MAX_MS = 15 * 60_000;

interface Slot {
  timer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  /** When the next read is due (epoch ms), kept across a hidden spell. */
  dueAt: number;
  inFlight: boolean;
  /** Asked for while in flight: read once more when it lands. */
  again: boolean;
}

export interface SeenPollingOptions {
  intervalMs?: number;
  /** One feed's read. Rejects on failure, for the backoff. */
  fire?: (feedId: string) => Promise<void>;
  firstPass?: "spread" | "interval";
  /** A return to the tab: re-read every feed ("spread", the default), or
   *  only those whose read fell due while it was hidden ("due"). */
  onReturn?: "spread" | "due";
}

/** Returns `poke(feedIds)`: read those feeds now, and start each one's
 *  interval again. One feed is read at once; several are spread over the
 *  return pass, in the order given. A feed not being polled is skipped. */
export function useSeenPolling(
  feedIds: string[],
  enabled: boolean,
  opts: SeenPollingOptions = {},
): (feedIds: readonly string[]) => void {
  const slots = useRef(new Map<string, Slot>());
  const key = feedIds.join("\0");
  const interval = opts.intervalMs ?? SEEN_POLL_MS;
  const firstPass = opts.firstPass ?? "spread";
  const onReturn = opts.onReturn ?? "spread";
  const fireRef = useRef(opts.fire);
  fireRef.current = opts.fire;
  const pokeRef = useRef<(feedIds: readonly string[]) => void>(() => {});

  useEffect(() => {
    const map = slots.current;
    if (!enabled) {
      for (const s of map.values()) if (s.timer) clearTimeout(s.timer);
      map.clear();
      return;
    }
    const ids = key ? key.split("\0") : [];
    const live = new Set(ids);

    const schedule = (id: string, delay: number) => {
      const slot = map.get(id);
      if (!slot) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.dueAt = Date.now() + delay;
      slot.timer = setTimeout(() => void fire(id), delay);
    };
    const fire = async (id: string) => {
      const slot = map.get(id);
      if (!slot) return;
      slot.timer = null;
      // Hidden: stop; the visibility listener restarts everyone on return.
      if (document.visibilityState === "hidden") return;
      if (slot.inFlight) {
        slot.again = true;
        return;
      }
      slot.inFlight = true;
      try {
        await (fireRef.current ?? useFeedSeen.getState().fetchWindow)(id);
        if (map.get(id) !== slot) return;
        slot.backoff = 0;
        // A poke that landed meanwhile has scheduled the next read itself.
        if (!slot.timer) schedule(id, interval);
      } catch (err) {
        if (map.get(id) !== slot) return;
        slot.backoff = Math.min(
          slot.backoff ? slot.backoff * 2 : interval * 2,
          SEEN_BACKOFF_MAX_MS,
        );
        console.warn("feedSeen: poll failed", id, err);
        schedule(id, slot.backoff);
      } finally {
        slot.inFlight = false;
        if (slot.again && map.get(id) === slot) {
          slot.again = false;
          if (slot.timer) clearTimeout(slot.timer);
          void fire(id);
        }
      }
    };
    const spread = (list: readonly string[]) =>
      list.forEach((id, i) =>
        schedule(id, (i * SEEN_RETURN_SPREAD_MS) / Math.max(list.length, 1)),
      );

    // Drop what left the list; add what joined, spread over the return pass.
    for (const [id, s] of map) {
      if (live.has(id)) continue;
      if (s.timer) clearTimeout(s.timer);
      map.delete(id);
    }
    const joined = ids.filter((id) => !map.has(id));
    joined.forEach((id, i) => {
      map.set(id, { timer: null, backoff: 0, dueAt: 0, inFlight: false, again: false });
      schedule(
        id,
        firstPass === "interval"
          ? ((i + 1) * interval) / joined.length
          : (i * SEEN_RETURN_SPREAD_MS) / Math.max(joined.length, 1),
      );
    });
    pokeRef.current = (want) => spread(want.filter((id) => map.has(id)));

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        for (const s of map.values()) {
          if (s.timer) clearTimeout(s.timer);
          s.timer = null;
        }
        return;
      }
      if (onReturn === "spread") return spread(ids);
      const now = Date.now();
      const overdue: string[] = [];
      for (const id of ids) {
        const slot = map.get(id);
        if (!slot) continue;
        if (slot.dueAt <= now) overdue.push(id);
        else schedule(id, slot.dueAt - now);
      }
      spread(overdue);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      pokeRef.current = () => {};
    };
  }, [key, enabled, interval, firstPass, onReturn]);

  // Unmount: every timer goes.
  useEffect(() => {
    const map = slots.current;
    return () => {
      for (const s of map.values()) if (s.timer) clearTimeout(s.timer);
      map.clear();
    };
  }, []);

  return useCallback((ids: readonly string[]) => pokeRef.current(ids), []);
}
