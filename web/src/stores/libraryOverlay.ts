import { create } from "zustand";

// =============================================================================
// useLibraryOverlay — opens the reader's two logs in a workspace Glasshouse
// (frosted overlay, ForallMenu stays crisp above). In-memory only: like the
// ledger and settings overlays, it pushes no shareable URL. Deep links arrive
// as /reader?overlay=library[&tab=…] (the retired /library route — and the
// /history and /reading-history shims before it — redirect into that), handled
// by the deep-link dispatcher in WorkspaceView.
//
// TWO TABS, AND THEIR NAMES ARE THE FEATURE (READING-LOG-AND-LIBRARY-ADR D6).
// `recent` is Recent reading — everything opened in a reader in the last seven
// days, all.haus or not, paid or not. `library` is the all.haus library —
// everything acquired through the money system, with no window. Neither is a
// filter of the other: one is about attention, the other about possession.
//
// They replace `bookmarks | history`, an intention list beside a receipt. The
// intention list was built twice (`bookmarks`, then `feed_saves`) and mounted
// neither time, and the receipt's route answered 500 for its whole life — so
// until 2026-09-04 this overlay had two tabs and neither worked.
//
// `recent` is the default because it is the tab the arrival tour beat points
// at ("the piece you were just reading") and the one a reader returns for.
// =============================================================================

export type LibraryTab = "recent" | "library";

interface LibraryOverlayState {
  isOpen: boolean;
  tab: LibraryTab;
  open: (opts?: { tab?: LibraryTab | null }) => void;
  close: () => void;
}

export const useLibraryOverlay = create<LibraryOverlayState>((set) => ({
  isOpen: false,
  tab: "recent",
  open: (opts) =>
    set({ isOpen: true, tab: opts?.tab === "library" ? "library" : "recent" }),
  close: () => set({ isOpen: false }),
}));
