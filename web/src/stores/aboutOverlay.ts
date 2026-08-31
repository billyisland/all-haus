import { create } from "zustand";

// =============================================================================
// useAboutOverlay — the About pane for the Explain chrome swap (EXPLAIN-ADR D3).
//
// While Explain is active, ForallMenu swaps the ∀ disc + wordmark for an
// "About all.haus" button (the one live control above the Explain scrim). That
// button opens /about as a STANDARD Glasshouse pane through this store, so it
// inherits the whole frosted-overlay machinery (scrim, ✕, Esc, scroll-lock) and
// registers itself in `useGlasshousePresence` — which ForallMenu reads to
// suppress the swapped chrome while About is up (the pane owns its own dismiss),
// restoring it on close.
//
// Ephemeral chrome, so NO history push (mirrors useExplain, D12): Explain itself
// is not a shareable URL, and its About pane rides the same ephemerality. Direct
// visits to /about still render the full marketing page.
// =============================================================================

interface AboutOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useAboutOverlay = create<AboutOverlayState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
