import { create } from "zustand";

// =============================================================================
// queueFocal
//
// The queue's focal feed, published for the muster (WORKSPACE-QUEUE-ADR
// §VII.0 D1: focal is `in`, everything else `off`). A store and not host state
// because the muster is its only reader: held in `WorkspaceView`, every settle
// re-rendered the whole workspace — and with it, through QueueView's
// `renderContents`, every mounted card tree — to move one roundel.
//
// `QueueView` is the sole writer (`onFocalChange`, at rest). Stores the id
// only; a stale one (the queue left, the feed since hidden) names no roundel.
// =============================================================================

interface QueueFocalState {
  feedId: string | null;
  set: (feedId: string | null) => void;
}

export const useQueueFocal = create<QueueFocalState>((set) => ({
  feedId: null,
  set: (feedId) => set({ feedId }),
}));
