// Workspace colour palettes — per-feed colour schemes (feature-debt §3,
// productising WIREFRAME-DECISIONS-CONSOLIDATED.md "Colour tokens committed").
//
// A feed scheme is now a COLOURWAY (seasonal character — hue / energy / warmth),
// ORTHOGONAL to light/dark: the colourway is per-feed, but whether it renders
// light or dark follows the GLOBAL light/dark toggle (useColorScheme). So
// `paletteFor(scheme, dark)` takes the global dark flag and returns that
// colourway's light- or dark-variant palette.
//
//   • 'basic'  — the plain reference palette: BASIC_LIGHT (light) / BASIC_DARK
//                (dark), both hand-tuned (incl. the ink-850/ink-925 bar steps).
//   • spring / summer / autumn / winter — CURATED SURFACE SETS, each with a
//     light AND a dark triple (walls / interior / card, slugs in
//     lib/palette/registry.ts). Text colours are DERIVED, never hand-set:
//     luminance picks between the two tuned text ramps (light-surface ramp from
//     BASIC_LIGHT, dark-surface ramp from BASIC_DARK), so the primary/secondary/
//     muted hierarchy survives any curated surface, and the semantic flip rides
//     the same switch (crimson → crimson-soft on dark cards). Curate each
//     variant's card clearly light or clearly dark — a mid-luminance card
//     defeats both ramps.
//
// Desktop vessels carry LIGHT_ISLAND_STYLE so the neutral text slugs (bone/ink/
// white/…) the derivation references resolve canonical regardless of the global
// mode; the palette then explicitly selects the light or dark variant. So the
// island stays, but it no longer freezes the feed to light — the VARIANT does
// the light/dark, the island only keeps the derivation deterministic.
//
// `normalizeBrightness` maps any stale persisted value (retired 'medium'/'dim'/
// 'primary'/'dark', or a scheme id from a newer build) onto a live colourway so
// old localStorage layouts and stale clients keep working. The colourway id
// list must mirror FEED_SCHEME_IDS in gateway/src/routes/feeds/crud.ts.

import { PALETTE_REGISTRY } from '../../lib/palette/registry'

// ---------------------------------------------------------------------------
// Vessel geometry — the ONE home for the three numbers that make a feed look
// like a feed. They live here rather than in Vessel.tsx because the profile
// pane reproduces them exactly (PROFILE-PANE-REDESIGN-ADR §9.2) and importing
// Vessel.tsx for a constant would drag framer-motion into the profile bundle.
//
// THE FEED'S CARD RHYTHM IS 20px, NOT 8. It is the column's `gap` PLUS each
// card's own `marginBottom` (`GAP_PX.feed`, level-spec.ts), and the two are
// additive in a flex column. Four surfaces (profile, tag, source, and the
// native work/social logs) each carried a comment asserting the feed ran at
// 8px, which was the card margin alone measured without its column — so they
// all sat at 8 while claiming to match a feed that sat at 20. Measured off the
// running vessel, not recalled. A log that wants the feed's rhythm therefore
// spreads FEED_LOG_STYLE (ProfileChrome) rather than deleting its wrapper.
// ---------------------------------------------------------------------------

/** Vessel side-wall thickness. Equal to the workspace lattice square. */
export const VESSEL_WALL = 8
/** Interior padding between a wall and the cards. */
export const VESSEL_PAD = 16
/** Flex gap on the card column; ADDS to each card's own `GAP_PX.feed` margin. */
export const VESSEL_GAP = 12

export type FeedScheme =
  | 'basic'
  | 'spring'
  | 'summer'
  | 'autumn'
  | 'winter'
// Legacy name — the per-vessel "brightness" axis grew into the scheme picker;
// the persisted localStorage field and existing prop names keep this alias.
export type Brightness = FeedScheme
export type Density = 'compact' | 'standard' | 'headline'
export type Orientation = 'vertical' | 'horizontal'

export const DEFAULT_BRIGHTNESS: FeedScheme = 'basic'
export const DEFAULT_DENSITY: Density = 'standard'
export const DEFAULT_ORIENTATION: Orientation = 'vertical'

export interface VesselPalette {
  /** The colourway this palette was built from. Carried on the palette itself
   *  so a consumer holding only a palette (the card byline) can hand the SCHEME
   *  on — the profile pane re-derives the whole palette from it rather than
   *  taking a single colour, which is what lets a profile launched off a feed
   *  card wear that feed's colourway entire (PROFILE-PANE-REDESIGN-ADR D2, as
   *  amended 2026-08-28). A colour alone could only ever tint the frame. */
  scheme: FeedScheme
  /** Dark-card family — drives isDarkPalette() and the derived text ramp. */
  isDark: boolean
  walls: string
  interior: string
  nameLabel: string
  cardBg: string
  cardTitle: string
  cardStandfirst: string
  cardMeta: string
  // Quoted-post embed surface. The embed sits on the vessel WALLS colour (not
  // the interior/ground), so its text is derived against the walls luminance —
  // a strong-contrast primary + a legible muted, independent of the card ramp.
  quoteBg: string
  quoteText: string
  quoteMeta: string
  crimson: string
  resizeHandle: string
  pipOpacity: number
  barBg: string
  barText: string
  barTextMuted: string
  barInputBg: string
  barInputText: string
  barInputPlaceholder: string
  barDropdownBg: string
  barDropdownHover: string
}

// Same weighting as the PalettePanel helper — keep the two in agreement.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (
    (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) /
    255
  )
}

const REGISTRY_HEX = new Map(PALETTE_REGISTRY.map((e) => [e.slug, e.hex]))
function registryHex(slug: string): string {
  const hex = REGISTRY_HEX.get(slug)
  if (!hex) throw new Error(`Unknown palette registry slug: ${slug}`)
  return hex
}

// Curated colourway → its three surfaces (registry slugs), for BOTH the light
// and dark variant. The bar shares the walls colour, mirroring basic (ink/ink
// light, true-black/true-black dark).
type SurfaceSet = { walls: string; interior: string; cardBg: string }
const SCHEME_SURFACES: Record<
  Exclude<FeedScheme, 'basic'>,
  { light: SurfaceSet; dark: SurfaceSet }
> = {
  spring: {
    light: { walls: 'spring-walls', interior: 'spring-interior', cardBg: 'spring-card' },
    dark: { walls: 'spring-walls-dk', interior: 'spring-interior-dk', cardBg: 'spring-card-dk' },
  },
  summer: {
    light: { walls: 'summer-walls', interior: 'summer-interior', cardBg: 'summer-card' },
    dark: { walls: 'summer-walls-dk', interior: 'summer-interior-dk', cardBg: 'summer-card-dk' },
  },
  autumn: {
    light: { walls: 'autumn-walls', interior: 'autumn-interior', cardBg: 'autumn-card' },
    dark: { walls: 'autumn-walls-dk', interior: 'autumn-interior-dk', cardBg: 'autumn-card-dk' },
  },
  winter: {
    light: { walls: 'winter-walls-lt', interior: 'winter-interior-lt', cardBg: 'winter-card-lt' },
    dark: { walls: 'winter-walls', interior: 'winter-interior', cardBg: 'winter-card' },
  },
}

// Expand a curated surface set into a full VesselPalette. Luminance is read
// from the canonical registry hex (devtool overrides re-skin the rendered
// vars but don't flip the text family — curated schemes are committed to one
// family). The bar wells are derived washes of the walls var via color-mix so
// they keep tracking live-tuned walls.
function deriveVesselPalette(
  scheme: Exclude<FeedScheme, 'basic'>,
  s: {
    walls: string
    interior: string
    cardBg: string
  },
): VesselPalette {
  const v = (slug: string) => `var(--ah-${slug})`
  const darkCard = luminance(registryHex(s.cardBg)) < 0.5
  const darkInterior = luminance(registryHex(s.interior)) < 0.5
  const darkBar = luminance(registryHex(s.walls)) < 0.5
  const well = (pct: number) =>
    `color-mix(in srgb, ${v(s.walls)}, rgb(var(--ah-${
      darkBar ? 'white' : 'ink'
    }-rgb)) ${pct}%)`
  return {
    scheme,
    isDark: darkCard,
    walls: v(s.walls),
    interior: v(s.interior),
    nameLabel: darkInterior ? 'var(--ah-stone-350)' : 'var(--ah-stone-600)',
    cardBg: v(s.cardBg),
    cardTitle: darkCard ? 'var(--ah-bone)' : 'var(--ah-ink)',
    cardStandfirst: darkCard ? 'var(--ah-stone-300)' : 'var(--ah-stone-600)',
    cardMeta: 'var(--ah-stone-400)',
    // Quote embed rides the walls surface → contrast against walls luminance.
    quoteBg: v(s.walls),
    quoteText: darkBar ? 'var(--ah-bone-bright)' : 'var(--ah-ink)',
    quoteMeta: darkBar ? 'var(--ah-stone-350)' : 'var(--ah-stone-600)',
    crimson: darkCard ? 'var(--ah-crimson-soft)' : 'var(--ah-crimson)',
    resizeHandle: 'var(--ah-stone-600)',
    pipOpacity: 1,
    barBg: v(s.walls),
    barText: darkBar ? 'var(--ah-bone-bright)' : 'var(--ah-ink)',
    barTextMuted: darkBar ? 'var(--ah-stone-400)' : 'var(--ah-stone-600)',
    barInputBg: well(9),
    barInputText: darkBar ? 'var(--ah-bone-bright)' : 'var(--ah-ink)',
    barInputPlaceholder: darkBar ? 'var(--ah-stone-350)' : 'var(--ah-stone-400)',
    barDropdownBg: well(5),
    barDropdownHover: well(9),
  }
}

// The two reference palettes stay literal (hand-tuned wells incl. the
// ink-850/ink-925 bar steps) — they are the 'basic' colourway's light and dark
// variants, and the source of the two derived text ramps.
const BASIC_LIGHT: VesselPalette = {
  scheme: 'basic',
  isDark: false,
  walls: 'var(--ah-ink)',
  interior: 'var(--ah-bone)',
  nameLabel: 'var(--ah-stone-600)',
  cardBg: 'var(--ah-white)',
  cardTitle: 'var(--ah-ink)',
  cardStandfirst: 'var(--ah-stone-600)',
  cardMeta: 'var(--ah-stone-400)',
  quoteBg: 'var(--ah-ink)',
  quoteText: 'var(--ah-bone-bright)',
  quoteMeta: 'var(--ah-stone-350)',
  crimson: 'var(--ah-crimson)',
  resizeHandle: 'var(--ah-stone-600)',
  pipOpacity: 1,
  barBg: 'var(--ah-ink)',
  barText: 'var(--ah-bone-bright)',
  barTextMuted: 'var(--ah-stone-400)',
  barInputBg: 'var(--ah-ink-850)',
  barInputText: 'var(--ah-bone-bright)',
  barInputPlaceholder: 'var(--ah-ink-grey)',
  barDropdownBg: 'var(--ah-ink-925)',
  barDropdownHover: 'var(--ah-ink-850)',
}
const BASIC_DARK: VesselPalette = {
  scheme: 'basic',
  isDark: true,
  walls: 'var(--ah-true-black)',
  interior: 'var(--ah-ink-925)',
  nameLabel: 'var(--ah-stone-350)',
  cardBg: 'var(--ah-ink-900)',
  cardTitle: 'var(--ah-bone)',
  cardStandfirst: 'var(--ah-stone-300)',
  cardMeta: 'var(--ah-stone-400)',
  quoteBg: 'var(--ah-true-black)',
  quoteText: 'var(--ah-bone-bright)',
  quoteMeta: 'var(--ah-stone-350)',
  crimson: 'var(--ah-crimson-soft)',
  resizeHandle: 'var(--ah-stone-600)',
  pipOpacity: 1,
  barBg: 'var(--ah-true-black)',
  barText: 'var(--ah-bone-bright)',
  barTextMuted: 'var(--ah-stone-400)',
  barInputBg: 'var(--ah-ink-850)',
  barInputText: 'var(--ah-bone-bright)',
  barInputPlaceholder: 'var(--ah-ink-grey)',
  barDropdownBg: 'var(--ah-ink-925)',
  barDropdownHover: 'var(--ah-ink-850)',
}

// Precompute the four seasonal colourways × {light, dark} = 8 derived palettes,
// so paletteFor is a table lookup, not a per-card derivation.
const SEASONAL_PALETTES: Record<
  Exclude<FeedScheme, 'basic'>,
  { light: VesselPalette; dark: VesselPalette }
> = {
  spring: {
    light: deriveVesselPalette('spring', SCHEME_SURFACES.spring.light),
    dark: deriveVesselPalette('spring', SCHEME_SURFACES.spring.dark),
  },
  summer: {
    light: deriveVesselPalette('summer', SCHEME_SURFACES.summer.light),
    dark: deriveVesselPalette('summer', SCHEME_SURFACES.summer.dark),
  },
  autumn: {
    light: deriveVesselPalette('autumn', SCHEME_SURFACES.autumn.light),
    dark: deriveVesselPalette('autumn', SCHEME_SURFACES.autumn.dark),
  },
  winter: {
    light: deriveVesselPalette('winter', SCHEME_SURFACES.winter.light),
    dark: deriveVesselPalette('winter', SCHEME_SURFACES.winter.dark),
  },
}

// globalContentPalette — the palette for content that follows the GLOBAL
// light/dark toggle (useColorScheme) but carries NO per-feed colourway: profile
// content-logs and mobile feeds. It is the BASIC_LIGHT palette, whose slug
// references (var(--ah-white)/var(--ah-ink)/…) invert automatically under
// html.dark, so the cards render light or dark with the global mode. (It does
// NOT use BASIC_DARK, which would need an island to read right — this surface is
// rendered OUTSIDE any island, so it relies on the html.dark inversion.) Only
// the derived isDark flag and the crimson accent need correcting for dark
// (washes + vote/accent colour), since the slug values alone can't signal "now
// dark" to the consumer.
export function globalContentPalette(dark: boolean): VesselPalette {
  // The mode-specific stone tones (standfirst / name labels) are NOT in
  // DARK_SLUGS, so they don't invert under html.dark — the light-mode stone-600
  // would render dark-on-dark. Borrow the dark tones so secondary text stays
  // legible (registry: stone-300 = dark-mode standfirst, stone-350 = name).
  // The BAR fields need the same correction, and for the same reason — but the
  // consequence is worse, so this is required work rather than a nicety
  // (PROFILE-PANE-REDESIGN-ADR §4.1). These fields have only ever been consumed
  // on ISLANDED vessel bars; the profile pane consumes them un-islanded, where
  // only the neutral slugs invert. `barBg` (ink) and `barText`/`barInputText`
  // (bone-bright) are DARK_SLUGS and flip coherently — a light slab with dark
  // text. `barTextMuted` (stone-400), `barInputBg` (ink-850) and the two
  // dropdown fields (ink-925/850) are in the NEVER-inverted set, so left alone
  // the `+` well renders near-black under a near-black glyph (≈1.07:1) and the
  // handle's stone-400 sits at ≈2.3:1 on the inverted bar.
  //
  // Override only what reads wrong: once `barInputBg` is light, the inverted
  // `barInputText` is already correct. Do not derive a second contrast ramp for
  // the bar beyond these.
  return dark
    ? {
        ...BASIC_LIGHT,
        isDark: true,
        crimson: 'var(--ah-crimson-soft)',
        cardStandfirst: 'var(--ah-stone-300)',
        nameLabel: 'var(--ah-stone-350)',
        barTextMuted: 'var(--ah-stone-600)',
        barInputBg: 'var(--ah-bar-well-dk)',
        barInputPlaceholder: 'var(--ah-stone-600)',
        barDropdownBg: 'var(--ah-bar-well-dk)',
        // A step darker than the well, mixed toward true-black (which never
        // inverts) so the hover is deterministic in the one mode it renders in.
        barDropdownHover:
          'color-mix(in srgb, var(--ah-bar-well-dk), var(--ah-true-black) 8%)',
      }
    : BASIC_LIGHT
}

// Scheme order for the FeedComposer Colour menu (a little palette of one dot
// per scheme). The schemes carry no user-facing display name — the SchemeDot
// (the scheme's forceful walls colour) is the sole identifier — so this is
// id-only.
export const SCHEME_OPTIONS: ReadonlyArray<{ id: FeedScheme }> = [
  { id: 'basic' },
  { id: 'spring' },
  { id: 'summer' },
  { id: 'autumn' },
  { id: 'winter' },
]

const SCHEME_IDS = new Set<string>(SCHEME_OPTIONS.map((o) => o.id))

// Retired-scheme migration (DESIGN-TUNING-FINDINGS §3, superseding the
// FEED-SCHEME-REFRESH-ADR renames): feeds persist a scheme id, and the
// colourful schemes have been replaced by the four-seasons family. Map each
// retired id to its nearest surviving season by hue BEFORE the SCHEME_IDS test,
// so an existing feed lands on a matched scheme instead of flattening to Paper.
const SCHEME_ALIASES: Record<string, FeedScheme> = {
  // The two former mode-fixed reference schemes collapse into the one 'basic'
  // colourway (light/dark is now the GLOBAL toggle, not the per-feed scheme):
  primary: 'basic',
  dark: 'basic',
  // Four-seasons predecessors (Brazilian-modernist family), by hue:
  anil: 'winter', // slate indigo → cool slate-indigo
  vela: 'spring', // coastal teal → fresh green
  caju: 'autumn', // ember coral → bold ember
  // Earlier retired ids, re-pointed through the new family:
  blush: 'autumn', // hot pink/coral → ember
  sage: 'spring', // green → fresh green
  sand: 'summer', // warm tan → warm-sand summer
  slate: 'winter', // dark blue → slate-indigo
  mata: 'spring', // dropped green → fresh green
  cobalto: 'winter', // electric blue → slate-indigo
}

// Coerce any value (stale persisted 'medium'/'dim', unknown scheme ids from a
// newer build, junk) to a live scheme. Retired ids resolve via SCHEME_ALIASES
// first; everything else falls through to the Paper default.
export function normalizeBrightness(
  b: Brightness | string | null | undefined,
): FeedScheme {
  if (typeof b !== 'string') return 'basic'
  if (SCHEME_IDS.has(b)) return b as FeedScheme
  if (b in SCHEME_ALIASES) return SCHEME_ALIASES[b]
  return 'basic'
}

// Palette lookup for a feed's colourway in the current GLOBAL light/dark mode.
// `dark` is the resolved useColorScheme().dark flag — desktop vessels pass it so
// a feed renders its colourway's light or dark variant matching the global mode.
// Callers that render OUTSIDE a light island (mobile / profile content) use
// globalContentPalette instead. Tolerates stale/undefined scheme ids.
export function paletteFor(
  b: Brightness | string | null | undefined,
  dark = false,
): VesselPalette {
  const c = normalizeBrightness(b)
  if (c === 'basic') return dark ? BASIC_DARK : BASIC_LIGHT
  return SEASONAL_PALETTES[c][dark ? 'dark' : 'light']
}

// True when the palette is a dark-card family. Lets palette-only consumers pick
// a mode-aware translucent wash (a dark wash reads on light cards, a light wash
// on dark cards) without also threading the scheme through.
export function isDarkPalette(p: VesselPalette): boolean {
  return p.isDark
}

// Density is a three-state cycle: Standard (the full card) → Condensed (tight
// padding, media + action row hidden, standfirst kept) → Headline (as Condensed,
// but the standfirst/dek is also dropped — an article is its whole headline and
// nothing else, a note its whole body; neither is clamped). A former value
// 'full' rendered byte-identically to 'standard', so it was removed;
// normalizeDensity migrates any persisted 'full' (or junk) to 'standard' on
// read, so no DB backfill is needed.
export function normalizeDensity(
  d: Density | string | null | undefined,
): Density {
  return d === 'compact' || d === 'headline' ? d : 'standard'
}

export function nextDensity(d: Density): Density {
  return d === 'standard' ? 'compact' : d === 'compact' ? 'headline' : 'standard'
}

export function nextOrientation(o: Orientation): Orientation {
  return o === 'vertical' ? 'horizontal' : 'vertical'
}

// Per-feed reading-text size (task 8/9). Governs the prose body of every card
// in a feed (main, reply, parent) in lockstep; meta rows and bylines (mono
// `label-ui`) stay fixed. Default step 3 = 13.5px keeps today's body size; the
// range either side is deliberately wide so the smallest and largest steps
// read as distinctly denser / more generous, not just adjacent half-points.
export type TextSize = 1 | 2 | 3 | 4 | 5
export const DEFAULT_TEXT_SIZE: TextSize = 3
export const TEXT_SIZE_PX: Record<TextSize, number> = {
  1: 11,
  2: 12.25,
  3: 13.5,
  4: 15.75,
  5: 18,
}
export function nextTextSize(t: TextSize): TextSize {
  return t >= 5 ? 1 : ((t + 1) as TextSize)
}
