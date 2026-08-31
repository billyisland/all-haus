import { create } from "zustand";
import {
  applyPaletteOverrides,
  normalizeHex,
  PALETTE_REGISTRY,
  PALETTE_STORAGE_KEY,
} from "../lib/palette/registry";

// =============================================================================
// usePaletteDevtool — TEMPORARY live colour-tuning kit (see lib/palette/
// registry.ts). Holds the per-slug hex overrides, mirrors them to
// localStorage, and pushes them onto :root as inline CSS vars. The panel is
// deliberately NOT a Glasshouse: it floats above everything, leaves the
// backdrop sharp, and never touches any open overlay's state.
// =============================================================================

interface PaletteDevtoolState {
  isOpen: boolean;
  /** slug → '#RRGGBB' for every colour the user has changed. */
  overrides: Record<string, string>;
  open: () => void;
  close: () => void;
  setColor: (slug: string, hex: string) => void;
  resetColor: (slug: string) => void;
  resetAll: () => void;
  /** Replace the whole override set — preset themes (lib/palette/themes.ts). */
  setOverrides: (overrides: Record<string, string>) => void;
  /** Load persisted overrides and apply them to :root (called once on mount). */
  hydrate: () => void;
}

function persist(overrides: Record<string, string>) {
  try {
    if (Object.keys(overrides).length === 0)
      localStorage.removeItem(PALETTE_STORAGE_KEY);
    else localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // storage full/blocked — live tuning still works for the session
  }
}

export const usePaletteDevtool = create<PaletteDevtoolState>((set, get) => ({
  isOpen: false,
  overrides: {},
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  setColor: (slug, hex) => {
    const overrides = { ...get().overrides, [slug]: hex };
    applyPaletteOverrides(overrides);
    persist(overrides);
    set({ overrides });
  },
  resetColor: (slug) => {
    const overrides = { ...get().overrides };
    delete overrides[slug];
    applyPaletteOverrides(overrides);
    persist(overrides);
    set({ overrides });
  },
  setOverrides: (overrides) => {
    applyPaletteOverrides(overrides);
    persist(overrides);
    set({ overrides });
  },
  resetAll: () => {
    applyPaletteOverrides({});
    persist({});
    set({ overrides: {} });
  },
  hydrate: () => {
    try {
      const raw = localStorage.getItem(PALETTE_STORAGE_KEY);
      if (!raw) return;
      const persisted = JSON.parse(raw) as Record<string, string>;
      // Drop slugs no longer in the registry (renames/removals) — a stale key
      // is invisible in the panel but inflates the changed count and locks
      // theme matching onto "Custom". Unlike preset themes, the devtool may
      // legitimately hold THEME_LOCKED_SLUGS, so filter on the registry only.
      // Also validate the stored *value*: a corrupt/hand-edited blob that isn't
      // a real hex would otherwise flow into hexToTriple, where parseInt(NaN)
      // collapses to "0 0 0" and silently renders that colour pure black
      // instead of falling back to the registry default. Skip anything that
      // doesn't normalize (same gate the live-input path already applies).
      const overrides: Record<string, string> = {};
      for (const entry of PALETTE_REGISTRY) {
        const value = persisted[entry.slug];
        if (value && normalizeHex(value)) overrides[entry.slug] = value;
      }
      if (Object.keys(overrides).length !== Object.keys(persisted).length)
        persist(overrides);
      applyPaletteOverrides(overrides);
      set({ overrides });
    } catch {
      // corrupt blob — ignore, defaults stand
    }
  },
}));
