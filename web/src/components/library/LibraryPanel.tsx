'use client'

// =============================================================================
// LibraryPanel — the reader's library (bookmarks + reading history) body,
// extracted so the workspace Glasshouse overlay (LibraryOverlay) owns it.
// Mirrors SettingsPanel/LedgerPanel: a page-capable mode (`inOverlay=false`,
// wrapped in PageShell with the auth redirect) is kept for the standalone
// /library route, but the overlay is the live surface inside the workspace.
//
// In overlay mode every article row opens the reader in place
// (useReader.openNative) instead of routing to /article/<dTag> — a Link there
// would mount the black topbar and escape the workspace (CLAUDE.md: no
// workspace escapes). `initialTab` seeds bookmarks vs history.
// =============================================================================

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useReader } from '../../stores/reader'
import { useLibraryOverlay, type LibraryTab } from '../../stores/libraryOverlay'
import { bookmarks as bookmarksApi, type BookmarkedArticle } from '../../lib/api'
import { ReadingHistory } from '../account/ReadingHistory'
import { formatDateRelative, truncateText, stripMarkdown } from '../../lib/format'
import { PageShell, PageHeader } from '../ui/PageShell'

export function LibraryPanel({
  inOverlay = false,
  initialTab = 'bookmarks',
}: {
  inOverlay?: boolean
  initialTab?: LibraryTab
}) {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<LibraryTab>(initialTab)

  useEffect(() => {
    if (!inOverlay && !authLoading && !user) router.push('/auth?mode=login')
  }, [inOverlay, user, authLoading, router])

  function switchTab(t: LibraryTab) {
    setTab(t)
    if (inOverlay) return
    const url = new URL(window.location.href)
    url.searchParams.set('tab', t)
    window.history.replaceState({}, '', url.toString())
  }

  if (authLoading || !user) {
    const skeleton = (
      <>
        <div className="h-8 w-40 animate-pulse bg-glasshouse-well mb-10" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse bg-glasshouse-well" />)}
        </div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="feed">{skeleton}</PageShell>
  }

  const body = (
    <>
      {inOverlay && <PageHeader title="Library" />}
      <div className="flex gap-2 mb-8">
        {(['bookmarks', 'history'] as LibraryTab[]).map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={`tab-pill ${tab === t ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {t === 'bookmarks' ? 'Bookmarks' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'bookmarks' && (
        <div data-explain="library.bookmarks">
          <BookmarksTab inOverlay={inOverlay} />
        </div>
      )}
      {tab === 'history' && (
        <div data-explain="library.history">
          <ReadingHistory inOverlay={inOverlay} />
        </div>
      )}
    </>
  )

  if (inOverlay) return body
  return <PageShell width="feed" title="Library">{body}</PageShell>
}

/** Open an article: reader-in-place inside the workspace, route otherwise. */
function openArticle(dTag: string, inOverlay: boolean, router: ReturnType<typeof useRouter>) {
  if (inOverlay) {
    useLibraryOverlay.getState().close()
    useReader.getState().openNative(dTag)
  } else {
    router.push(`/article/${dTag}`)
  }
}

function BookmarksTab({ inOverlay }: { inOverlay: boolean }) {
  const router = useRouter()
  const [articles, setArticles] = useState<BookmarkedArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const loadBookmarks = useCallback(async (newOffset: number) => {
    try {
      const res = await bookmarksApi.list(20, newOffset)
      if (newOffset === 0) {
        setArticles(res.articles)
      } else {
        setArticles(prev => [...prev, ...res.articles])
      }
      setHasMore(res.hasMore)
      setOffset(newOffset + res.articles.length)
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadBookmarks(0) }, [loadBookmarks])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  if (articles.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400">No bookmarks yet.</p>
        {/* In the overlay the ∀ disc (an X) is the way back — no in-panel
            "back to workspace" prompt. Only the standalone page links out. */}
        {!inOverlay && (
          <Link
            href="/reader"
            className="btn-text underline underline-offset-4 mt-4 inline-block"
          >
            Go to workspace
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {articles.map(a => (
        <BookmarkCard
          key={a.nostr_event_id}
          article={a}
          onOpen={() => openArticle(a.nostr_d_tag, inOverlay, router)}
        />
      ))}
      {hasMore && (
        <div className="py-6 text-center">
          <button
            onClick={() => loadBookmarks(offset)}
            className="btn-text underline underline-offset-4"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  )
}

function BookmarkCard({
  article: a,
  onOpen,
}: {
  article: BookmarkedArticle
  onOpen: () => void
}) {
  const publishedAt = a.published_at ? Math.floor(new Date(a.published_at).getTime() / 1000) : 0
  const excerpt = a.summary ? truncateText(stripMarkdown(a.summary), 120) : ''

  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full text-left bg-glasshouse-well px-6 py-4 hover:bg-grey-50 transition-colors"
    >
      <p className="label-ui text-grey-300 mb-1">
        {a.author_display_name ?? a.author_username}
        {publishedAt > 0 && (
          <> · {formatDateRelative(publishedAt)}</>
        )}
      </p>
      <h2 className="font-serif text-lg text-black leading-snug">
        {a.title}
      </h2>
      {excerpt && (
        <p className="text-ui-sm text-grey-600 mt-1 leading-relaxed">
          {excerpt}
        </p>
      )}
    </button>
  )
}
