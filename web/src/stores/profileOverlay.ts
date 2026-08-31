import { create } from "zustand";
import type { FeedScheme } from "../components/workspace/tokens";
import { claimOverlayEntry, popOverlayEntry } from "../lib/overlayHistory";

// =============================================================================
// useProfile — the unified profile-overlay store.
//
// One overlay, two profile kinds, backed by a real URL (the reader-pane model,
// see stores/reader.ts):
//   - native   → /<username>          (the WriterActivity profile; NativeProfilePanel)
//   - external → /author/<authorId>   (tier-A/B constructed profile; AuthorProfileView)
//
// Opening pushes the profile's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs render the same profiles full-page. Mounted
// globally (LayoutShell) so any byline / profile link sitewide opens it without
// leaving the current surface.
// =============================================================================

export type ProfileTarget =
  | { kind: "native"; username: string }
  | { kind: "external"; authorId: string };

interface ProfileState {
  isOpen: boolean;
  target: ProfileTarget | null;
  /** When opened from a feed card byline, that feed's COLOURWAY — the pane
   *  re-derives its WHOLE palette from it (bar, interior, cards and the ⊓ frame
   *  alike), rather than taking a single framing colour. Null when opened from
   *  a feed-agnostic surface, where the pane falls back to the global content
   *  palette. */
  frameScheme: FeedScheme | null;

  /** Open a native writer profile by username. */
  openNative: (username: string, frameScheme?: FeedScheme | null) => void;
  /** Open a tier-A/B external author profile by author id. */
  openExternal: (authorId: string, frameScheme?: FeedScheme | null) => void;

  close: () => void;
  /** Clear overlay state without touching history — for when a link inside the
   *  overlay navigates the router away (the navigation owns the history entry). */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

export const useProfile = create<ProfileState>((set, get) => ({
  isOpen: false,
  target: null,
  frameScheme: null,

  openNative: (username, frameScheme) => {
    const clean = username.replace(/^@/, "");
    claimOverlayEntry(`/${clean}`);
    set({
      isOpen: true,
      target: { kind: "native", username: clean },
      frameScheme: frameScheme ?? null,
    });
  },

  openExternal: (authorId, frameScheme) => {
    claimOverlayEntry(`/author/${encodeURIComponent(authorId)}`);
    set({
      isOpen: true,
      target: { kind: "external", authorId },
      frameScheme: frameScheme ?? null,
    });
  },

  close: () => {
    // Pop the shared overlay entry; the popstate listener (_handlePop)
    // finalises state and restores the prior URL — one path for both Back and
    // the close button.
    if (popOverlayEntry()) return;
    set({ isOpen: false, target: null, frameScheme: null });
  },

  dismiss: () => {
    if (get().isOpen) set({ isOpen: false, target: null, frameScheme: null });
  },

  _handlePop: () => {
    if (get().isOpen) set({ isOpen: false, target: null, frameScheme: null });
  },
}));
