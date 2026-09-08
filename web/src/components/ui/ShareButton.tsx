'use client'

import { useRef, useState } from 'react'
import { copyOrReveal } from '../../hooks/useCopyLink'
import { AnchoredPopover } from './AnchoredPopover'

// =============================================================================
// ShareButton — the reader action row's left affordance, twinned with
// ReportButton beside it.
//
// THE TWO WERE BUILT SEPARATELY AND HAD DRIFTED IN EVERY RESPECT (2026-09-04):
// different trigger greys and type sizes, different panel surfaces, different
// lifts, and different ideas of how a menu closes — this one dismissed on an
// outside click and Report did not, so pressing away from Report left it
// hanging with nothing to say why. They now share one trigger class, one
// popover primitive, and therefore one dismissal.
//
// THE PANEL PORTALS, and inside the reader that is required rather than tidy:
// the reading pane is a Glasshouse (`overflow-hidden`, plus its own scroll
// region), so an `absolute` panel is clipped by two ancestors and painted over
// by the ⊓ frame at z-5 whatever its own z-index. `AnchoredPopover` is the one
// home for that, and it owns the outside-pointerdown and the Escape shield —
// which is what stops Escape closing the reader underneath as well.
//
// `over="paper"`: this floats over the READING SURFACE, where `--ah-white` and
// `--ah-glasshouse` are the SAME VALUE in light mode — so a glasshouse panel
// there is white on white and reads as pale nothing however good its shadow.
// The panel goes down the ladder to `grey-100` and takes `.ah-lift`; its rows
// hover one step further to `grey-200`, and the revealed-url field rises to
// white (the ladder's own cards/fields rung).
// =============================================================================

interface ShareButtonProps {
  url: string
  title: string
  dark?: boolean  // kept for API compat
  onGiftLink?: () => void
}

const PANEL_W = 176

export function ShareButton({ url, title, onGiftLink }: ShareButtonProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  // The url a refused write could not copy. It keeps the menu OPEN and shows
  // the value — a bare catch that closed the menu regardless made a failed
  // copy indistinguishable from a successful one except that nothing had
  // happened.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    // THE NATIVE SHEET ONLY WHERE IT CAN SAY EVERYTHING THIS MENU SAYS.
    //
    // `navigator.share` hands the OS a title and a URL and nothing else, so on
    // any device that has it (which is most phones) this short-circuited before
    // the popover opened — and `onGiftLink` was therefore unreachable there for
    // its whole life. That row is a paywalled author's way of handing somebody a
    // free unlock of their own piece; it is not "share this link" by another
    // name, and no share sheet can offer it. The one visible affordance would
    // simply do a different thing depending on the device, with nothing saying
    // so.
    //
    // So the sheet is used when the menu holds nothing but the link, and the
    // menu opens when it holds more.
    if (!onGiftLink && typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title, url })
      } catch {
        // User cancelled
      }
      return
    }

    setFailedUrl(null)
    setOpen((v) => !v)
  }

  async function copyLink(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const outcome = await copyOrReveal(url, (t) => navigator.clipboard.writeText(t))
    if (!outcome.ok) {
      // Stay open: the menu is the only place the value can be shown, and
      // closing it was the whole of the old failure handling.
      setFailedUrl(outcome.url)
      return
    }
    setFailedUrl(null)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    setOpen(false)
  }

  function openX(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    window.open(
      `https://x.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
      '_blank',
      'noopener,noreferrer'
    )
    setOpen(false)
  }

  function openEmail(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    window.location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleClick}
        // `.btn-text-muted` — the house class for a secondary text-link action
        // (grey-400 → ink on hover), and the same one Report now wears. Both
        // greys are registry vars, so both invert; the pair of hand-rolled
        // colours they replaced (`grey-600`→black and `grey-300`→`grey-400`)
        // agreed with neither each other nor anything else on the row.
        className="btn-text-muted"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Share"
      >
        {copied ? 'Copied!' : 'Share'}
      </button>

      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onDismiss={() => setOpen(false)}
        width={PANEL_W}
        over="paper"
        role="menu"
        ariaLabel="Share"
        className="py-1"
      >
        {failedUrl ? (
          <div className="px-3 py-2">
            <p className="text-ui-xs text-crimson mb-1.5">Couldn&rsquo;t copy — take it by hand:</p>
            <input
              type="text"
              readOnly
              value={failedUrl}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Link — copy it by hand"
              className="w-full bg-white px-2 py-1 font-mono text-mono-xs text-black"
            />
          </div>
        ) : (
          <button
            onClick={copyLink}
            className="w-full text-left px-3 py-2 text-ui-xs text-black hover:bg-grey-200 transition-colors"
          >
            Copy link
          </button>
        )}
        <button
          onClick={openX}
          className="w-full text-left px-3 py-2 text-ui-xs text-black hover:bg-grey-200 transition-colors"
        >
          Share on X
        </button>
        <button
          onClick={openEmail}
          className="w-full text-left px-3 py-2 text-ui-xs text-black hover:bg-grey-200 transition-colors"
        >
          Share via email
        </button>
        {onGiftLink && (
          <>
            {/* Whitespace, never a rule — the sitewide no-thin-line invariant. */}
            <div className="my-1.5" />
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); onGiftLink() }}
              className="w-full text-left px-3 py-2 text-ui-xs text-black hover:bg-grey-200 transition-colors"
            >
              Gift link
            </button>
          </>
        )}
      </AnchoredPopover>
    </>
  )
}
