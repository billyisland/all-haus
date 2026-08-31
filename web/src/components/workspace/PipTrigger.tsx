'use client'

import { useRef } from 'react'
import { TrustPip } from '../ui/TrustPip'
import type { PipStatus } from '../../lib/ndk'

// PipTrigger — wraps an inline TrustPip in a button that, on click, hands its
// bounding rect up to the workspace so a single shared PipPanel can anchor on
// it. The pip itself stays a pure visual; the button wrapper carries the
// gesture. Per CARDS-AND-PIP-PANEL-HANDOFF.md §"The content card": the pip is
// the tap target for the pip panel.

interface PipTriggerProps {
  pubkey: string
  pipStatus?: PipStatus
  opacity?: number
  scale?: number // for compact-density 9px rendering, parity with bare TrustPip
  onOpen: (pubkey: string, rect: DOMRect, pipStatus: PipStatus | undefined) => void
}

export function PipTrigger({ pubkey, pipStatus, opacity = 1, scale, onOpen }: PipTriggerProps) {
  const ref = useRef<HTMLButtonElement>(null)
  function handleClick(e: React.MouseEvent) {
    // Don't fall through to card-level click handlers (which would navigate
    // to the article reader / external URL).
    e.stopPropagation()
    if (!ref.current) return
    onOpen(pubkey, ref.current.getBoundingClientRect(), pipStatus)
  }
  const inner = (
    <span style={{ display: 'inline-flex', opacity }}>
      <TrustPip status={pipStatus} />
    </span>
  )
  return (
    <button
      ref={ref}
      type="button"
      onClick={handleClick}
      // Gesture-precedence marker (MOBILE-LAYOUT-ADR §VI): the mobile pager
      // never claims a drag that began on the pip — the pip wins.
      data-pip-trigger=""
      aria-label="Author trust details"
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        display: 'inline-flex',
        lineHeight: 0,
      }}
    >
      {scale !== undefined ? (
        <span style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
          {inner}
        </span>
      ) : (
        inner
      )}
    </button>
  )
}
