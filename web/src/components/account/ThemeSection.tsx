'use client'

// =============================================================================
// ThemeSection — sitewide preset-theme picker (feature-debt §3, tier 2).
//
// PARKED (GLASSHOUSE-AND-PALETTE-ADR §III.5): retired from Settings — preset
// theming is no longer user-facing (reclaiming a single canonical identity).
// Not deleted, not mounted; the override mechanism it drove still exists for
// operators (devtool) and any future use. Boot-time hydration now lives in the
// headless PaletteHydrator, not PalettePanel (see the note below).
//
// Curated, complete var-sets only — never free per-var knobs (the global
// registry has no derivable surface/text structure, so free tuning can make
// the site illegible; designed presets can't). Applies through the Palette
// devtool's override store, so a preset persists in the same localStorage key,
// hydrates on boot via the globally-mounted PalettePanel, and shows up
// honestly in the devtool. Hand-tuned devtool state reads as "Custom" here;
// picking a preset replaces it.
//
// Per-feed colour schemes are a separate axis (each feed's composer); the
// Glasshouse pane, ∀ chrome and trust pips are locked out of theming entirely
// (lib/palette/themes.ts).
// =============================================================================

import { usePaletteDevtool } from '../../stores/paletteDevtool'
import {
  PRESET_THEMES,
  matchesPreset,
  sanitizeThemeOverrides,
  type PresetTheme,
} from '../../lib/palette/themes'
import { PALETTE_REGISTRY } from '../../lib/palette/registry'

const REGISTRY_DEFAULT = new Map(PALETTE_REGISTRY.map((e) => [e.slug, e.hex]))

// The strip previews the slugs a preset most visibly moves.
const STRIP_SLUGS = ['ink', 'bone', 'white', 'crimson'] as const

function stripColours(theme: PresetTheme): string[] {
  return STRIP_SLUGS.map(
    (slug) => theme.overrides[slug] ?? REGISTRY_DEFAULT.get(slug) ?? '#FFFFFF',
  )
}

export function ThemeSection() {
  const overrides = usePaletteDevtool((s) => s.overrides)
  const setOverrides = usePaletteDevtool((s) => s.setOverrides)

  const active = PRESET_THEMES.find((t) => matchesPreset(overrides, t))
  const isCustom = !active && Object.keys(overrides).length > 0

  return (
    <div className="bg-glasshouse-well px-6 py-5">
      <p className="label-ui text-grey-400 mb-4">Theme</p>
      <p className="text-ui-xs text-grey-600 mb-4 leading-relaxed">
        Sitewide colour preset. Each feed&rsquo;s own colour scheme is picked in
        its feed composer; this sets the ground everything else sits on.
      </p>
      <div className="flex flex-wrap gap-3">
        {PRESET_THEMES.map((theme) => {
          const selected = active?.id === theme.id
          return (
            <button
              key={theme.id}
              type="button"
              title={theme.blurb}
              aria-pressed={selected}
              onClick={() => setOverrides(sanitizeThemeOverrides(theme.overrides))}
              className="flex flex-col items-start gap-2 bg-grey-100 px-3 py-2"
              style={{
                outline: selected ? '2px solid var(--ah-ink)' : 'none',
                outlineOffset: 2,
                cursor: 'pointer',
              }}
            >
              <span className="flex">
                {stripColours(theme).map((hex, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'block',
                      width: 16,
                      height: 16,
                      background: hex,
                    }}
                  />
                ))}
              </span>
              <span className="text-ui-xs font-medium text-black">
                {theme.name}
              </span>
            </button>
          )
        })}
      </div>
      {isCustom && (
        <p className="text-ui-xs text-grey-600 mt-4 leading-relaxed">
          A custom palette is active (set via the Palette devtool). Picking a
          preset replaces it.
        </p>
      )}
    </div>
  )
}
