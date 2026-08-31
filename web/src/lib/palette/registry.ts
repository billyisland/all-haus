// =============================================================================
// Canonical colour registry — the single ordered list of every colour the site
// renders. Each entry owns a pair of CSS custom properties defined in
// globals.css `:root`:
//
//   --ah-<slug>-rgb : "R G B" triple (Tailwind consumes it with <alpha-value>)
//   --ah-<slug>     : rgb(var(--ah-<slug>-rgb)) — what inline styles reference
//
// Position in this list is canonical: the Palette devtool renders boxes and the
// copyable identifier list in exactly this order, so "colour 07" always means
// the same set of components.
//
// The registry, the var() indirection, the paletteDevtool store, and the
// headless PaletteHydrator (components/devtools/PaletteHydrator.tsx) are all
// permanent. The PalettePanel devtool is now OPERATOR-ONLY (no user-facing menu
// or settings entry — GLASSHOUSE-AND-PALETTE-ADR §III.5; reach it via ?palette
// or Ctrl+Alt+P) but stays as the operator tuning surface behind the per-feed
// colour schemes (feature-debt.md §3). Boot-time hydration of persisted
// overrides was lifted OUT of the panel into PaletteHydrator (mounted at the
// app root) so it runs even when the panel never mounts — that component is
// load-bearing; removing it would silently stop overrides applying on reload.
// Do not delete (CLAUDE.md).
// =============================================================================

export interface PaletteEntry {
  slug: string
  /** Canonical default, uppercase #RRGGBB. Must match the :root default. */
  hex: string
  /** Where the colour applies — for the human reading the panel. */
  label: string
}

export const PALETTE_REGISTRY: PaletteEntry[] = [
  { slug: 'ink', hex: '#111111', label: 'Primary ink — text, native card bar, slab rules, buttons, light-mode vessel walls' },
  { slug: 'true-black', hex: '#000000', label: 'Dark-mode vessel walls & bar; video letterbox' },
  { slug: 'white', hex: '#FFFFFF', label: 'Page ground, cards, input fields, text on dark' },
  { slug: 'grey-100', hex: '#F2F1ED', label: 'Soft fills — ghost buttons, inactive pills, paywall panel (warmed to agree with bone)' },
  { slug: 'grey-200', hex: '#E7E5DF', label: 'Hover fills, input edges (warmed to agree with bone)' },
  { slug: 'grey-300', hex: '#B9B7AF', label: 'External card bar, disabled states, blockquote rule' },
  { slug: 'grey-400', hex: '#999999', label: 'Placeholders, muted text links, section-label text' },
  { slug: 'grey-600', hex: '#666666', label: 'Secondary text on light & glasshouse surfaces' },
  { slug: 'nav-grey', hex: '#333333', label: 'UNUSED since the black topbar was deleted (2026-07-25) — it drew that dropdown\'s 4px rules. Kept: removing it would renumber every slug after it, and position in this list is canonical' },
  { slug: 'crimson', hex: '#B5242A', label: 'Accent — paid bar, selection, votes, errors, focus rings' },
  { slug: 'crimson-dark', hex: '#921D22', label: 'Crimson dark step (token crimson-dark)' },
  { slug: 'crimson-deep', hex: '#8B1B1F', label: 'Danger text-link hover' },
  { slug: 'crimson-soft', hex: '#D9555A', label: 'Dark-mode crimson (vessel palette)' },
  { slug: 'vouch-red', hex: '#C41230', label: 'Vouch modal error text' },
  { slug: 'danger-red', hex: '#DC2626', label: 'Destructive action buttons (danger zone)' },
  { slug: 'glasshouse', hex: '#FFFFFF', label: 'Frosted overlay pane interior — lightest, outermost (lifted)' },
  { slug: 'glasshouse-well', hex: '#F5F4F0', label: 'Field / well inset on the overlay pane (a touch below the pane). Same value as `cream` — kept as a distinct slug for semantics.' },
  { slug: 'bone', hex: '#F0EFEB', label: 'Workspace floor & light interior; dark-mode card titles' },
  { slug: 'bone-bright', hex: '#E6E5E0', label: 'Vessel-bar text; pip-panel rules' },
  { slug: 'stone-300', hex: '#B4B2A9', label: 'Dark-mode card standfirst' },
  { slug: 'stone-350', hex: '#9C9A94', label: 'Dark-mode vessel name labels' },
  { slug: 'stone-400', hex: '#8A8880', label: 'Muted meta — card metadata, bar muted text (both modes)' },
  { slug: 'stone-600', hex: '#5F5E5A', label: 'Light-mode standfirst, name labels, resize handles' },
  { slug: 'trust-grey', hex: '#B0B0AB', label: 'Trust pip — unknown / thin' },
  { slug: 'ink-925', hex: '#1A1A18', label: 'Dark interior & ground, panel frames, forall button' },
  { slug: 'ink-900', hex: '#232320', label: 'Dark-mode card surface' },
  { slug: 'ink-850', hex: '#2A2A27', label: 'Vessel-bar inputs, dark dropdown hover' },
  { slug: 'ink-grey', hex: '#6A6A66', label: 'Vessel-bar input placeholder' },
  { slug: 'wall-grey', hex: '#4A4A47', label: 'Forall ceremony wall' },
  { slug: 'trust-green', hex: '#1D9E75', label: 'Trust pip — known / strong' },
  { slug: 'trust-amber', hex: '#EF9F27', label: 'Trust pip — partial / moderate' },
  { slug: 'klein-blue', hex: '#002FA7', label: 'Traffology provenance accent (IKB)' },
  { slug: 'cream', hex: '#F5F4F0', label: 'Forall ceremony card' },
  { slug: 'cream-hover', hex: '#FAFAF7', label: 'Playscript reply hover tint' },
  { slug: 'off-white', hex: '#FAFAFA', label: 'Provenance bar ground' },
  { slug: 'blush', hex: '#F5D5D6', label: 'Profile avatar gradient start' },
  { slug: 'blush-deep', hex: '#E8A5A7', label: 'Profile avatar gradient end' },
  // --- Per-feed colour-scheme surfaces (feature-debt §3) -------------------
  // Each curated colourway (Spring/Summer/Autumn/Winter) carries BOTH a light
  // and a dark surface set: the colourway is the character (hue / seasonal
  // energy), the global light/dark toggle picks which variant renders. Three
  // surfaces each (walls double as the bar); every text colour is DERIVED from
  // them by luminance in components/workspace/tokens.ts — tune surfaces here/in
  // the devtool and the text family follows. Keep each card surface clearly
  // light or clearly dark: mid-luminance cards defeat both tuned text ramps.
  // (Naming: the *original* slug is the variant authored first — Spring/Summer/
  // Autumn light, Winter dark — and the opposite variant carries a `-dk`/`-lt`
  // suffix. Existing slugs keep their names so registry order / devtool stay
  // stable; the asymmetry is cosmetic.)
  //
  // DARK-MODE DESIGN (coherence-first, Claude-Code-inspired): because a
  // workspace shows several feeds at once, the dark variants must cohere as a
  // SET, not just each on its own. So the dark interiors+cards are a SHARED dark
  // neutral, only faintly hue-tinted (all ~0.11 / ~0.16 luminance), and each
  // season's identity is carried entirely by the WALLS/BAR spine — four clean
  // chromatic hues (green / azure / ember / indigo-violet) tuned to matched
  // luminance (~0.38) and saturation so they read as one accent family on a
  // unified dark ground (like syntax accents in a dark editor). The earlier
  // "two shades of the hue + a contrasting accent interior" dark grammar is
  // superseded — those contrasting grounds (rose/coral/teal/violet) fought each
  // other across side-by-side feeds. Light variants are unchanged.
  { slug: 'spring-walls', hex: '#2F7D4A', label: 'Feed scheme Spring (light) — walls & bar (fresh green)' },
  { slug: 'spring-interior', hex: '#DCEBCF', label: 'Feed scheme Spring (light) — interior (tinted green ground)' },
  { slug: 'spring-card', hex: '#F4F8EC', label: 'Feed scheme Spring (light) — card surface' },
  { slug: 'spring-walls-dk', hex: '#2C8350', label: 'Feed scheme Spring (dark) — walls & bar (clean green spine; the seasonal identity)' },
  { slug: 'spring-interior-dk', hex: '#18211B', label: 'Feed scheme Spring (dark) — interior (shared dark ground, faint green tint — coheres with the other seasons)' },
  { slug: 'spring-card-dk', hex: '#222E26', label: 'Feed scheme Spring (dark) — card surface (lifted dark neutral, faint green tint)' },
  { slug: 'summer-walls', hex: '#0E5DB0', label: 'Feed scheme Summer (light) — walls & bar (intense blue)' },
  { slug: 'summer-interior', hex: '#F2D89E', label: 'Feed scheme Summer (light) — interior (warm sand ground)' },
  { slug: 'summer-card', hex: '#FCF3DD', label: 'Feed scheme Summer (light) — card surface' },
  { slug: 'summer-walls-dk', hex: '#2B6FA8', label: 'Feed scheme Summer (dark) — walls & bar (clean azure spine; the seasonal identity)' },
  { slug: 'summer-interior-dk', hex: '#161E26', label: 'Feed scheme Summer (dark) — interior (shared dark ground, faint blue tint — coheres with the other seasons)' },
  { slug: 'summer-card-dk', hex: '#1E2A38', label: 'Feed scheme Summer (dark) — card surface (lifted dark neutral, faint blue tint)' },
  { slug: 'autumn-walls', hex: '#B5461E', label: 'Feed scheme Autumn (light) — walls & bar (bold ember)' },
  { slug: 'autumn-interior', hex: '#E9C9B4', label: 'Feed scheme Autumn (light) — interior (clay ground)' },
  { slug: 'autumn-card', hex: '#FBEFE3', label: 'Feed scheme Autumn (light) — card surface' },
  { slug: 'autumn-walls-dk', hex: '#B0492A', label: 'Feed scheme Autumn (dark) — walls & bar (clean ember/terracotta spine; the seasonal identity)' },
  { slug: 'autumn-interior-dk', hex: '#211A16', label: 'Feed scheme Autumn (dark) — interior (shared dark ground, faint warm tint — coheres with the other seasons)' },
  { slug: 'autumn-card-dk', hex: '#322620', label: 'Feed scheme Autumn (dark) — card surface (lifted dark neutral, faint warm tint)' },
  { slug: 'winter-walls', hex: '#6A4FBC', label: 'Feed scheme Winter (dark) — walls & bar (clean indigo-violet spine; the seasonal identity)' },
  { slug: 'winter-interior', hex: '#1C1A24', label: 'Feed scheme Winter (dark) — interior (shared dark ground, faint violet tint — coheres with the other seasons)' },
  { slug: 'winter-card', hex: '#28253A', label: 'Feed scheme Winter (dark) — card surface (lifted dark neutral, faint violet tint)' },
  { slug: 'winter-walls-lt', hex: '#2B3756', label: 'Feed scheme Winter (light) — walls & bar (deep slate indigo frame)' },
  { slug: 'winter-interior-lt', hex: '#D8DDEA', label: 'Feed scheme Winter (light) — interior (cool blue-grey ground)' },
  { slug: 'winter-card-lt', hex: '#EFF2F8', label: 'Feed scheme Winter (light) — card surface (clean cool white)' },
  // Appended, not inserted next to `crimson`: position in this list is
  // canonical (see the header — "colour 07" must keep meaning the same thing),
  // so a new slug goes on the end.
  { slug: 'on-crimson', hex: '#FFFFFF', label: 'Text/icon ON a crimson ground (.btn-accent, ::selection). NEVER inverts — crimson holds in dark, so its foreground must too' },
  // The DARK-mode well on an un-islanded vessel bar (the profile pane's tier 1 —
  // PROFILE-PANE-REDESIGN-ADR §4.1). `barBg` is `ink`, a DARK_SLUG, so under
  // html.dark the bar inverts to a LIGHT slab; but `barInputBg`'s ink-850 is in
  // the never-inverted set, so the `+` well and the secondary button fills would
  // stay near-black under a near-black `bone-bright` glyph (≈1.07:1). There is
  // no existing never-inverting LIGHT slug to borrow (the neutral lights all
  // invert; the never-inverting set is dark + stone + seasonal), so this is one:
  // a light well one step darker than the inverted bar ground. NEVER inverts —
  // it only ever renders in dark mode.
  { slug: 'bar-well-dk', hex: '#D9D7D1', label: 'Dark-mode well on an un-islanded vessel bar (profile tier 1: the `+` well, secondary button fills). NEVER inverts — it exists only for the inverted (light) bar' },
]

export const PALETTE_STORAGE_KEY = 'ah:palette-overrides'

export function rgbVarName(slug: string): string {
  return `--ah-${slug}-rgb`
}

/** '#B5242A' → '181 36 42' (the space-separated triple the vars hold). */
export function hexToTriple(hex: string): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** Accepts '#abc', 'abc123', '#ABC123' → '#ABC123'; null if not a hex colour. */
export function normalizeHex(input: string): string | null {
  const m = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(m)) return `#${m.toUpperCase()}`
  if (/^[0-9a-fA-F]{3}$/.test(m))
    return `#${m.split('').map((c) => c + c).join('').toUpperCase()}`
  return null
}

/**
 * Push overrides into the live page: each overridden slug gets its `-rgb`
 * triple set inline on <html> (winning over the :root default); slugs without
 * an override have any inline value removed so they fall back to :root.
 */
export function applyPaletteOverrides(overrides: Record<string, string>): void {
  const root = document.documentElement
  for (const entry of PALETTE_REGISTRY) {
    const hex = overrides[entry.slug]
    if (hex) root.style.setProperty(rgbVarName(entry.slug), hexToTriple(hex))
    else root.style.removeProperty(rgbVarName(entry.slug))
  }
}
