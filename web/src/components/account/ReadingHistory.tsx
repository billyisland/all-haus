'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ProfileLink } from '../ui/ProfileLink'
import { readingHistory, type ReadingHistoryItem } from '../../lib/api'
import { useReader } from '../../stores/reader'
import { useLibraryOverlay } from '../../stores/libraryOverlay'
import { Avatar } from '../ui/Avatar'

const PAGE_SIZE = 20

// `inOverlay` is set when ReadingHistory renders inside the workspace Library
// overlay: article titles open the reader in place (useReader.openNative)
// instead of routing to the article page, which would leave the workspace for a
// standalone surface (CLAUDE.md: no workspace escapes).
export function ReadingHistory({ inOverlay = false }: { inOverlay?: boolean }) {
  const [items, setItems] = useState<ReadingHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  async function fetchItems(offset: number, append: boolean) {
    if (offset === 0) setLoading(true)
    else setLoadingMore(true)
    try {
      const data = await readingHistory.list(PAGE_SIZE + 1, offset)
      const fetched = data.items
      const more = fetched.length > PAGE_SIZE
      if (more) fetched.pop()
      setItems(prev => append ? [...prev, ...fetched] : fetched)
      setHasMore(more)
    } catch {}
    finally { setLoading(false); setLoadingMore(false) }
  }

  useEffect(() => { void fetchItems(0, false) }, [])

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />
  if (items.length === 0) return null

  // `/article/:dTag` is the native article route. This built `/@user/slug`,
  // which 404s twice over — the `@` (the profile route is `/[username]`, no
  // stripping), and there is no `/[username]/[slug]` route at all, so dropping
  // the `@` alone would not have fixed it. `dTag` is the same field the
  // in-overlay branch below already opens the reader with, so the two paths now
  // address the same article the same way.
  function articleHref(item: ReadingHistoryItem) {
    return item.dTag ? `/article/${item.dTag}` : null
  }

  function openInReader(item: ReadingHistoryItem) {
    if (!item.dTag) return
    useLibraryOverlay.getState().close()
    useReader.getState().openNative(item.dTag)
  }

  return (
    <div className="mb-10">
      <p className="label-ui text-grey-400 mb-4">Reading history</p>
      <div className="bg-glasshouse-well">
        {items.map(item => {
          const href = articleHref(item)
          return (
            <div key={`${item.articleId}-${item.readAt}`} className="flex items-center gap-3 px-6 py-4">
              {item.writer.username ? (
                <ProfileLink href={`/${item.writer.username}`} className="flex-shrink-0">
                  <Avatar src={item.writer.avatar} name={item.writer.displayName || item.writer.username} size={28} />
                </ProfileLink>
              ) : (
                <Avatar src={item.writer.avatar} name={item.writer.displayName || '?'} size={28} />
              )}
              <div className="min-w-0 flex-1">
                {inOverlay && item.dTag ? (
                  <button
                    type="button"
                    onClick={() => openInReader(item)}
                    className="block text-left text-ui-sm text-black hover:opacity-70 line-clamp-1"
                  >
                    {item.title || 'Untitled'}
                  </button>
                ) : href ? (
                  <Link href={href} className="text-ui-sm text-black hover:opacity-70 line-clamp-1">
                    {item.title || 'Untitled'}
                  </Link>
                ) : (
                  <p className="text-ui-sm text-black line-clamp-1">{item.title || 'Untitled'}</p>
                )}
                <p className="label-ui text-grey-300">
                  {item.writer.displayName || item.writer.username ? `by @${item.writer.username}` : 'Unknown writer'}
                  {' \u00b7 '}
                  {new Date(item.readAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </p>
              </div>
              <span className={`flex-shrink-0 font-mono text-[12px] tabular-nums ${item.isPaywalled ? 'text-black' : 'text-grey-300'}`}>
                {item.isPaywalled ? 'Paid' : 'Free'}
              </span>
            </div>
          )
        })}
      </div>
      {hasMore && (
        <div className="mt-4 text-center">
          <button
            onClick={() => fetchItems(items.length, true)}
            disabled={loadingMore}
            className="btn-text underline underline-offset-4"
          >
            {loadingMore ? 'Loading\u2026' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  )
}
