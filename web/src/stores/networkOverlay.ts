import { create } from "zustand";

// =============================================================================
// useNetworkOverlay — opens the social graph (following / followers / blocked /
// muted / vouches, plus the feed-reach dial and DM-fee settings) in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// like the ledger and settings overlays, it pushes no shareable URL. Deep links
// arrive as /reader?overlay=network[&tab=vouches] (the retired /network
// route — and the /followers shim before it — redirect into that), handled by
// the deep-link dispatcher in WorkspaceView.
//
// `tab` seeds which section opens; /network?tab=vouches deep-links exist
// (CLAUDE.md cites the trust-graph UI at /network?tab=vouches).
// =============================================================================

export type NetworkTab =
  | "following"
  | "followers"
  | "blocked"
  | "muted"
  | "vouches";

const TABS: NetworkTab[] = [
  "following",
  "followers",
  "blocked",
  "muted",
  "vouches",
];

interface NetworkOverlayState {
  isOpen: boolean;
  tab: NetworkTab;
  open: (opts?: { tab?: NetworkTab | null }) => void;
  close: () => void;
}

export const useNetworkOverlay = create<NetworkOverlayState>((set) => ({
  isOpen: false,
  tab: "following",
  open: (opts) =>
    set({
      isOpen: true,
      tab: opts?.tab && TABS.includes(opts.tab) ? opts.tab : "following",
    }),
  close: () => set({ isOpen: false }),
}));
