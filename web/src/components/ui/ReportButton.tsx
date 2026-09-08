'use client'

import { useRef, useState } from 'react'
import { useAuth } from '../../stores/auth'
import { AnchoredPopover } from './AnchoredPopover'

// =============================================================================
// ReportButton — twinned with ShareButton on the reader's action row, and read
// that file's header first: the two had drifted apart in every respect and this
// is the other half of bringing them back together (2026-09-04).
//
// WHAT WAS WRONG HERE SPECIFICALLY, beyond the trigger grey:
//   - It DID NOT DISMISS ON AN OUTSIDE CLICK, and Share did. Pressing away from
//     it left a 320px panel standing over the article with only its own Cancel
//     to close it — the one thing every reader tries first did nothing.
//   - Its panel drew a single-pixel grey outline, which the sitewide no-thin-
//     line invariant forbids outright. Separation here is the lift, as it is on
//     every other floating surface in the house.
//   - Its ground was `bg-white`, which in dark resolves to the SAME value as
//     the reading surface behind it, so the panel had no edge whatever. Both
//     panels now take the popover's `over="paper"` ground — `grey-100`, which
//     is the one token that reads as a panel in both modes (see that prop).
//   - Submitting REPLACED THE TRIGGER with a bare line of text, permanently.
//     The affordance the reader had just used vanished from the row and the
//     confirmation sat where a button had been. The confirmation now lives in
//     the panel, like every other thing this panel says, and dismisses the same
//     way as everything else.
//
// TWO TYPE REGISTERS, ONE COMPONENT. It is mounted on the reader's action row
// (13px sans) and inside a playscript reply's action row (11px mono caps, whose
// Reply/Delete siblings simply inherit the row and add a hover). So the trigger
// class is the caller's seam: it defaults to `.btn-text-muted` — the house's
// secondary text-link action, which is what the reader row wants and what Share
// wears — and the playscript row passes its own, exactly as its siblings do.
// The alternative was a second copy of this panel.
// =============================================================================

interface ReportButtonProps {
  targetNostrEventId?: string
  targetAccountId?: string
  /** Overrides the trigger's type/colour where the host row sets its own
   *  register. Omit on any surface without one. */
  triggerClassName?: string
}

const CATEGORIES = [
  { value: 'illegal_content', label: 'Illegal content' },
  { value: 'harassment', label: 'Targeted harassment or non-consensual intimate imagery' },
  { value: 'spam', label: 'Spam or inauthentic behaviour' },
  { value: 'other', label: 'Other' },
] as const

const PANEL_W = 320

export function ReportButton({
  targetNostrEventId,
  targetAccountId,
  triggerClassName = 'btn-text-muted',
}: ReportButtonProps) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!user) return null

  async function handleSubmit() {
    if (!category) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/v1/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetNostrEventId,
          targetAccountId,
          category,
          notes: notes.trim() || undefined,
        }),
      })

      if (!res.ok) throw new Error('Report submission failed')

      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={submitted ? 'Report submitted' : 'Report this content'}
      >
        {submitted ? 'Reported' : 'Report'}
      </button>

      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onDismiss={() => setOpen(false)}
        width={PANEL_W}
        over="paper"
        role="dialog"
        ariaLabel="Report content"
        className="p-4"
      >
        {submitted ? (
          // The receipt lives IN the panel and closes like everything else, so
          // the row keeps the control the reader just used. It stays readable
          // on a re-open — a reader who wants to know whether it went through
          // should be able to look.
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            Report submitted. We&rsquo;ll review it within 48 hours.
          </p>
        ) : (
          <>
            <h3 className="text-ui-sm font-medium text-black mb-3">Report content</h3>

            <div className="space-y-2 mb-3">
              {CATEGORIES.map((cat) => (
                <label key={cat.value} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="report-category"
                    value={cat.value}
                    checked={category === cat.value}
                    onChange={(e) => setCategory(e.target.value)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span className="text-ui-xs text-grey-600 leading-tight">{cat.label}</span>
                </label>
              ))}
            </div>

            {/* White, because the PANEL is now `grey-100` (see `over="paper"`
                on the popover): a field sits on the ladder's cards/fields rung
                and the panel below it, which is the paywall panel's own model.
                `bg-grey-100` here would vanish into the panel. */}
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Additional details (optional)"
              rows={2}
              maxLength={2000}
              className="w-full bg-white px-2.5 py-1.5 text-ui-xs mb-3"
            />

            {error && (
              <p className="text-ui-xs text-crimson mb-2">{error}</p>
            )}

            <div className="flex items-center gap-4">
              <button
                onClick={handleSubmit}
                disabled={!category || submitting}
                className="btn-accent btn-sm disabled:opacity-50"
              >
                {submitting ? 'Submitting…' : 'Submit report'}
              </button>
              {/* Cancel stays as a labelled action — this is a paired action
                  dialog, the one case the floating-✕ rule exempts — but it is
                  no longer the ONLY way out. */}
              <button onClick={() => setOpen(false)} className="btn-text-muted">
                Cancel
              </button>
            </div>

            {/* A footnote below every type token in the ramp; a rem escape
                hatch so it still scales with the global type size (an
                arbitrary px value would not). */}
            <p className="mt-3 text-[0.6875rem] text-grey-600 leading-snug">
              Reports are reviewed by a human within 48 hours. Submitting a report does not automatically remove content.
            </p>
          </>
        )}
      </AnchoredPopover>
    </>
  )
}
