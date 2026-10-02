'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { readingLog, type ReadingLogEntry } from '../../lib/api'
import { useLibraryOverlay } from '../../stores/libraryOverlay'
import { useWriterName } from '../../hooks/useWriterName'
import { LoadFailed } from '../ui/LoadFailed'
import { openPostInReader, canOpenPostInReader } from '../../lib/workspace/open-post'
import {
  RECENT_READING_LOAD_FAILED_WHAT,
  recentReadingEmpty,
  RECENT_READING_EMPTY_HINT,
  RECENT_READING_SHOW_MORE,
  RECENT_READING_UNTITLED,
  RECENT_READING_NO_LINK,
  RECENT_READING_NATIVE_BYLINE_FALLBACK,
} from '../../content/library'

const PAGE_SIZE = 20

// =============================================================================
// RecentReading — the Library overlay's first tab (READING-LOG-AND-LIBRARY-ADR).
//
// Everything opened in a reader in the last seven days, all.haus or not, paid
// or not, most recently opened first. Its twin tab is the library, which holds
// what was ACQUIRED; neither is a filter of the other.
//
// ROWS THAT RESOLVE TO NOTHING ARE SKIPPED BY THE GATEWAY, not rendered as an
// error (D7's corollary): the log is a record of what happened, not a set of
// live pointers, so a piece deleted since it was read simply stops appearing. A
// page can therefore come back shorter than it asked for, which is why "show
// more" pages on what was requested rather than on what arrived.
//
// It replaces `ReadingHistory`, which read `/my/reading-history` — a route that
// answered 500 for every caller from the day it was written, swallowed
// correctly at every call site, and so had never shown a row.
// =============================================================================

// `inOverlay` is set when this renders inside the workspace Library overlay:
// titles open the reader in place instead of routing to a standalone surface,
// which would leave the workspace (CLAUDE.md: no workspace escapes).
export function RecentReading({ inOverlay = false }: { inOverlay?: boolean }) {
  const [items, setItems] = useState<ReadingLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  // The retention window, read from the server rather than typed: the empty
  // state's whole subject IS the window, and "seven days" was a literal that
  // would have gone on saying seven the day `reading_log_retention_days` was
  // retuned. Null until the first response — the sentence falls back to a
  // vaguer form rather than naming a figure it does not have.
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [requested, setRequested] = useState(0)

  async function fetchItems(offset: number, append: boolean) {
    if (offset === 0) setLoading(true)
    else setLoadingMore(true)
    try {
      const data = await readingLog.list(PAGE_SIZE, offset)
      setItems(prev => (append ? [...prev, ...data.items] : data.items))
      // BOTH HALVES COME OFF WHAT WAS ASKED FOR, never off what came back.
      // The offset is the one the server paged on — paging on `items.length`
      // would re-request the rows skipped for resolving to nothing, and the
      // list would stick. `hasMore` is the same rule for the other half, and
      // it is the server's to answer: this used to ask for one extra row and
      // conclude "the end" when fewer arrived, so a single deleted piece
      // anywhere in a page ended the log early and said nothing.
      setHasMore(data.hasMore)
      setRequested(offset + PAGE_SIZE)
      setRetentionDays(data.retentionDays ?? null)
      setFailed(false)
    } catch {
      // A dead gateway is an outage, not an empty tab — the swallow that used
      // to sit here is exactly the one that hid the predecessor's 500 for its
      // whole life, and the sentence it left on screen ("Nothing read in the
      // last seven days") is a claim about the reader that nothing had checked.
      // A failed FIRST page says so; a failed later page keeps what is on
      // screen and stops offering more.
      if (offset === 0) setFailed(true)
      setHasMore(false)
    }
    finally { setLoading(false); setLoadingMore(false) }
  }

  useEffect(() => { void fetchItems(0, false) }, [])

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />

  if (failed) return <LoadFailed what={RECENT_READING_LOAD_FAILED_WHAT} />

  if (items.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400">
          {recentReadingEmpty(retentionDays)}
        </p>
        <p className="label-ui text-grey-300 mt-2">
          {RECENT_READING_EMPTY_HINT}
        </p>
      </div>
    )
  }

  return (
    <div className="mb-10">
      <div className="bg-glasshouse-well">
        {items.map(entry => (
          <RecentReadingRow
            key={`${entry.post.id}-${entry.openedAt}`}
            entry={entry}
            inOverlay={inOverlay}
          />
        ))}
      </div>
      {hasMore && (
        <div className="mt-4 text-center">
          <button
            onClick={() => fetchItems(requested, true)}
            disabled={loadingMore}
            className="btn-text underline underline-offset-4"
          >
            {loadingMore ? 'Loading…' : RECENT_READING_SHOW_MORE}
          </button>
        </div>
      )}
    </div>
  )
}

function RecentReadingRow({
  entry,
  inOverlay,
}: {
  entry: ReadingLogEntry
  inOverlay: boolean
}) {
  const router = useRouter()
  const { post, openedAt } = entry
  const isNative = post.origin.protocol === 'nostr'

  function open() {
    useLibraryOverlay.getState().close()
    openPostInReader(post, router)
  }

  // Openability is the helper's question too: an external row whose origin URI
  // is a non-URL RSS guid has no permalink to read, and offering the title as a
  // button that does nothing is worse than printing it as text.
  const openable = canOpenPostInReader(post)
  const title = post.body.title || post.body.summary || post.body.text || RECENT_READING_UNTITLED

  return (
    <div className="flex items-center gap-3 px-6 py-4">
      <div className="min-w-0 flex-1">
        {openable ? (
          <button
            type="button"
            onClick={open}
            className="block text-left text-ui-sm text-black hover:opacity-70 line-clamp-1"
          >
            {title}
          </button>
        ) : (
          <p className="text-ui-sm text-black line-clamp-1">{title}</p>
        )}
        <p className="label-ui text-grey-300">
          <RowByline post={post} />
          {' · '}
          {new Date(openedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          {/* Said on the row (walkthrough A2): without it the unclickable title
              sits beside clickable ones with nothing saying why. Covers a
              native item with no dTag as well as the RSS guid case. */}
          {!openable && RECENT_READING_NO_LINK}
        </p>
      </div>
      {/* The whole web, not only ours — so the row says which. A native piece
          needs no label; it is the unmarked case on all.haus's own surface. */}
      {!isNative && (
        <span className="flex-shrink-0 label-ui text-grey-300">
          {post.origin.sourceName ?? post.origin.protocol}
        </span>
      )}
    </div>
  )
}

// The byline, split in two so the pubkey lookup runs only where there is a
// pubkey to look up — `useWriterName` takes a string and would fetch for an
// empty one. A native Post carries `author.displayName: null` by design and
// resolves at render from the pubkey, exactly as a feed card does.
function RowByline({ post }: { post: ReadingLogEntry['post'] }) {
  if (post.origin.protocol === 'nostr' && post.author.pubkey) {
    return <NativeByline pubkey={post.author.pubkey} />
  }
  // Last resort is the PROTOCOL label, never a bare "External" (which renders
  // uppercase as "EXTERNAL") — the same rule the card chassis holds.
  return <>{post.author.displayName ?? post.author.handle ?? post.origin.sourceName ?? post.origin.protocol}</>
}

function NativeByline({ pubkey }: { pubkey: string }) {
  const info = useWriterName(pubkey)
  return <>{info?.displayName ?? (info?.username ? `@${info.username}` : RECENT_READING_NATIVE_BYLINE_FALLBACK)}</>
}
