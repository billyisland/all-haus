"use client";

// =============================================================================
// PaletteHydrator — headless, UI-less, mounted once at the app root.
//
// Owns the boot-time application of persisted palette overrides: the permanent
// mechanism CLAUDE.md and lib/palette/registry.ts mark as load-bearing (without
// it, saved overrides silently stop applying on reload). Lifted out of
// PalettePanel — now operator-gated and may never mount
// (GLASSHOUSE-AND-PALETTE-ADR §III.5) — so hydration no longer depends on the
// devtool surface being present.
//
// Also runs the one-time override purge (§III.5, product call (b)): retiring
// the user-facing palette/theme editors reclaims a single canonical identity,
// so any existing free-form overrides are cleared ONCE on upgrade. Per-feed
// colour schemes live under a separate key (feeds.appearance / the layout
// store) and are untouched.
// =============================================================================

import { useEffect } from "react";
import { usePaletteDevtool } from "../../stores/paletteDevtool";
import { PALETTE_STORAGE_KEY } from "../../lib/palette/registry";

// Bump the suffix to re-run the purge on a future identity reset.
const PURGE_SENTINEL = "ah:palette-purged-v1";

export function PaletteHydrator() {
  const hydrate = usePaletteDevtool((s) => s.hydrate);
  useEffect(() => {
    try {
      if (!localStorage.getItem(PURGE_SENTINEL)) {
        localStorage.removeItem(PALETTE_STORAGE_KEY);
        localStorage.setItem(PURGE_SENTINEL, "1");
      }
    } catch {
      // storage blocked/full — nothing was persisted to purge anyway
    }
    // Apply whatever survives (post-purge: nothing for users; for operators
    // tuning via the gated devtool after upgrade, their saved set).
    hydrate();
  }, [hydrate]);
  return null;
}
