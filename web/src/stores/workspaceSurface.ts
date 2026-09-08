import { create } from "zustand";

// Presence registry for the workspace surface itself — true exactly while
// `WorkspaceView` (desktop floor or mobile pager alike; it is the shared root)
// is mounted.
//
// Why it exists: `useLayoutMode` is a pure URL classifier, and the URL lies
// about the workspace twice. A URL-synced overlay (reader / profile / surface)
// claims its real URL with a raw `pushState`, which syncs `usePathname`
// WITHOUT re-rendering the route — so the workspace stays mounted under a URL
// that classifies as `canvas`. That much `LayoutShell` already handles while
// the overlay is OPEN (the overlay stores' `isOpen` flags). What those flags
// cannot cover is the CLOSE: `close()` runs `history.back()` and the store
// clears `isOpen` in its own popstate listener synchronously, while Next
// processes the same popstate inside a TRANSITION — so for a few frames the
// overlay reads closed while `usePathname` still reports the overlay's URL.
// In that window "non-workspace URL, no overlay open" is true, and LayoutShell
// mounted the public nav chrome over the live workspace: a phantom second bar
// that vanished on the next render (in the bottom-row era, a phantom bottom
// row — the reported glitch), plus a floor shifted by the band it reserved.
//
// The mount flag is the positive fact the race cannot fake: while the
// workspace surface is on screen, its own chrome rules, whatever the URL says
// mid-transition. `LayoutShell` reads it as a third condition on the public
// bar; nothing else should need it — a component INSIDE the workspace already
// knows it is there.
interface WorkspaceSurfacePresence {
  mounted: boolean;
  /** Internal — WorkspaceView sets true on mount, false on unmount. */
  _setMounted: (mounted: boolean) => void;
}

export const useWorkspaceSurface = create<WorkspaceSurfacePresence>((set) => ({
  mounted: false,
  _setMounted: (mounted) => set({ mounted }),
}));
