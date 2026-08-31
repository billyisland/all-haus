'use client'

import { useState } from 'react'
import { giftLinks } from '../../lib/api'
import { copyOrReveal } from '../../hooks/useCopyLink'

interface GiftLinkModalProps {
  articleDbId: string
  onClose: () => void
}

export function GiftLinkModal({ articleDbId, onClose }: GiftLinkModalProps) {
  const [limit, setLimit] = useState(5)
  const [creating, setCreating] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  // idle | copied | failed. Not a boolean: "it did not copy" and "it has not
  // been pressed" are different things to say, and the old code could say
  // neither — it fired `void writeText(url)` and reported nothing at all, so a
  // refused write was indistinguishable from a successful one.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

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
    try {
      const result = await giftLinks.create(articleDbId, limit)
      setUrl(window.location.origin + result.url)
    } catch { /* ignore */ }
    finally { setCreating(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="relative bg-white shadow-lg w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-grey-400 hover:text-black text-lg leading-none"
        >
          ✕
        </button>
        <h3 className="font-serif text-[20px] font-medium text-black mb-1">Create gift link</h3>
        <p className="text-ui-xs font-sans text-grey-400 mb-4">Generate a shareable link that grants free access.</p>
        {!url ? (
          <>
            <label className="block text-[12px] font-mono text-grey-400 mb-1">Redemption limit</label>
            <input
              type="number"
              min={1}
              max={1000}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10) || 5)}
              className="w-20 bg-grey-100 px-2 py-1 text-ui-xs font-sans text-black mb-4"
            />
            <div>
              <button onClick={handleCreate} disabled={creating} className="btn text-sm disabled:opacity-50">
                {creating ? 'Creating…' : 'Generate link'}
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              type="text"
              readOnly
              value={url}
              className="w-full bg-grey-100 px-3 py-1.5 text-ui-xs font-mono text-black mb-3"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button onClick={() => void handleCopy()} className="btn text-sm">
              {copyState === 'copied' ? 'Copied!' : 'Copy link'}
            </button>
            {/* The url is already on screen as this modal's receipt, so the
                reveal the rule asks for is structural here — what was missing
                was ever SAYING the write failed. */}
            {copyState === 'failed' && (
              <p className="text-ui-xs font-sans text-crimson mt-2">
                Couldn&rsquo;t reach the clipboard — select the link above and copy it by hand.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
