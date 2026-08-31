'use client'

import { useState, useEffect, useCallback, type RefObject } from 'react'
import { useCompose } from '../../stores/compose'
import { rangeToOffsets } from '../../lib/citation-anchor'

interface QuoteSelectorProps {
  articleBodyRef: RefObject<HTMLDivElement | null>
  articleId: string
  articleTitle: string
  articlePubkey: string
  writerName: string
  isLoggedIn: boolean
  // The author of the piece gets an extra "Cite" action: capture the selected
  // span (text + char offsets within the body) as a pending citation that the
  // piece-foot composer picks up. UPSTREAM-EDGES — inline citation anchoring.
  isAuthor?: boolean
  onCite?: (excerpt: string, charStart: number, charEnd: number) => void
}

export function QuoteSelector({ articleBodyRef, articleId, articleTitle, articlePubkey, writerName, isLoggedIn, isAuthor = false, onCite }: QuoteSelectorProps) {
  const [selectionPopup, setSelectionPopup] = useState<{ x: number; y: number; text: string; raw: string; start: number; end: number } | null>(null)
  const openCompose = useCompose((s) => s.open)

  const handleMouseUp = useCallback(() => {
    if (!isLoggedIn) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) { setSelectionPopup(null); return }
    const body = articleBodyRef.current
    if (!body) return
    const range = sel.getRangeAt(0)
    if (!body.contains(range.commonAncestorContainer)) { setSelectionPopup(null); return }
    const rect = range.getBoundingClientRect()
    const raw = sel.toString().trim()
    const words = raw.split(/\s+/).slice(0, 80).join(' ')
    // Char offsets within the body's plain text — only needed for the author's
    // Cite action, but cheap and captured here while the live range exists. The
    // pair spans the full selection (`raw`), the citation's exact integrity anchor.
    const offsets = rangeToOffsets(body, range)
    setSelectionPopup({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      text: words,
      raw,
      start: offsets?.start ?? 0,
      end: offsets?.end ?? 0,
    })
  }, [isLoggedIn, articleBodyRef])

  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp)
    return () => document.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  return (
    <>
      {selectionPopup && (
        <div
          className="fixed z-50 flex items-stretch bg-black text-white text-[12px] font-sans shadow-lg"
          style={{ left: selectionPopup.x, top: selectionPopup.y, transform: 'translate(-50%, -100%)' }}
        >
          <button
            className="px-3 py-1.5 hover:opacity-80 transition-opacity"
            onMouseDown={e => {
              e.preventDefault()
              openCompose('reply', {
                eventId: articleId,
                eventKind: 30023,
                authorPubkey: articlePubkey,
                highlightedText: selectionPopup.text,
                previewContent: selectionPopup.text,
                previewTitle: articleTitle,
                previewAuthorName: writerName,
              })
              setSelectionPopup(null)
            }}
          >
            Quote
          </button>
          {isAuthor && onCite && (
            <button
              className="px-3 py-1.5 hover:opacity-80 transition-opacity"
              onMouseDown={e => {
                e.preventDefault()
                onCite(selectionPopup.raw, selectionPopup.start, selectionPopup.end)
                window.getSelection()?.removeAllRanges()
                setSelectionPopup(null)
              }}
            >
              Cite
            </button>
          )}
        </div>
      )}
    </>
  )
}
