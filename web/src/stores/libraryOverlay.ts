import { create } from "zustand";

// =============================================================================
// useLibraryOverlay — opens the reader's library (bookmarks + reading history)
// in a workspace Glasshouse (frosted overlay, ForallMenu stays crisp above).
// In-memory only: like the ledger and settings overlays, it pushes no shareable
// URL. Deep links arrive as /reader?overlay=library[&tab=history] (the
// retired /library route — and the /bookmarks, /history, /reading-history shims
// before it — redirect into that), handled by the deep-link dispatcher in
// WorkspaceView.
//
// `tab` seeds which section opens (bookmarks | history); the /reading-history
// and /history shims forward tab=history.
// =============================================================================

export type LibraryTab = "bookmarks" | "history";

interface LibraryOverlayState {
  isOpen: boolean;
  tab: LibraryTab;
  open: (opts?: { tab?: LibraryTab | null }) => void;
  close: () => void;
}

export const useLibraryOverlay = create<LibraryOverlayState>((set) => ({
  isOpen: false,
  tab: "bookmarks",
  open: (opts) =>
    set({ isOpen: true, tab: opts?.tab === "history" ? "history" : "bookmarks" }),
  close: () => set({ isOpen: false }),
}));
