'use client'

import { useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'

// Compatibility shim for notification deep-linking to a specific conversation.
// Direct messages is now a workspace Glasshouse overlay; forward the path param
// into the overlay's ?conversation= seed.
export default function ConversationPage() {
  const router = useRouter()
  const params = useParams()
  const conversationId = params.conversationId as string

  useEffect(() => {
    router.replace(
      `/reader?overlay=messages&conversation=${encodeURIComponent(conversationId)}`,
    )
  }, [conversationId, router])

  return (
    <div className="mx-auto max-w-content px-4 sm:px-6 py-10">
      <div className="h-[600px] flex items-center justify-center">
        <p className="text-ui-sm font-sans text-grey-300">Loading conversation…</p>
      </div>
    </div>
  )
}
