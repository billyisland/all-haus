'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Direct messages is now a workspace Glasshouse overlay (opened from the
// ForallMenu or via /reader?overlay=messages). This route is retained only as
// a compatibility shim. It must be a client component to forward the
// `#conversationId` hash (legacy deep-link form) — that fragment never reaches
// the server — into the overlay's ?conversation= seed param.
export default function MessagesPage() {
  const router = useRouter()

  useEffect(() => {
    const conv = window.location.hash.slice(1)
    router.replace(
      conv
        ? `/reader?overlay=messages&conversation=${encodeURIComponent(conv)}`
        : '/reader?overlay=messages',
    )
  }, [router])

  return (
    <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <div className="h-[600px] animate-pulse bg-white" />
    </div>
  )
}
