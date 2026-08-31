import { create } from "zustand";

// =============================================================================
// mobileActiveFeed
//
// Publishes the feed the reader is currently "on" in the mobile pager so the
// ∀ menu can offer a feed-scoped action (Feed settings) relativised to it
// (MOBILE-LAYOUT-ADR §VI — the same target as tapping the active pip, surfaced
// in the command menu where it's discoverable).
//
// Mobile-only: MobileWorkspace is the sole writer and only mounts on the mobile
// shell. On the desktop canvas there is no single active feed (every vessel has
// its own gear), so this stays null and the ∀ row is suppressed.
//
// Stores the id only; WorkspaceView resolves it to a live WorkspaceFeed and
// guards visibility, so a stale id (feed since hidden/deleted) yields no row.
// =============================================================================

interface MobileActiveFeedState {
  feedId: string | null;
  set: (feedId: string | null) => void;
}

export const useMobileActiveFeed = create<MobileActiveFeedState>((set) => ({
  feedId: null,
  set: (feedId) => set({ feedId }),
}));
