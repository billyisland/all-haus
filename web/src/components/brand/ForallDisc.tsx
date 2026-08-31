'use client'

import { useId } from 'react'
import { useResolvedDark } from '../../stores/colorScheme'

// =============================================================================
// ForallDisc — the disc-form ∀ on its own (no wordmark). The shared mark for
// surfaces that want just the glyph-on-a-disc: the landing lockup (via
// ForallLockup), the showcase placeholders, the closing coda.
//
// GEOMETRY IS THE DISC FORM'S, NOT THE BARE GLYPH'S
// (FORALL-CUT-AND-LOCKUP-ADR §III.1, as resolved 2026-07-22). Both ends pin to
// the rim — feet overshooting so the circle trims them flush through the top,
// apex mitring to a point that kisses the bottom — which forces the ≈16.7°
// splay. Do NOT re-derive it from the bare glyph's canonical ~20.5° stance: that
// splay belongs to a mark with no rim to kiss, and is wrong the moment you put a
// disc behind it. (The bare stance's only implementation, `ForAllMark`, was
// deleted 2026-07-25 when the bare crimson ∀ left the design language — the DISC
// is now the mark's sole rendered form. The bare geometry survives as spec only,
// in docs/adr/LOGO-REFINEMENT-SPEC.md.)
//
// PAINT, NOT PUNCH (§II). The ∀ is drawn in the ground colour over an opaque
// disc rather than masked through it. On a flat known ground the two are
// pixel-identical, and every landing surface it sits on is flat.
//
// The disc inverts under `html.dark` exactly as ForallMenu's does (dark bone
// disc / ink glyph). It reads the mode via useResolvedDark (the DOM class the
// pre-paint script set), not the store's lagging `dark`, so a dark-mode visitor
// never paints the light disc first.
//
// THAT NAMING ONLY WORKS ON A LIGHT ISLAND, so every mount site must be on one:
// `bone` is in DARK_SLUGS and `ink-925` is not, so on a bare inverting ground
// the dark branch paints a dark disc with a near-identical dark glyph. Both
// current mounts are islanded — the landing coda by LandingVessel, the nav-row
// lockup by ForallLockup, which carries the island for exactly this reason (see
// its header for the failure it was added to fix).
//
// The clip id is per-instance (`useId`): a page can hold several discs (lockup +
// coda + placeholders) and a shared literal id would collide.
// =============================================================================

interface ForallDiscProps {
  /** Rendered diameter in px. */
  size?: number
}

export function ForallDisc({ size = 40 }: ForallDiscProps) {
  const dark = useResolvedDark()
  const discBg = dark ? 'var(--ah-bone)' : 'var(--ah-ink-925)'
  const discGlyph = dark ? 'var(--ah-ink-925)' : 'var(--ah-bone)'
  const clipId = useId()

  return (
    // Wrapper clips in the RENDERED coordinate space; the inner clipPath clips in
    // the scaled one. Both are needed — the feet overshoot the top circumference
    // by construction, and either clip alone leaks a sliver at some DPR.
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        display: 'block',
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        background: discBg,
        flexShrink: 0,
      }}
    >
      <svg viewBox="0 0 56 56" width={size} height={size}>
        <defs>
          {/* r=28 is the LITERAL rim, not a hair-inset: under the cut geometry
              the feet meet the rim flush and the apex kisses it, so a 1-unit
              inset would leave the ink slice §III.1 exists to avoid. */}
          <clipPath id={clipId}>
            <circle cx="28" cy="28" r="28" />
          </clipPath>
        </defs>
        <g
          clipPath={`url(#${clipId})`}
          style={{ stroke: discGlyph }}
          strokeWidth={5.06}
          strokeLinecap="butt"
          fill="none"
        >
          {/* One path so the interior apex miter-joins — two lines with butt
              caps would notch. The apex vertex (28, 47.15) puts the mitred outer
              tip at y≈56, a point on the bottom rim. */}
          <path
            d="M14.36 1.61 L28 47.15 L41.64 1.61"
            strokeLinejoin="miter"
            strokeMiterlimit={12}
          />
          {/* Crossbar: upper third, spanning the leg centrelines, ~0.82 of the
              legs' weight. */}
          <line x1="19.96" y1="20.26" x2="36.04" y2="20.26" strokeWidth={4.17} />
        </g>
      </svg>
    </span>
  )
}
