import { useSyncExternalStore } from "react";
import { create } from "zustand";

// =============================================================================
// useColorScheme — the global light/dark/system appearance preference. A
// per-device display setting (like useTypeScale), persisted to localStorage and
// applied by toggling `html.dark`: globals.css inverts the canonical neutral
// ramp under that class, so the whole global shell (workspace ground, reader,
// profile, every Glasshouse overlay, dropdowns) flips. Desktop feed vessels
// re-pin those slugs to canonical light via LIGHT_ISLAND_STYLE
// (web/src/lib/palette/island.ts), so feeds keep their per-scheme colours.
//
// Per-device by design (localStorage, not the account). Applied on boot by the
// headless ColorSchemeHydrator (mirrors TypeScaleHydrator) and a blocking
// inline script in app/layout.tsx (no white flash), and immediately on change.
// =============================================================================

export type ColorMode = "light" | "dark" | "system";

const STORAGE_KEY = "ah:color-mode";

export const COLOR_MODES: ColorMode[] = ["light", "dark", "system"];

export const COLOR_MODE_LABEL: Record<ColorMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function isMode(v: string | null): v is ColorMode {
  return v === "light" || v === "dark" || v === "system";
}

/** Whether a mode resolves to dark right now (system → OS preference). */
export function resolveDark(mode: ColorMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply a mode to the document root. Called on change, on boot, on OS change. */
export function applyColorMode(mode: ColorMode): void {
  if (typeof document === "undefined") return;
  const dark = resolveDark(mode);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/** Read the persisted mode (defaults to 'light' to preserve current look). */
function readPersisted(): ColorMode {
  if (typeof window === "undefined") return "light";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : "light";
  } catch {
    return "light";
  }
}

interface ColorSchemeState {
  mode: ColorMode;
  /** Effective dark flag — kept in state so components re-render on change. */
  dark: boolean;
  /** Set, persist, and apply to the document root. */
  setMode: (mode: ColorMode) => void;
  /** Boot: read the persisted value into state + apply it. */
  hydrate: () => void;
  /** Re-evaluate when the OS preference changes while mode is 'system'. */
  refreshSystem: () => void;
}

export const useColorScheme = create<ColorSchemeState>((set, get) => ({
  mode: "light",
  dark: false,
  setMode: (mode) => {
    applyColorMode(mode);
    set({ mode, dark: resolveDark(mode) });
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  },
  hydrate: () => {
    const mode = readPersisted();
    applyColorMode(mode);
    set({ mode, dark: resolveDark(mode) });
  },
  refreshSystem: () => {
    if (get().mode !== "system") return;
    applyColorMode("system");
    set({ dark: resolveDark("system") });
  },
}));

// =============================================================================
// useResolvedDark — a FLASH-FREE dark flag for surfaces that drive INLINE STYLES
// from the mode (the landing vessel + static lockup) rather than letting
// `html.dark` + the CSS var inversion do it.
//
// The store's own `dark` field defaults to false and only flips once `hydrate()`
// runs in a post-mount effect, so `useColorScheme(s => s.dark)` reports light on
// the first client render — fine for CSS-driven chrome (the pre-paint script in
// app/layout.tsx already set `html.dark`, and CSS reads it for free), but wrong
// for a surface that picks its palette variant in JS: a dark-mode visitor paints
// the light variant, then snaps to dark.
//
// This reads the DOM class the blocking script already set as the client
// snapshot, with `false` as the server snapshot (SSR can't know a per-device
// preference — it matches the light default the rest of the SSR tree renders).
// Because it's a useSyncExternalStore, React reconciles the two during hydration
// BEFORE paint, so the light variant never shows. Subscribing to the store means
// a live mode toggle (which re-toggles the class) re-reads.
// =============================================================================
export function useResolvedDark(): boolean {
  return useSyncExternalStore(
    (onChange) => useColorScheme.subscribe(onChange),
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}
