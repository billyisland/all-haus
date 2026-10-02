'use client'

import { useState, type RefObject } from 'react'
import { AnchoredPopover } from '../ui/AnchoredPopover'
import { giftLinks } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { copyOrReveal } from '../../hooks/useCopyLink'

// A paywalled author's free unlock of their own piece, raised from the Share
// menu's "Gift link" row. It hangs off the SAME Share control, through the
// house's `AnchoredPopover` (portalled, focus in and back, Escape and an
// outside press dismiss) — it was a hand-rolled `fixed inset-0` scrim with a
// centred box, the construction web-overlays.md retires (walkthrough W5's
// open item, 2026-09-25).
interface GiftLinkPanelProps {
  articleDbId: string
  /** The Share trigger the panel hangs off. */
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

const PANEL_W = 300

export function GiftLinkPanel({ articleDbId, anchorRef, onClose }: GiftLinkPanelProps) {
  const [limit, setLimit] = useState(5)
  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  // idle | copied | failed. Not a boolean: "it did not copy" and "it has not
  // been pressed" are different things to say, and the old code could say
  // neither — it fired `void writeText(url)` and reported nothing at all, so a
  // refused write was indistinguishable from a successful one.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCopy() {
    if (!url) return
    const outcome = await copyOrReveal(url, (t) => navigator.clipboard.writeText(t))
    setCopyState(outcome.ok ? 'copied' : 'failed')
    if (outcome.ok) {
      setTimeout(() => setCopyState((s) => (s === 'copied' ? 'idle' : s)), 2000)
    }
  }

  async function handleCreate() {
    setCreating(true)
    setCreateError(null)
    try {
      const result = await giftLinks.create(articleDbId, limit)
      setUrl(window.location.origin + result.url)
    } catch (err) {
      // Said, not swallowed (walkthrough A16's class): a refused create left
      // the button reading "Generate link" as though it had not been pressed.
      setCreateError(apiErrorMessage(err) ?? "Couldn't create the link — nothing was made. Try again.")
    }
    finally { setCreating(false) }
  }

  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      open
      onDismiss={onClose}
      width={PANEL_W}
      over="paper"
      role="dialog"
      ariaLabel="Create gift link"
      className="p-4"
    >
        {/* The panel's ground is `grey-100` (`over="paper"`), so its wells are
            white and its type is the popover's own — Report's, beside it. */}
        <h3 className="text-ui-sm font-medium text-black mb-1">Create gift link</h3>
        <p className="text-ui-xs text-grey-600 mb-3">A link that opens this piece free, for as many people as you allow.</p>
        {!url ? (
          <>
            <label htmlFor="gift-link-limit" className="block label-ui text-grey-400 mb-1">Redemption limit</label>
            <input
              id="gift-link-limit"
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
              className="w-20 bg-white px-2 py-1 text-ui-xs font-sans text-black mb-3"
            />
            <div>
              <button onClick={() => void handleCreate()} disabled={creating} className="btn btn-sm disabled:opacity-50">
                {creating ? 'Creating…' : 'Generate link'}
              </button>
              {createError && <p className="text-ui-xs text-crimson mt-2">{createError}</p>}
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              readOnly
              value={url}
              aria-label="Gift link"
              className="w-full bg-white px-2.5 py-1.5 text-ui-xs font-mono text-black mb-3"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button onClick={() => void handleCopy()} className="btn btn-sm">
              {copyState === 'copied' ? 'Copied!' : 'Copy link'}
            </button>
            {/* The url is already on screen as this panel's receipt, so the
                reveal the rule asks for is structural here — what was missing
                was ever SAYING the write failed. */}
            {copyState === 'failed' && (
              <p className="text-ui-xs font-sans text-crimson mt-2">
                Couldn&rsquo;t reach the clipboard — select the link above and copy it by hand.
              </p>
            )}
          </>
        )}
    </AnchoredPopover>
  )
}
