'use client'

import { useState, type ReactNode } from 'react'
import { usePublicPalette, controlLine, SLAB } from './palette'

// =============================================================================
// Public form primitives.
//
// WHAT THEY REPLACE. The retired auth register drew its inputs with
// `1.5px solid var(--ah-grey-200)` — a hairline box, off-palette, and the only  hairline-ok (prose: quotes the rule these primitives exist to retire)
// place in the app where a border under 4px survived. The house has exactly  hairline-ok (prose, same sentence as above)
// three line weights: the 8px wall, the 6px slab (.slab-rule), the 4px slab
// (.slab-rule-4). A field is a card with the 4px slab under it. Nothing is
// boxed: the slab says "write here" the way a ruled line on paper does, and the
// no-single-pixel-lines invariant is honoured rather than skirted.
//
// FOCUS IS THE SLAB GOING CRIMSON. Not a ring, not an outline offset — the
// element already has a line, so the line is what changes. Buttons keep the
// stylesheet's `:focus-visible` outline because they have no slab to move.
//
// 16px MINIMUM FONT SIZE on every input. Below that iOS Safari zooms the
// viewport on focus, which on a fixed-nav-row layout leaves the row stranded
// mid-screen. This is the reason, so do not "tidy" it down to 15.
// =============================================================================

interface TextFieldProps {
  id: string
  label: string
  type?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  autoComplete?: string
}

export function TextField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  required,
  autoComplete,
}: TextFieldProps) {
  const palette = usePublicPalette()
  const [focused, setFocused] = useState(false)

  return (
    <div>
      <label
        htmlFor={id}
        className="label-ui block"
        style={{ color: palette.cardMeta, marginBottom: 8 }}
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="w-full font-mono focus:outline-none"
        style={{
          background: palette.cardBg,
          color: palette.cardTitle,
          fontSize: 16,
          padding: '13px 14px',
          border: 'none',
          borderRadius: 0,
          borderBottom: `${SLAB}px solid ${
            focused ? palette.crimson : controlLine(palette)
          }`,
          transition: 'border-color 0.15s ease',
        }}
      />
    </div>
  )
}

// ─── Checkbox ───────────────────────────────────────────────────────────────
//
// Square by construction (no radius) and painted with `accentColor` so the tick
// takes the vessel's crimson rather than the browser's blue. The whole row is
// the label, so the hit target is the sentence, not the 16px box.

interface CheckboxFieldProps {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  children: ReactNode
}

export function CheckboxField({
  id,
  checked,
  onChange,
  children,
}: CheckboxFieldProps) {
  const palette = usePublicPalette()

  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 cursor-pointer select-none"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] h-4 w-4 shrink-0 cursor-pointer"
        style={{ accentColor: palette.crimson, borderRadius: 0 }}
      />
      <span
        className="font-mono"
        style={{
          fontSize: 15,
          lineHeight: 1.5,
          color: palette.cardStandfirst,
        }}
      >
        {children}
      </span>
    </label>
  )
}

// ─── Button ─────────────────────────────────────────────────────────────────
//
// WHY NOT JUST `.btn`. The stylesheet's `.btn` is ink-on-white and `.btn-accent`
// is crimson-on-white, both hard-coded to the neutral slugs. Under the light
// island a public page's chassis may be BASIC_DARK while those slugs stay
// pinned light, so `.btn` would paint an ink slab on a dark card — legible, but
// muddy, and it stops tracking the vessel. Deriving primary from the palette
// (cardTitle ground, cardBg text) inverts correctly in both modes and is the
// same solid square slab in both.
//
// `.btn-accent` DOES survive, in exactly one place: the waiting-list call to
// action in PublicNavRow, which sits on the un-islanded bone floor where the
// neutral slugs are the right ones. Crimson is the register's single accent —
// if a second accent button appears on a page, that page has two primary
// actions and the page is wrong, not the button.

type ButtonVariant = 'primary' | 'outline'

interface PublicButtonProps {
  children: ReactNode
  type?: 'button' | 'submit'
  variant?: ButtonVariant
  disabled?: boolean
  onClick?: () => void
  full?: boolean
  /** Renders an <a> instead — for OAuth handoffs that must be a real navigation. */
  href?: string
}

export function PublicButton({
  children,
  type = 'button',
  variant = 'primary',
  disabled,
  onClick,
  full,
  href,
}: PublicButtonProps) {
  const palette = usePublicPalette()

  const style =
    variant === 'primary'
      ? {
          background: palette.cardTitle,
          color: palette.cardBg,
          border: 'none',
        }
      : {
          background: palette.cardBg,
          color: palette.cardTitle,
          border: `${SLAB}px solid ${controlLine(palette)}`,
        }

  const common = {
    ...style,
    width: full ? '100%' : undefined,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: variant === 'primary' ? '14px 32px' : '11px 28px',
    borderRadius: 0,
    fontFamily: "'Jost', system-ui, sans-serif",
    fontSize: '0.9375rem',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'opacity 0.15s ease',
  } as const

  if (href) {
    return (
      <a href={href} style={common} className="hover:opacity-85">
        {children}
      </a>
    )
  }

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={common}
      className="hover:opacity-85"
    >
      {children}
    </button>
  )
}

// ─── Inline text link ───────────────────────────────────────────────────────
//
// The retired register underlined these at `underline-offset-4`. Kept — an
// underline is not a rule, the invariant does not reach it, and a bare colour
// change is a weak affordance in a mono paragraph.

export function PublicLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  const palette = usePublicPalette()

  return (
    <a
      href={href}
      className="underline underline-offset-4 hover:opacity-70 transition-opacity"
      style={{ color: palette.cardTitle }}
    >
      {children}
    </a>
  )
}

// ─── Error notice ───────────────────────────────────────────────────────────
//
// A card with a 6px crimson slab down its left edge — the `.slab-rule-crimson`
// weight turned on its side. The retired register rendered errors as a white
// box on a white page, which was invisible.

export function FormError({ children }: { children: ReactNode }) {
  const palette = usePublicPalette()

  return (
    <div
      role="alert"
      style={{
        background: palette.cardBg,
        borderLeft: `6px solid ${palette.crimson}`,
        padding: '14px 16px',
      }}
    >
      <span
        className="font-mono"
        style={{ fontSize: 15, lineHeight: 1.5, color: palette.cardTitle }}
      >
        {children}
      </span>
    </div>
  )
}

// ─── "or" divider ───────────────────────────────────────────────────────────
//
// The retired version was a full-width `.rule` with a white-backed "or" knocked
// out of the middle — which only worked because the page ground was white. Here
// the ground is the vessel interior, so the word simply sits on it, centred,
// between two 4px slabs that stop short of it.

export function OrDivider() {
  const palette = usePublicPalette()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{ flex: 1, height: SLAB, background: controlLine(palette) }}
      />
      <span className="label-ui" style={{ color: palette.cardMeta }}>
        or
      </span>
      <div
        style={{ flex: 1, height: SLAB, background: controlLine(palette) }}
      />
    </div>
  )
}

// ─── Indeterminate slab ─────────────────────────────────────────────────────
//
// The register's only progress indicator, and the only animation in it. The
// house has no spinner and does not want one: a spinning ring is a radius, an
// animation and a borrowed idiom all at once. This is the 4px slab weight
// moving across the field it already occupies.
//
// USE IT FOR WAITING ON THE NETWORK, NOT FOR SKELETONS. The retired pages drew
// `animate-pulse rounded` grey bars roughly the shape of the content that was
// coming — which is a guess about a layout, rendered at the one moment you
// can't know it, and it shipped a border-radius into a house that has none. A
// slab says "waiting" without pretending to know what arrives.
//
// Wrap it in a PublicCard with `padding: 0` — the slab wants the card's full
// width, and the sweep needs the overflow clip.
export function IndeterminateSlab({ label = 'Loading' }: { label?: string }) {
  const palette = usePublicPalette()

  return (
    <div
      role="progressbar"
      aria-label={label}
      style={{
        height: SLAB,
        background: controlLine(palette),
        overflow: 'hidden',
      }}
    >
      <div
        className="ah-indeterminate-slab"
        style={{ height: SLAB, background: palette.crimson }}
      />
    </div>
  )
}
