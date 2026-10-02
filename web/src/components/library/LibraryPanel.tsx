'use client'

// =============================================================================
// LibraryPanel — the reader's two logs (READING-LOG-AND-LIBRARY-ADR), extracted
// so the workspace Glasshouse overlay (LibraryOverlay) owns the body. Mirrors
// SettingsPanel/LedgerPanel: a page-capable mode (`inOverlay=false`, wrapped in
// PageShell with the auth redirect) is kept for the standalone /library route,
// but the overlay is the live surface inside the workspace.
//
// TWO TABS, TWO QUESTIONS. *Recent reading* answers "what was that thing I was
// reading on Tuesday?" — everything opened in a reader, all.haus or not, paid
// or not, on a seven-day window. *all.haus library* answers "what do I hold?" —
// everything acquired through the money system, for as long as the account
// exists. Neither is a filter of the other, and that is the point: one is about
// attention, the other about possession.
//
// Both are automatic. Their predecessors were an intention list (`Bookmarks`,
// whose write path was never mounted) beside a receipt (`History`, whose route
// answered 500 for its whole life), so until 2026-09-04 this panel had two tabs
// and neither had ever shown a row.
//
// In overlay mode every row opens the reader in place instead of routing to a
// standalone surface — a Link there would mount the black topbar and escape the
// workspace (CLAUDE.md: no workspace escapes). `initialTab` seeds which opens.
// =============================================================================

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useReader } from '../../stores/reader'
import { useLibraryOverlay, type LibraryTab } from '../../stores/libraryOverlay'
import { library as libraryApi, type LibraryItem } from '../../lib/api'
import { RecentReading } from '../account/RecentReading'
import { formatDateRelative } from '../../lib/format'
import { PageShell, PageHeader } from '../ui/PageShell'
import { LoadFailed } from '../ui/LoadFailed'
import {
  LIBRARY_TITLE,
  LIBRARY_TAB_RECENT,
  LIBRARY_TAB_LIBRARY,
  LIBRARY_LOAD_FAILED_WHAT,
  LIBRARY_EMPTY,
  LIBRARY_EMPTY_HINT,
  LIBRARY_GO_TO_WORKSPACE,
  LIBRARY_LOAD_MORE,
  LIBRARY_UNKNOWN_WRITER,
} from '../../content/library'

const TAB_LABEL: Record<LibraryTab, string> = {
  recent: LIBRARY_TAB_RECENT,
  library: LIBRARY_TAB_LIBRARY,
}

export function LibraryPanel({
  inOverlay = false,
  initialTab = 'recent',
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
      {inOverlay && <PageHeader title={LIBRARY_TITLE} />}
      <div className="flex gap-2 mb-8">
        {(['recent', 'library'] as LibraryTab[]).map(t => (
          <button
            key={t}
            onClick={() => switchTab(t)}
            className={`tab-pill ${tab === t ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {tab === 'recent' && (
        <div data-explain="library.recent">
          <RecentReading inOverlay={inOverlay} />
        </div>
      )}
      {tab === 'library' && (
        <div data-explain="library.holdings">
          <LibraryTabBody inOverlay={inOverlay} />
        </div>
      )}
    </>
  )

  if (inOverlay) return body
  return <PageShell width="feed" title={LIBRARY_TITLE}>{body}</PageShell>
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

const PAGE_SIZE = 20

// The all.haus library: every piece a `read_event` exists for, newest acquired
// first, with no window. A GIFTED READ IS IN HERE (D2) — the free allowance and
// the arrival gift are authors letting a new reader over the paywall, and the
// invariant that says such a read is charged to nobody does not say the reader
// did not get the article. Same for a subscription read. The test is *acquired*,
// not *charged*.
function LibraryTabBody({ inOverlay }: { inOverlay: boolean }) {
  const router = useRouter()
  const [items, setItems] = useState<LibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const load = useCallback(async (newOffset: number) => {
    try {
      const res = await libraryApi.list(PAGE_SIZE + 1, newOffset)
      const fetched = res.items
      const more = fetched.length > PAGE_SIZE
      if (more) fetched.pop()
      setItems(prev => (newOffset === 0 ? fetched : [...prev, ...fetched]))
      setHasMore(more)
      setOffset(newOffset + fetched.length)
      setFailed(false)
    } catch {
      // An outage is not an empty library. This used to swallow the failure
      // into a silent [], which is the swallow that hid this route's
      // predecessor for its whole life — and the claim it then printed
      // ("Nothing in your library yet") is about the reader's own possessions,
      // stated with total confidence by a surface that had not been told
      // anything. A FIRST page that fails says so; a later page that fails
      // leaves what is already on screen alone and just stops offering more.
      if (newOffset === 0) setFailed(true)
      setHasMore(false)
    }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(0) }, [load])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-16 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  if (failed) return <LoadFailed what={LIBRARY_LOAD_FAILED_WHAT} />

  if (items.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400">{LIBRARY_EMPTY}</p>
        <p className="label-ui text-grey-300 mt-2">
          {LIBRARY_EMPTY_HINT}
        </p>
        {/* In the overlay the ∀ disc (an X) is the way back — no in-panel
            "back to workspace" prompt. Only the standalone page links out. */}
        {!inOverlay && (
          <Link
            href="/reader"
            className="btn-text underline underline-offset-4 mt-4 inline-block"
          >
            {LIBRARY_GO_TO_WORKSPACE}
          </Link>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map(a => (
        <LibraryCard
          key={a.articleId}
          item={a}
          onOpen={a.dTag ? () => openArticle(a.dTag!, inOverlay, router) : null}
        />
      ))}
      {hasMore && (
        <div className="py-6 text-center">
          <button
            onClick={() => load(offset)}
            className="btn-text underline underline-offset-4"
          >
            {LIBRARY_LOAD_MORE}
          </button>
        </div>
      )}
    </div>
  )
}

function LibraryCard({
  item,
  onOpen,
}: {
  item: LibraryItem
  onOpen: (() => void) | null
}) {
  const acquired = Math.floor(new Date(item.acquiredAt).getTime() / 1000)
  const inner = (
    <>
      <p className="label-ui text-grey-300 mb-1">
        {item.writer.displayName ?? item.writer.username ?? LIBRARY_UNKNOWN_WRITER}
        {' · '}
        {formatDateRelative(acquired)}
      </p>
      <h2 className="font-serif text-lg text-black leading-snug">{item.title}</h2>
    </>
  )

  if (!onOpen) {
    return <div className="bg-glasshouse-well px-6 py-4">{inner}</div>
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full text-left bg-glasshouse-well px-6 py-4 hover:bg-grey-50 transition-colors"
    >
      {inner}
    </button>
  )
}
