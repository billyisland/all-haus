'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'

const POLL_INTERVAL = 15_000

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const fetchMe = useAuth((s) => s.fetchMe)
  const user = useAuth((s) => s.user)
  const fetchUnread = useUnreadCounts((s) => s.fetch)

  useEffect(() => {
    void fetchMe()
  }, [fetchMe])

  // Poll unread counts only while the tab is visible — a backgrounded tab
  // pinging the box every 15s is pure idle load (and gateway/DB contention on
  // the shared VPS). On becoming visible again we fetch once immediately so the
  // badge is fresh, then resume the interval.
  useEffect(() => {
    if (!user) return
    let id: ReturnType<typeof setInterval> | undefined

    const start = () => {
      if (id !== undefined) return
      void fetchUnread()
      id = setInterval(fetchUnread, POLL_INTERVAL)
    }
    const stop = () => {
      if (id === undefined) return
      clearInterval(id)
      id = undefined
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [user, fetchUnread])

  return <>{children}</>
}
