'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { readingPositions, readingPreferences } from '../lib/api'

const SAVE_DEBOUNCE_MS = 500
const GRACE_ZONE = 0.1
const MAX_RATIO = 0.99

// =============================================================================
// useReadingPosition — save and restore scroll depth within a piece.
//
// TAKES ITS SCROLL CONTAINER (READING-LOG-AND-LIBRARY-ADR D9). It used to read
// `document.documentElement` / `window.scrollY` unconditionally, which is right
// on a page and wrong inside a Glasshouse, where the scroller is the pane's own
// div. So the mount it already had in ReaderOverlay's native branch did nothing
// at all — and said nothing, because a ratio of 0 forever is a perfectly
// ordinary reading. Nothing that measures or restores scroll may assume the
// document scrolls.
//
// A PROVIDED CONTAINER THAT IS NOT THERE IS AN ERROR, NOT A CUE TO FALL BACK.
// If a caller passes `scrollRef` and its `.current` is null we do nothing:
// silently reverting to `window` would reinstate exactly the bug above, in the
// one place it is hardest to notice.
//
// KEYED ON post_id since migration 189 (D8) — an external post has no
// `articles` row, so there was previously nothing to key a position on and
// resume worked on native pieces only.
// =============================================================================

/** The element that actually scrolls, or `null` for the document. */
type Scroller = HTMLElement | null

/**
 * The reader's depth through the piece, 0–1 — or `null` when there is nothing
 * to measure.
 *
 * NULL IS NOT ZERO, and collapsing the two is the clobber this hook shipped
 * with. `max <= 0` means the content is shorter than its viewport or has not
 * laid out yet; reporting that as 0 and saving it overwrites a genuine position
 * with "the top". Same rule as the reconciliation rates: a ratio with an empty
 * denominator is reported ABSENT, never as zero, because the zero reading is
 * both wrong and reassuring.
 */
function computeScrollRatio(el: Scroller): number | null {
  const max = el
    ? el.scrollHeight - el.clientHeight
    : document.documentElement.scrollHeight - window.innerHeight
  if (max <= 0) return null
  const top = el ? el.scrollTop : window.scrollY
  return Math.min(1, Math.max(0, top / max))
}

function scrollTo(el: Scroller, top: number) {
  if (el) el.scrollTo({ top, behavior: 'auto' })
  else window.scrollTo({ top, behavior: 'auto' })
}

function saveBeacon(postId: string, scrollRatio: number) {
  const url = `/api/v1/reading-positions/${postId}`
  const body = JSON.stringify({ scrollRatio })
  try {
    fetch(url, {
      method: 'PUT',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {})
  } catch {
    // swallow — best effort
  }
}

interface Options {
  /** The piece's `post_id`. Native readers take it from the article payload. */
  postId: string | null | undefined
  enabled: boolean
  /**
   * The scrolling element. Omit on a page (the document scrolls); pass the
   * pane's own scrolling div inside a Glasshouse.
   */
  scrollRef?: RefObject<HTMLElement | null>
}

export function useReadingPosition({ postId, enabled, scrollRef }: Options) {
  const restoredRef = useRef(false)
  const lastSavedRef = useRef(0)

  useEffect(() => {
    if (!enabled || !postId) return

    // Resolved once per mount: the parent's DOM ref is attached during commit,
    // which precedes every effect, so a ref that is null here will not become
    // non-null later in this mount.
    const el: Scroller = scrollRef ? scrollRef.current : null
    if (scrollRef && !el) return

    // The window listener is right for the document scroller; a div's scroll
    // events do not reach `window`.
    const target: EventTarget = el ?? window

    let cancelled = false
    const controller = new AbortController()

    async function maybeRestore() {
      if (window.location.hash) {
        restoredRef.current = true
        return
      }
      try {
        const [{ alwaysOpenAtTop }, { position }] = await Promise.all([
          readingPreferences.get(),
          readingPositions.get(postId!),
        ])
        if (cancelled) return
        if (alwaysOpenAtTop || !position) {
          restoredRef.current = true
          return
        }
        if (position.scrollRatio < GRACE_ZONE) {
          restoredRef.current = true
          return
        }
        // Defer to next frame so the article body has laid out.
        requestAnimationFrame(() => {
          if (cancelled) return
          const max = el
            ? el.scrollHeight - el.clientHeight
            : document.documentElement.scrollHeight - window.innerHeight
          if (max > 0) {
            scrollTo(el, position.scrollRatio * max)
          }
          restoredRef.current = true
        })
      } catch {
        restoredRef.current = true
      }
    }

    void maybeRestore()

    let saveTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleSave() {
      if (!restoredRef.current) return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        const ratio = computeScrollRatio(el)
        if (ratio === null) return
        if (Math.abs(ratio - lastSavedRef.current) < 0.005) return
        lastSavedRef.current = ratio
        readingPositions.upsert(postId!, ratio).catch(() => {})
      }, SAVE_DEBOUNCE_MS)
    }

    function flushOnHide() {
      if (!restoredRef.current) return
      const ratio = computeScrollRatio(el)
      // Nothing measurable — say nothing. This is the guard `flushOnHide`
      // lacked: unlike `scheduleSave` above it has no "has it moved?" test, so
      // an unmeasurable 0 went straight out as a beacon and overwrote whatever
      // real position was stored.
      if (ratio === null) return
      if (ratio >= MAX_RATIO) {
        // Reader has reached the foot — no value in resuming there.
        return
      }
      lastSavedRef.current = ratio
      saveBeacon(postId!, ratio)
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') flushOnHide()
    }

    target.addEventListener('scroll', scheduleSave, { passive: true } as AddEventListenerOptions)
    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      controller.abort()
      if (saveTimer) clearTimeout(saveTimer)
      target.removeEventListener('scroll', scheduleSave)
      window.removeEventListener('pagehide', flushOnHide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [postId, enabled, scrollRef])
}
