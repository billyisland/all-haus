'use client'

import { useState, type ReactNode } from 'react'
import { usePublicPalette, controlLine, SLAB } from './palette'
import { DOB_LABEL, DOB_DAY, DOB_MONTH, DOB_YEAR, DOB_HINT } from '../../content/auth'

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
  /** A fixed width in px; without it the field fills its row. */
  width?: number
  maxLength?: number
  /**
   * Digits only: `text` + `inputMode="numeric"`, never `type="number"` — a
   * spinner on a year is nonsense, and a number field silently changes its
   * value on a stray scroll wheel over a focused box. Non-digits are dropped
   * as they are typed.
   */
  numeric?: boolean
  describedBy?: string
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
  width,
  maxLength,
  numeric,
  describedBy,
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
        type={numeric ? 'text' : type}
        inputMode={numeric ? 'numeric' : undefined}
        value={value}
        required={required}
        autoComplete={autoComplete}
        aria-describedby={describedBy}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`${width === undefined ? 'w-full ' : ''}font-mono focus:outline-none`}
        style={{
          width,
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

// ─── Date of birth ──────────────────────────────────────────────────────────
//
// THREE BOXES, BECAUSE A NATIVE DATE PICKER CANNOT BE MADE BRITISH.
//
// `<input type="date">` draws its own value and its own placeholder in the
// order the BROWSER's locale dictates, and nothing in our markup can change
// that. Probed in Chromium against an en-US browser locale: `lang="en-GB"` on
// the input and `lang="en-GB"` on `<html>` are BOTH ignored, and the field
// renders `mm/dd/yyyy`. On a site whose every other date is British that is
// not a cosmetic mismatch — the reader is being asked for the one value they
// cannot check afterwards (it is never shown back to them; see the wire test)
// in an order they have no way to determine. A member who reads 03/05 as
// 3 May declares a birthday two months out and nothing anywhere disagrees.
//
// So for the DATE OF BIRTH the widget goes. Three labelled boxes say which
// number is which in every locale there is, and they are also simply the
// better control for this value: nobody wants to page a calendar back forty
// years, and the browser's own autofill has real tokens for the three parts
// (`bday-day`/`bday-month`/`bday-year`). This is the GOV.UK date-input
// pattern, adopted for the same reason they adopted it.
//
// ELSEWHERE THE WIDGET STAYS. A schedule picker or an expiry is a date next
// Tuesday, where a calendar is the right control and the ambiguity is fixed
// by STATING the chosen value beside it — `formatDateInputEcho` in
// `lib/format.ts`. Two different problems, two different answers; do not
// "unify" them.
//
// IT ASSEMBLES, IT DOES NOT JUDGE. The component emits `YYYY-MM-DD` once all
// three boxes hold something and `''` until then, and that is the whole of
// its cleverness. It does not check the month is under 13, that the day
// exists in it, or that the year is plausible — `shared/src/lib/age.ts` is
// the ONE home for that rule and the route parses with it, so a second copy
// here would be a second rule to keep in step and the half nobody tests.
// A year typed as `78` pads to `0078` and comes back refused with "a day, a
// month and a four-digit year" (the calendar arm, not the plausibility one —
// `age.ts` says why), which is the server's own sentence and is a better thing
// to read than a button that will not light up.
//
// Each box is a `numeric` `TextField` at a fixed width.
//
// The three parts are LOCAL STATE and the assembled value goes out through
// `onChange`; there is no `value` prop, because a parent holding `''` for an
// incomplete date could not say which box was still empty. Nothing resets
// this field today — if something ever needs to, give it a `key`.

interface DateOfBirthFieldProps {
  /** Ids are derived from this — the three boxes and the hint. */
  idPrefix: string
  label?: string
  /** `YYYY-MM-DD` once all three boxes are filled, `''` before that. */
  onChange: (value: string) => void
  required?: boolean
}

export function DateOfBirthField({
  idPrefix,
  label = DOB_LABEL,
  onChange,
  required,
}: DateOfBirthFieldProps) {
  const palette = usePublicPalette()
  const [day, setDay] = useState('')
  const [month, setMonth] = useState('')
  const [year, setYear] = useState('')
  const hintId = `${idPrefix}-hint`

  function emit(d: string, m: string, y: string) {
    onChange(
      d === '' || m === '' || y === ''
        ? ''
        : `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
    )
  }

  return (
    // `minInlineSize: 'auto'` — a fieldset's UA default is `min-content`,
    // which stops the row shrinking on a narrow phone. `border: none` because
    // the UA default is a groove, which the no-single-pixel rule refuses.
    <fieldset
      style={{
        border: 'none',
        padding: 0,
        margin: 0,
        minInlineSize: 'auto',
      }}
    >
      <legend
        className="label-ui"
        style={{ color: palette.cardMeta, marginBottom: 8, padding: 0 }}
      >
        {label}
      </legend>
      <div style={{ display: 'flex', gap: 12 }}>
        <TextField
          id={`${idPrefix}-day`}
          label={DOB_DAY}
          value={day}
          onChange={(v) => {
            setDay(v)
            emit(v, month, year)
          }}
          width={76}
          numeric
          maxLength={2}
          autoComplete="bday-day"
          describedBy={hintId}
          required={required}
        />
        <TextField
          id={`${idPrefix}-month`}
          label={DOB_MONTH}
          value={month}
          onChange={(v) => {
            setMonth(v)
            emit(day, v, year)
          }}
          width={76}
          numeric
          maxLength={2}
          autoComplete="bday-month"
          describedBy={hintId}
          required={required}
        />
        <TextField
          id={`${idPrefix}-year`}
          label={DOB_YEAR}
          value={year}
          onChange={(v) => {
            setYear(v)
            emit(day, month, v)
          }}
          width={104}
          numeric
          maxLength={4}
          autoComplete="bday-year"
          describedBy={hintId}
          required={required}
        />
      </div>
      <p
        id={hintId}
        className="text-mono-xs"
        style={{ color: palette.cardMeta, margin: '10px 0 0' }}
      >
        {DOB_HINT}
      </p>
    </fieldset>
  )
}

// ─── Multi-line field ───────────────────────────────────────────────────────
//
// The same card-with-a-slab construction as `TextField`, for the one public
// surface that asks for a paragraph rather than a value: the appeal (D7 §5).
// A second component rather than a `multiline` prop on the first, because the
// element differs (`textarea`, which takes no `type` and needs a `rows`) and a
// prop that swaps the rendered tag is the shape that accumulates branches.
//
// `resize: vertical` and not `none`: this is somebody arguing that we got a
// decision about them wrong, and a box they cannot make bigger is a small
// discourtesy in exactly the place we can least afford one.

interface TextAreaFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  rows?: number
  maxLength?: number
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  placeholder,
  required,
  rows = 6,
  maxLength,
}: TextAreaFieldProps) {
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
      <textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
        maxLength={maxLength}
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
          resize: 'vertical',
          borderBottom: `${SLAB}px solid ${
            focused ? palette.crimson : controlLine(palette)
          }`,
          transition: 'border-color 0.15s ease',
        }}
      />
    </div>
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
// action in PublicNavBar, which sits on the un-islanded bone floor where the
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
//
// IT TAKES AN `onClick` INSTEAD OF AN `href`, AND THAT IS A SEAM, NOT A SECOND
// COMPONENT. Some inline register actions are acts rather than navigations —
// the age gate's Sign out. The obvious shortcut is `.btn-text`, and it is
// wrong TWICE over on a public surface: it is 13px SANS, so it changes voice
// in the middle of a mono `PublicBody` sentence and reads a size smaller; and
// it is hard-coded to the neutral slugs, which inside a `PublicVessel`'s light
// island renders near-black on a near-black card in dark mode — invisible, and
// invisible only in one mode, which is how it survives being looked at. Both
// were found by rendering the gate (`gate-dark.png`), not by reading it. Same
// family as the `IndeterminateSlab` track warning above.
//
// It inherits its type from the paragraph it sits in, by saying nothing about
// type at all — which is the whole point of putting it here rather than
// rolling one at the call site.

export function PublicLink({
  href,
  onClick,
  children,
}: {
  href?: string
  onClick?: () => void
  children: ReactNode
}) {
  const palette = usePublicPalette()
  const className =
    'underline underline-offset-4 hover:opacity-70 transition-opacity'
  const style = { color: palette.cardTitle }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={className}
        // `font: inherit` and not a size: the point is that it takes the voice
        // of the sentence around it. A `<button>` otherwise resets to the UA's
        // own font and shrinks mid-paragraph.
        style={{ ...style, font: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        {children}
      </button>
    )
  }

  return (
    <a href={href} className={className} style={style}>
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
