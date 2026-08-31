import { PALETTE_REGISTRY } from './registry'

// =============================================================================
// Preset themes — curated sitewide var-sets (feature-debt §3, tier 2).
//
// A preset is a complete, DESIGNED partial override of the canonical registry,
// applied through the Palette devtool's existing override mechanism
// (localStorage `ah:palette-overrides`, pushed onto :root as inline vars).
// Users pick a whole preset, never individual vars: unlike the workspace
// `VesselPalette`, the global registry has no derivable surface/text
// structure, so free per-var tuning can make the site illegible.
//
// Locked out of all user theming (the way home): the Glasshouse pane and the
// ∀ chrome keep their fixed registry values regardless of theme, and the
// trust-pip colours never change meaning. `sanitizeThemeOverrides` strips
// those slugs defensively; curated presets must not name them at all.
// =============================================================================

export interface PresetTheme {
  id: string
  name: string
  blurb: string
  /** Partial var-set: registry slug → '#RRGGBB'. Empty = registry defaults. */
  overrides: Record<string, string>
}

export const THEME_LOCKED_SLUGS: ReadonlySet<string> = new Set([
  'glasshouse', // frosted pane — fixed escape chrome
  'glasshouse-well', // inset field/well on the pane — fixed escape chrome
  'ink-925', // ∀ button / panel frames — fixed escape chrome
  'trust-grey', // trust pips carry fixed meaning
  'trust-green',
  'trust-amber',
])

export const PRESET_THEMES: PresetTheme[] = [
  {
    id: 'standard',
    name: 'Standard',
    blurb: 'The canonical registry — ink on bone, crimson accent.',
    overrides: {},
  },
  {
    id: 'warm',
    name: 'Warm',
    blurb: 'Warmed grounds and browned ink; the crimson stays.',
    overrides: {
      ink: '#221915',
      bone: '#F2EEE6',
      'bone-bright': '#E9E4DA',
      cream: '#F6F2EA',
      'cream-hover': '#FBF8F2',
      'off-white': '#FBFAF7',
      'stone-400': '#8C8478',
      'stone-600': '#5F5850',
      'grey-600': '#6B6258',
    },
  },
  {
    id: 'cool',
    name: 'Cool',
    blurb: 'Stone-blue grounds and a graphite ink.',
    overrides: {
      ink: '#14171A',
      bone: '#EDEFF0',
      'bone-bright': '#E3E6E8',
      cream: '#F2F4F5',
      'cream-hover': '#F8FAFB',
      'off-white': '#FAFBFB',
      'stone-400': '#868A8C',
      'stone-600': '#5A5E61',
      'grey-600': '#5F6568',
    },
  },
  {
    id: 'contrast',
    name: 'High contrast',
    blurb: 'True-black ink and darkened secondary text.',
    overrides: {
      ink: '#000000',
      'nav-grey': '#222222',
      'grey-400': '#6E6E6E',
      'grey-600': '#444444',
      'stone-400': '#6E6C64',
      'stone-600': '#45443F',
    },
  },
]

const KNOWN_SLUGS = new Set(PALETTE_REGISTRY.map((e) => e.slug))

/** Drop locked + unknown slugs — the only path from a preset onto :root. */
export function sanitizeThemeOverrides(
  overrides: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [slug, hex] of Object.entries(overrides)) {
    if (THEME_LOCKED_SLUGS.has(slug)) continue
    if (!KNOWN_SLUGS.has(slug)) continue
    clean[slug] = hex
  }
  return clean
}

/** True when the live override set is exactly this preset (key-for-key). */
export function matchesPreset(
  overrides: Record<string, string>,
  theme: PresetTheme,
): boolean {
  const a = Object.entries(overrides)
  const b = Object.entries(theme.overrides)
  if (a.length !== b.length) return false
  return a.every(([slug, hex]) => theme.overrides[slug] === hex)
}
