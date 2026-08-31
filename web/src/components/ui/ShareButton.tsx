'use client'

import { useEffect, useRef, useState } from 'react'
import { copyOrReveal } from '../../hooks/useCopyLink'

interface ShareButtonProps {
  url: string
  title: string
  dark?: boolean  // kept for API compat
  onGiftLink?: () => void
}

export function ShareButton({ url, title, onGiftLink }: ShareButtonProps) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  // The url a refused write could not copy. It keeps the menu OPEN and shows
  // the value — previously the catch was bare and the menu closed regardless,
  // so a failed copy was indistinguishable from a successful one except that
  // nothing had happened.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()

    if (typeof navigator !== 'undefined' && navigator.share) {
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
    <div ref={containerRef} className="relative">
      <button
        onClick={handleClick}
        className="text-ui-xs transition-colors text-grey-600 hover:text-black"
        aria-label="Share"
      >
        {copied ? 'Copied!' : 'Share'}
      </button>

      {open && (
        <div className="absolute right-0 top-6 z-20 w-44 bg-white shadow-lg py-1">
          {failedUrl ? (
            <div className="px-3 py-2">
              <p className="text-xs text-crimson mb-1.5">Couldn&rsquo;t copy — take it by hand:</p>
              <input
                type="text"
                readOnly
                value={failedUrl}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Link — copy it by hand"
                className="w-full bg-glasshouse-well px-2 py-1 font-mono text-[11px] text-black"
              />
            </div>
          ) : (
            <button
              onClick={copyLink}
              className="w-full text-left px-3 py-2 text-xs text-black hover:bg-grey-100 transition-colors"
            >
              Copy link
            </button>
          )}
          <button
            onClick={openX}
            className="w-full text-left px-3 py-2 text-xs text-black hover:bg-grey-100 transition-colors"
          >
            Share on X
          </button>
          <button
            onClick={openEmail}
            className="w-full text-left px-3 py-2 text-xs text-black hover:bg-grey-100 transition-colors"
          >
            Share via email
          </button>
          {onGiftLink && (
            <>
              <div className="my-1.5" />
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(false); onGiftLink() }}
                className="w-full text-left px-3 py-2 text-xs text-black hover:bg-grey-100 transition-colors"
              >
                Gift link
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
