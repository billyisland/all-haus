'use client'

import { useEffect, useRef } from 'react'
import { readingPositions, readingPreferences } from '../lib/api'

const SAVE_DEBOUNCE_MS = 500
const GRACE_ZONE = 0.1
const MAX_RATIO = 0.99

function computeScrollRatio(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight
  if (max <= 0) return 0
  return Math.min(1, Math.max(0, window.scrollY / max))
}

function saveBeacon(eventId: string, scrollRatio: number) {
  const url = `/api/v1/reading-positions/${eventId}`
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
  nostrEventId: string
  enabled: boolean
}

export function useReadingPosition({ nostrEventId, enabled }: Options) {
  const restoredRef = useRef(false)
  const lastSavedRef = useRef(0)

  useEffect(() => {
    if (!enabled || !nostrEventId) return

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
          readingPositions.get(nostrEventId),
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
          const max = document.documentElement.scrollHeight - window.innerHeight
          if (max > 0) {
            window.scrollTo({ top: position.scrollRatio * max, behavior: 'auto' })
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
        const ratio = computeScrollRatio()
        if (Math.abs(ratio - lastSavedRef.current) < 0.005) return
        lastSavedRef.current = ratio
        readingPositions.upsert(nostrEventId, ratio).catch(() => {})
      }, SAVE_DEBOUNCE_MS)
    }

    function flushOnHide() {
      if (!restoredRef.current) return
      const ratio = computeScrollRatio()
      if (ratio >= MAX_RATIO) {
        // Reader has reached the foot — no value in resuming there.
        return
      }
      lastSavedRef.current = ratio
      saveBeacon(nostrEventId, ratio)
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') flushOnHide()
    }

    window.addEventListener('scroll', scheduleSave, { passive: true })
    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      controller.abort()
      if (saveTimer) clearTimeout(saveTimer)
      window.removeEventListener('scroll', scheduleSave)
      window.removeEventListener('pagehide', flushOnHide)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [nostrEventId, enabled])
}
