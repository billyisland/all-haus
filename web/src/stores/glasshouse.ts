import { create } from "zustand";

// Presence registry for the single live <Glasshouse>. The "one Glasshouse at a
// time" invariant means this is always 0-or-1: Glasshouse.tsx writes the active
// pane's `onClose` here on mount and clears it on unmount.
//
// Why it exists: on the mobile workspace every Glasshouse is a full-screen sheet
// (MOBILE-LAYOUT-ADR §III), so the ∀ disc — which already floats crisp above the
// frost (z-60) — becomes the universal minimise-X for whatever sheet is open, not
// just the six ∀-menu destinations. ForallMenu reads `isOpen` to flip the glyph
// and calls `close()` to dismiss the sheet (the same close its own ✕ fires).
interface GlasshousePresence {
  isOpen: boolean;
  /** Closes the active Glasshouse (no-op when none is open). */
  close: () => void;
  /** Internal — Glasshouse.tsx sets the active pane's onClose, or null to clear. */
  _set: (close: (() => void) | null) => void;
  /** True while a ∀ disc that STANDS IN as the sheet's dismiss affordance is on
   *  screen — i.e. ForallMenu is mounted AND at the mobile breakpoint, where the
   *  disc flips to the minimise-X. Written by ForallMenu; read by every pane
   *  that would otherwise draw a second ✕ (`useDiscCloseActive`). */
  discClose: boolean;
  /** Internal — ForallMenu declares whether its disc is acting as the close. */
  _setDiscClose: (active: boolean) => void;
}

export const useGlasshousePresence = create<GlasshousePresence>((set) => ({
  isOpen: false,
  close: () => {},
  _set: (close) => set({ isOpen: !!close, close: close ?? (() => {}) }),
  discClose: false,
  _setDiscClose: (active) => set({ discClose: active }),
}));

// =============================================================================
// useDiscCloseActive — "the ∀ disc is this sheet's X, so do not draw another".
//
// A mobile Glasshouse needs exactly ONE dismiss affordance and it is the disc
// (`.claude/rules/web-overlays.md` › Overlay close affordance). But the gate
// CANNOT be `isMobile` alone: ForallMenu is mounted only by WorkspaceView
// (/reader), while ProfileOverlay / SurfaceOverlay / EditorOverlay /
// ComposeOverlay are mounted globally by LayoutShell and open on routes with
// no disc at all
// (/article/:dTag, /:username, /read/:postId, the public register). Suppressing
// there would leave those sheets with NO way out on touch — no scrim gap, no
// Esc key, only the history back-guard. So the disc DECLARES itself and the
// panes ask; absent a declaration every pane keeps its own ✕.
//
// Defaults false, so SSR and first paint draw the ✕ and it withdraws on mount —
// the safe direction: a redundant control for one frame, never a stranded sheet.
// =============================================================================
export function useDiscCloseActive(): boolean {
  return useGlasshousePresence((s) => s.discClose);
}
