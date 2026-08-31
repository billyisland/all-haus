import { create } from "zustand";
import type { WorkspaceFeed } from "../lib/api";

// =============================================================================
// useFeedArrivals — feeds minted OUTSIDE WorkspaceView's own create path (a
// follow-graph import started from the Settings overlay or the FeedComposer,
// FOLLOW-GRAPH-IMPORT-ADR §7) are announced here so the live workspace adopts
// the new vessel immediately instead of waiting for the next bootstrap.
// WorkspaceView drains the queue in an effect; announcing with no workspace
// mounted is harmless (the feed appears on the next bootstrap regardless).
// =============================================================================

interface FeedArrivalsState {
  pending: WorkspaceFeed[];
  announce: (feed: WorkspaceFeed) => void;
  /** Remove a drained batch. Batch-scoped (not a wholesale clear) so an
   *  announce landing between the drainer's render and its effect survives
   *  for the next drain instead of being wiped unadopted. */
  consume: (drained: WorkspaceFeed[]) => void;
}

export const useFeedArrivals = create<FeedArrivalsState>((set) => ({
  pending: [],
  announce: (feed) => set((s) => ({ pending: [...s.pending, feed] })),
  consume: (drained) =>
    set((s) => ({ pending: s.pending.filter((f) => !drained.includes(f)) })),
}));
