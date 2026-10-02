'use client'

import { useRef, useState } from 'react'
import { useAuth } from '../../stores/auth'
import { AnchoredPopover } from './AnchoredPopover'
import { request, failureSentence } from '../../lib/api/client'
import { REPORT_CATEGORIES, type ReportPriority } from '../../lib/api/admin'
import {
  REPORT_CATEGORY_LABEL,
  REPORT_TITLE,
  REPORT_NOTES_PLACEHOLDER,
  REPORT_SUBMIT,
  REPORT_FAILED,
  REPORT_FOOTNOTE,
  reportReceipt,
} from '../../content/report'

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
// (13px sans), inside a playscript reply's action row (11px mono caps), on
// every workspace card, on a DM thread header and on a profile pane. So the
// trigger class is the caller's seam: it defaults to `.btn-text-muted` — the
// house's secondary text-link action, which is what the reader row wants and
// what Share wears — and the rows with their own register pass their own,
// exactly as their siblings do. The alternative was five copies of this panel.
//
// ── WHAT L6.3 CHANGED, AND WHY EACH HALF MATTERED ────────────────────────────
//
// ANYTHING CAN BE REPORTED, because until now almost nothing could. This panel
// existed on an article page and on a playscript reply and nowhere else: not on
// a workspace card, not on an external item (of which the workspace is mostly
// made), not on a DM, not on a profile. D1 §9.2 says reporting covers all
// content — "native, DM, and ingested" — so the control follows the content,
// and the five target props below are the five things this site shows.
// `targetPostId` is the one that unlocks the workspace: `feed_items.post_id`
// is the one identity spanning native and external items, so a card can report
// itself whatever it is made of.
//
// TWELVE CATEGORIES, because four could not carry the triage table. D7 §2 gives
// CSAM and terrorism 24 hours and everything else illegal 72 — a distinction a
// reporter could not make when the only illegal option was "illegal content".
// The list is D1 §9.2's priority offences, gravest first, and it is imported
// from `lib/api/admin` rather than retyped here, so there is one copy in this
// workspace and a test holds it against the gateway's. The words — labels,
// deadlines, receipt — live in `content/report.ts`, shared with modernhaus.
//
// THE PANEL NO LONGER PROMISES 48 HOURS, because we never promised 48 hours:
// the published figures are 24h, 72h and 7 days depending on what was reported.
// So the receipt reads the deadline off the RESPONSE — the gateway derives the
// priority from the category and sends the date back — rather than printing a
// constant that was true of nothing.
// =============================================================================

interface ReportButtonProps {
  /** Native content, by its Nostr event id — never an external card's
   *  `version`, which is a content hash and not an event (§0z item 6). */
  targetNostrEventId?: string
  /** An account, as the subject of a complaint. */
  targetAccountId?: string
  /** Any post the workspace can show — `feed_items.post_id`, external included. */
  targetPostId?: string
  /** A DM thread. The reporter must be in it; the gateway checks. */
  targetConversationId?: string
  /** A profile, as distinct from the account's content. */
  targetProfileId?: string
  /** Overrides the trigger's type/colour where the host row sets its own
   *  register. Omit on any surface without one. */
  triggerClassName?: string
  /** The trigger's word. A card's action row says "Report"; a DM header and a
   *  profile bar say what they are reporting, because there the object is not
   *  the thing the row is about. */
  label?: string
}

const PANEL_W = 320

interface Receipt {
  priority: ReportPriority
  triageDeadline: string
}

export function ReportButton({
  targetNostrEventId,
  targetAccountId,
  targetPostId,
  targetConversationId,
  targetProfileId,
  triggerClassName = 'btn-text-muted',
  label = 'Report',
}: ReportButtonProps) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  if (!user) return null

  async function handleSubmit() {
    if (!category) return
    setSubmitting(true)
    setError(null)

    try {
      const body = await request<Receipt | null>('/reports', {
        method: 'POST',
        body: JSON.stringify({
          targetNostrEventId,
          targetAccountId,
          targetPostId,
          targetConversationId,
          targetProfileId,
          category,
          notes: notes.trim() || undefined,
        }),
      })

      // The deadline is the SERVER's — it derives the priority from the
      // category and owns the figure. A copy computed here would be a second
      // spelling of a published commitment.
      setReceipt(
        body?.priority && body?.triageDeadline
          ? body
          : { priority: 'P1', triageDeadline: '' }
      )
    } catch (err) {
      setError(failureSentence(err, REPORT_FAILED))
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
        aria-label={receipt ? 'Report submitted' : 'Report this content'}
      >
        {receipt ? 'Reported' : label}
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
        {receipt ? (
          // The receipt lives IN the panel and closes like everything else, so
          // the row keeps the control the reader just used. It stays readable
          // on a re-open — a reader who wants to know whether it went through
          // should be able to look.
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            {reportReceipt(receipt.priority)}
          </p>
        ) : (
          <>
            <h3 className="text-ui-sm font-medium text-black mb-3">{REPORT_TITLE}</h3>

            {/* Twelve options where there were four, so the list scrolls
                rather than growing the panel past the screen on a phone. The
                scroll marker is opted into, because this IS a list somebody
                reads down (the sitewide silent-scrollbar rule's exception). */}
            <div className="ah-scrollbar max-h-[14rem] overflow-y-auto space-y-2 mb-3">
              {REPORT_CATEGORIES.map((cat) => (
                <label key={cat} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="report-category"
                    value={cat}
                    checked={category === cat}
                    onChange={(e) => setCategory(e.target.value)}
                    className="mt-0.5 h-3.5 w-3.5"
                  />
                  <span className="text-ui-xs text-grey-600 leading-tight">
                    {REPORT_CATEGORY_LABEL[cat]}
                  </span>
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
              placeholder={REPORT_NOTES_PLACEHOLDER}
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
                {submitting ? 'Submitting…' : REPORT_SUBMIT}
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
              {REPORT_FOOTNOTE}
            </p>
          </>
        )}
      </AnchoredPopover>
    </>
  )
}
