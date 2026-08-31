'use client'

import { useEffect } from 'react'
import { useAuth } from '../../stores/auth'

// =============================================================================
// TraffologyMeta — renders hidden data attributes read by the page script
//
// Sets article ID (static) and subscriber status (updated when auth hydrates).
// The page script reads these attributes at beacon-send time.
// =============================================================================

export function TraffologyMeta({ articleId }: { articleId: string }) {
  const { user, loading } = useAuth()

  useEffect(() => {
    if (loading) return
    const el = document.getElementById('traffology-meta')
    if (!el) return

    if (!user) {
      el.setAttribute('data-traffology-subscriber', 'anonymous')
    } else if (user.hasPaymentMethod) {
      el.setAttribute('data-traffology-subscriber', 'paying')
    } else {
      el.setAttribute('data-traffology-subscriber', 'free')
    }
  }, [user, loading])

  return (
    <div
      id="traffology-meta"
      data-traffology-article-id={articleId}
      data-traffology-subscriber="anonymous"
      style={{ display: 'none' }}
      aria-hidden="true"
    />
  )
}
