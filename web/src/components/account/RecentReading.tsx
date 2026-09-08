'use client'

import { useState, useEffect } from 'react'
import { readingLog, type ReadingLogEntry } from '../../lib/api'
import { useReader } from '../../stores/reader'
import { useLibraryOverlay } from '../../stores/libraryOverlay'
import { useWriterName } from '../../hooks/useWriterName'

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
    } catch {
      // A dead gateway shows an empty tab, not a broken one. Note the shape,
      // though: this is exactly the swallow that hid the predecessor's 500 for
      // its whole life, so this tab must be proved by driving it and asserting
      // a row — never by its silence.
    }
    finally { setLoading(false); setLoadingMore(false) }
  }

  useEffect(() => { void fetchItems(0, false) }, [])

  if (loading) return <div className="h-12 animate-pulse bg-glasshouse-well" />

  if (items.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400">Nothing read in the last seven days.</p>
        <p className="label-ui text-grey-300 mt-2">
          Anything you open in a reader appears here.
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
            {loadingMore ? 'Loading…' : 'Show more'}
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
  const { post, openedAt } = entry
  const isNative = post.origin.protocol === 'nostr'

  function open() {
    useLibraryOverlay.getState().close()
    if (isNative && post.dTag) {
      useReader.getState().openNative(post.dTag, {
        postId: post.id,
        preview: { title: post.body.title, summary: post.body.summary },
      })
    } else if (post.origin.uri) {
      useReader.getState().openExternal(post.origin.uri, {
        postId: post.id,
        title: post.body.title,
        siteName: post.origin.sourceName,
      })
    }
  }

  const openable = isNative ? !!post.dTag : !!post.origin.uri
  const title = post.body.title || post.body.summary || post.body.text || 'Untitled'

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
  return <>{info?.displayName ?? (info?.username ? `@${info.username}` : 'all.haus')}</>
}
