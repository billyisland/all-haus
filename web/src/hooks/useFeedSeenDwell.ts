import { useEffect, useRef } from "react";
import { useFeedSeen } from "../stores/feedSeen";
import { workspaceFeeds } from "../lib/api";

// =============================================================================
// useFeedSeenDwell — the baseline moves only when the member has LOOKED
// (WORKSPACE-QUEUE-ADR §IV.4).
//
// `engaged` is the host's answer to "is this feed being attended to right
// now?" — on the floor, in view AND pointer over it, focus inside it, or
// scrolled/clicked since it came into view. Held continuously for
// SEEN_DWELL_MS it becomes a DWELL; any break resets the clock. Then:
//
//   1. on leaving after dwell, `POST …/seen` with the newest `asOf` held (the
//      store's `markSeen`, which adopts the window the server answers with);
//   2. on exit after dwell — `pagehide`, `visibilitychange → hidden` — the same
//      look through `navigator.sendBeacon`, because the feed being read when
//      the tab closes never LEAVES and would come back as new next session.
//
// A feed merely on screen, passed during a pan, or covered by a pane was not
// looked at and keeps its new posts new.
// =============================================================================

export const SEEN_DWELL_MS = 2000;

/** Feeds engaged right now and past their dwell — the exit beacon's list. */
const dwelt = new Set<string>();

/** The exit beacon for every feed dwelt on right now. Module-scope listeners
 *  send it on `pagehide` / `visibilitychange → hidden`; the workspace's mode
 *  switch sends it too (§VII.10), because switching unmounts one mode's
 *  chassis and a look in progress must not wait for the leave to land. */
export function beaconDwelt() {
  const latest = useFeedSeen.getState().latestAsOf;
  for (const feedId of dwelt) {
    const asOf = latest[feedId];
    if (asOf) workspaceFeeds.beaconSeen(feedId, asOf);
  }
}

// Registered once, at module scope, beside the store's own flush listeners.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", beaconDwelt);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") beaconDwelt();
    });
}

/** `onDwell` fires once, when an engagement becomes a dwell — the queue's
 *  `settle` (§V.3). A ref, so a new closure each render does not reset the
 *  clock. */
export function useFeedSeenDwell(
  feedId: string,
  engaged: boolean,
  onDwell?: () => void,
): void {
  const onDwellRef = useRef(onDwell);
  onDwellRef.current = onDwell;
  useEffect(() => {
    if (!engaged) return;
    let reached = false;
    const timer = setTimeout(() => {
      reached = true;
      dwelt.add(feedId);
      onDwellRef.current?.();
    }, SEEN_DWELL_MS);
    return () => {
      clearTimeout(timer);
      if (!reached) return;
      dwelt.delete(feedId);
      // Moment 1: leaving after dwell. A failure keeps the old baseline,
      // which errs toward showing more as new.
      void useFeedSeen.getState().markSeen(feedId);
    };
  }, [feedId, engaged]);
}
