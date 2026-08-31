'use client'

import { useState } from 'react'
import { bookmarks } from '../../lib/api'
import { useAuth } from '../../stores/auth'

interface Props {
  articleId: string
  initialBookmarked?: boolean
  showLabel?: boolean
}

export function BookmarkButton({ articleId, initialBookmarked = false, showLabel = false }: Props) {
  const { user } = useAuth()
  const [bookmarked, setBookmarked] = useState(initialBookmarked)

  async function toggle(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!user) return

    const prev = bookmarked
    setBookmarked(!prev)
    try {
      if (prev) {
        await bookmarks.remove(articleId)
      } else {
        await bookmarks.add(articleId)
      }
    } catch {
      setBookmarked(prev)
    }
  }

  if (!user) return null

  return (
    <button
      onClick={toggle}
      className={`transition-colors ${bookmarked ? 'text-black' : 'text-grey-600 hover:text-black'}`}
      title={bookmarked ? 'Remove bookmark' : 'Bookmark'}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill={bookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      {showLabel && <span className="sr-only">{bookmarked ? 'Bookmarked' : 'Bookmark'}</span>}
    </button>
  )
}
