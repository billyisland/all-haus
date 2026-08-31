import type { CSSProperties, ReactNode } from 'react'
import type { VesselPalette } from '../../workspace/tokens'

// =============================================================================
// Landing demo primitives — the card grammar, rebuilt as inert markup.
//
// WHY THESE EXIST RATHER THAN REUSING PostCard. PostCard is the ONE card and it
// should stay that way, but it takes a `Post`, resolves a level spec, threads
// interactions, hover cards, resonance, explain tags and eight callbacks. None
// of that means anything to a logged-out visitor and all of it is weight on the
// one page a stranger loads cold. What the landing page needs is the card's
// LOOK — byline, title, body, origin tag, quote embed — with nothing behind it.
// So these are deliberately dumb: props in, markup out, no hooks, no stores, no
// client boundary of their own.
//
// THEY ARE A COPY, AND COPIES DRIFT. If the real card's byline idiom or origin
// tag changes, this will not follow it automatically. That is the accepted cost
// of not dragging the whole post stack onto `/`. The mitigation is that the
// pieces are small enough to re-read against the originals in a minute:
// Byline.tsx (byline row), PostOriginTag.tsx (the VIA line), QuotedEmbed.tsx.
//
// EVERYTHING SIZES IN `em`. Each demo's root sets one `fontSize` in px and every
// measurement below is relative to it, so a demo's whole register — type, pad,
// gaps, rules — moves with one number. Nothing here sets a font-size on an
// element that contains another font-sized element, so the ems never compound.
// =============================================================================

/**
 * The ⊔ a demo feed sits in. Walls come from the palette being demonstrated.
 *
 * TWO MODES, and the distinction matters. Pass `wall` and the vessel draws its
 * own ⊔ inline at that px thickness — what the omnivore demo wants, since it is
 * a fixed-size figure. Pass NO `wall` and the vessel draws nothing: it only
 * publishes its palette's wall colour as `--ah-demo-wall` and leaves border,
 * padding and gap to a stylesheet rule matching `className`.
 *
 * The second mode exists because inline styles beat @layer components. The
 * canvas and reader demos scale their whole geometry in `em` off a container
 * query (globals.css §1d), so their wall thickness has to be CSS — and an
 * inline `borderLeft` here, even a zeroed one, would silently win and flatten
 * the ⊔ to nothing. Hence "declare no borders at all" rather than "declare 0".
 */
export function DemoVessel({
  palette,
  wall,
  gap,
  pad,
  children,
  className,
  style,
}: {
  palette: VesselPalette
  /** Wall thickness in px. OMIT to hand geometry to `className`'s CSS rule. */
  wall?: number
  gap?: number
  pad?: number
  children: ReactNode
  /** For §1d geometry the stylesheet owns (the canvas and reader demos). */
  className?: string
  style?: CSSProperties
}) {
  const ownsGeometry = wall !== undefined

  return (
    <div
      className={className}
      style={
        {
          background: palette.interior,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          // Always published, both modes: §1d's rules read it for the border
          // colour, which CSS cannot derive because the palette resolves in JS.
          '--ah-demo-wall': palette.walls,
          ...(ownsGeometry
            ? {
                borderLeft: `${wall}px solid ${palette.walls}`,
                borderRight: `${wall}px solid ${palette.walls}`,
                borderBottom: `${wall}px solid ${palette.walls}`,
                padding: pad ?? wall,
                gap: gap ?? wall,
              }
            : {}),
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}

/** One card on the vessel floor. */
export function DemoPost({
  palette,
  children,
  padding = '0.85em 1em',
}: {
  palette: VesselPalette
  children: ReactNode
  padding?: string
}) {
  return <div style={{ background: palette.cardBg, padding }}>{children}</div>
}

/**
 * The byline row — pip · name · time. Mirrors workspace/Byline.tsx's treatment
 * (mono, meta-coloured, name in cardTitle at medium weight) without its links,
 * hover modal or relative-time formatting: the times here are strings, because
 * a demo that ages ("6H" becoming "4D" after a week) would just look neglected.
 */
export function DemoByline({
  palette,
  name,
  time,
  paid,
}: {
  palette: VesselPalette
  name: string
  time: string
  /** Crimson pip — the demo's one hint that a card can carry a price. */
  paid?: boolean
}) {
  return (
    <div
      className="font-mono"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6em',
        marginBottom: '0.6em',
        color: palette.cardMeta,
        fontSize: '0.75em',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '0.5em',
          height: '0.5em',
          borderRadius: '50%',
          background: paid ? palette.crimson : palette.cardMeta,
          flex: 'none',
        }}
      />
      {/* The name truncates rather than wrapping, as the real byline does. A
          wrapped name in a narrow card drags the middle-dot and the timestamp
          off to the far right of a second line, which reads as a bug. */}
      <span
        style={{
          color: palette.cardTitle,
          fontWeight: 500,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      <span aria-hidden="true" style={{ flex: 'none' }}>
        ·
      </span>
      <span style={{ flex: 'none' }}>{time}</span>
    </div>
  )
}

export function DemoTitle({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{
        fontSize: '1.1em',
        lineHeight: 1.25,
        fontWeight: 600,
        color: palette.cardTitle,
        marginBottom: '0.25em',
      }}
    >
      {children}
    </div>
  )
}

export function DemoBody({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{ fontSize: '1em', lineHeight: 1.5, color: palette.cardStandfirst }}
    >
      {children}
    </div>
  )
}

/**
 * The card's hero image, at the real card's treatment: cropped 16:9, sitting on
 * the vessel interior, square corners, `marginTop`/`marginBottom` in the same
 * 10:6 ratio PostMedia uses for its "sized" mode.
 *
 * IT IS DRAWN, NOT PHOTOGRAPHED, AND THAT IS THE POINT. Everything on this page
 * is invented — see the note in CanvasDemo — and a photograph is the one thing
 * that cannot be. A stock landscape is a real place, owned by someone, dropped
 * onto a page that is selling something; the objection is the same one that took
 * the real bylines out. What the card actually has to prove is only that
 * pictures ride inside the grammar, and at the size this renders (~160 x 90 CSS
 * px) a photograph is read as tone, mass and light, not as detail. So this is
 * that: a hazy skyline in five tonal steps, which at card size is indistinguish-
 * able in KIND from a photograph while being wholly ours.
 *
 * EVERY TONE IS A CANONICAL NEUTRAL — grey-200 → grey-300 → stone-400 →
 * wall-grey → ink-925, a warm-grey ramp that already exists in the registry, so
 * the picture needs no raw hex and no new slug. Warm greys also read as a
 * toned monochrome print rather than as a diagram. The landing vessel carries
 * `LIGHT_ISLAND_STYLE`, so those slugs resolve canonical in both modes and the
 * picture does not invert under the dark toggle — which is correct: a feed's
 * SURFACE follows the mode, a photograph in it never does.
 *
 * `preserveAspectRatio="none"` is safe here and only here: the scene is bands
 * and blocks with nothing whose proportion carries meaning, and the alternative
 * (letterboxing, or a crop that hides the horizon) would be worse.
 */
export function DemoPhoto({ palette }: { palette: VesselPalette }) {
  // A city at dusk, in four planes receding into haze. FOUR THINGS DO THE WORK,
  // and the first draft had none of them, which is why it read as a bar chart:
  //   · every mass carries its own vertical gradient, so nothing is a flat fill;
  //   · the far planes are BLURRED and low-contrast — atmospheric perspective is
  //     the strongest single cue that a picture has depth and was not drawn;
  //   · a low glow sits behind the skyline, so the masses are backlit rather
  //     than laid on top of a background;
  //   · grain over the whole frame, which is what a small photograph is mostly
  //     made of once its detail has gone.
  // Roof heights and widths are irregular for the same reason.
  const far =
    'M0 54 h11 v-6 h6 v6 h9 v-3 h13 v3 h7 v-11 h4 v11 h16 v-5 h9 v5 h12 v-8 h5 v8 h19 v-4 h7 v4 h12 v-6 h5 v6 h25 V90 H0 Z'
  const mid =
    'M0 63 h17 v-9 h9 v9 h13 v-4 h8 v4 h6 v-15 h5 v15 h11 v-7 h12 v7 h14 v-11 h6 v11 h10 v-5 h11 v5 h18 V90 H0 Z'
  const near =
    'M0 72 h22 v-8 h14 v8 h9 v-5 h20 v5 h7 v-13 h6 v13 h17 v-6 h11 v6 h13 v-9 h8 v9 h33 V90 H0 Z'

  return (
    <div
      style={{
        marginTop: '0.7em',
        marginBottom: '0.42em',
        background: palette.interior,
        overflow: 'hidden',
        aspectRatio: '16 / 9',
      }}
    >
      <svg
        viewBox="0 0 160 90"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ width: '100%', height: '100%', display: 'block' }}
      >
        <defs>
          <linearGradient id="ah-demo-photo-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ah-stone-600)' }} />
            <stop offset="0.34" style={{ stopColor: 'var(--ah-stone-400)' }} />
            <stop offset="0.68" style={{ stopColor: 'var(--ah-grey-300)' }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-grey-200)' }} />
          </linearGradient>
          {/* The low sun. Off-centre, and sitting BEHIND the skyline, so the
              masses are backlit — the difference between a photograph and a
              diagram of one. */}
          <radialGradient id="ah-demo-photo-sun" cx="0.63" cy="0.72" r="0.46">
            <stop offset="0" style={{ stopColor: 'var(--ah-grey-200)', stopOpacity: 0.92 }} />
            <stop offset="0.55" style={{ stopColor: 'var(--ah-grey-200)', stopOpacity: 0.34 }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-grey-200)', stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient id="ah-demo-photo-far" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ah-stone-400)', stopOpacity: 0.5 }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-stone-400)', stopOpacity: 0.16 }} />
          </linearGradient>
          <linearGradient id="ah-demo-photo-mid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ah-wall-grey)', stopOpacity: 0.82 }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-wall-grey)', stopOpacity: 0.42 }} />
          </linearGradient>
          {/* The near plane starts a step lighter than it ends, so its roofline
              separates from the dark base instead of fusing with it into one
              rectangular-toothed silhouette — which is the shape that made the
              first draft read as a chart. */}
          <linearGradient id="ah-demo-photo-near" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ah-stone-600)' }} />
            <stop offset="0.3" style={{ stopColor: 'var(--ah-wall-grey)' }} />
            <stop offset="0.72" style={{ stopColor: 'var(--ah-ink-925)' }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-ink-925)' }} />
          </linearGradient>
          <radialGradient id="ah-demo-photo-vig" cx="0.5" cy="0.44" r="0.8">
            <stop offset="0.5" style={{ stopColor: 'var(--ah-ink-925)', stopOpacity: 0 }} />
            <stop offset="1" style={{ stopColor: 'var(--ah-ink-925)', stopOpacity: 0.3 }} />
          </radialGradient>

          {/* Haze. Distance = blur + lost contrast; the near plane keeps its
              edge, so the eye reads the three as three depths. */}
          <filter id="ah-demo-photo-haze" x="-10%" y="-10%" width="120%" height="130%">
            <feGaussianBlur stdDeviation="1.15" />
          </filter>
          <filter id="ah-demo-photo-soft" x="-10%" y="-10%" width="120%" height="130%">
            <feGaussianBlur stdDeviation="0.5" />
          </filter>
          {/* Grain. A small photograph is largely this once its detail is gone. */}
          <filter id="ah-demo-photo-grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        </defs>

        <rect width="160" height="90" fill="url(#ah-demo-photo-sky)" />
        <rect width="160" height="90" fill="url(#ah-demo-photo-sun)" />
        <path d={far} fill="url(#ah-demo-photo-far)" filter="url(#ah-demo-photo-haze)" />
        <path d={mid} fill="url(#ah-demo-photo-mid)" filter="url(#ah-demo-photo-soft)" />
        <path d={near} fill="url(#ah-demo-photo-near)" />
        <rect width="160" height="90" fill="url(#ah-demo-photo-vig)" />
        <rect
          width="160"
          height="90"
          filter="url(#ah-demo-photo-grain)"
          style={{ opacity: 0.16, mixBlendMode: 'overlay' }}
        />
      </svg>
    </div>
  )
}

/**
 * The provenance line. The whole omnivore argument is carried by these four
 * words, so this is the one thing in the demos that must stay crisp — it is why
 * the shots were replaced. Rendered as plain text, not a button: there is
 * nowhere for a demo to link to.
 */
export function DemoTag({
  palette,
  children,
}: {
  palette: VesselPalette
  children: ReactNode
}) {
  return (
    <div
      className="font-mono"
      style={{
        fontSize: '0.7em',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: palette.cardMeta,
        marginTop: '0.7em',
      }}
    >
      {children}
    </div>
  )
}

/** Quoted-post embed. Sits on the WALLS colour, exactly as the real one does. */
export function DemoQuote({
  palette,
  source,
  children,
}: {
  palette: VesselPalette
  source: string
  children: ReactNode
}) {
  return (
    <div
      className="font-serif"
      style={{
        background: palette.quoteBg,
        color: palette.quoteText,
        padding: '0.7em 0.85em',
        marginTop: '0.6em',
        fontSize: '0.93em',
        lineHeight: 1.45,
      }}
    >
      <span
        className="font-mono"
        style={{
          display: 'block',
          color: palette.quoteMeta,
          fontSize: '0.68em',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: '0.6em',
        }}
      >
        {source}
      </span>
      {children}
    </div>
  )
}
