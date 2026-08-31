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
}

export const useGlasshousePresence = create<GlasshousePresence>((set) => ({
  isOpen: false,
  close: () => {},
  _set: (close) => set({ isOpen: !!close, close: close ?? (() => {}) }),
}));
