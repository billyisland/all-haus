'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../../../stores/auth'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getOverview, type OverviewResponse, type OverviewPiece } from '../../../lib/traffology-api'
import { ProvenanceBar } from '../../../components/traffology/ProvenanceBar'

type SortKey = 'date' | 'readers' | 'sources'

export default function TraffologyOverviewPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('date')

  useEffect(() => {
    if (!authLoading && !user) router.push('/auth?mode=login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    getOverview()
      .then(res => { if (!cancelled) setData(res) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user])

  const sortedPieces = useMemo(() => {
    if (!data) return []
    const pieces = [...data.pieces]
    switch (sort) {
      case 'readers':
        return pieces.sort((a, b) => (b.total_readers ?? 0) - (a.total_readers ?? 0))
      case 'sources':
        // Sort by number of distinct source_ids in buckets
        return pieces.sort((a, b) => {
          const sa = new Set(a.buckets.map(bk => bk.source_id)).size
          const sb = new Set(b.buckets.map(bk => bk.source_id)).size
          return sb - sa
        })
      case 'date':
      default:
        return pieces.sort((a, b) => {
          const da = a.published_at ? new Date(a.published_at).getTime() : 0
          const db = b.published_at ? new Date(b.published_at).getTime() : 0
          return db - da
        })
    }
  }, [data, sort])

  if (authLoading || !user || loading) return <OverviewSkeleton />
  if (!data) return <div className="py-20 text-center text-ui-sm text-grey-400">No data yet.</div>

  const { baseline, topics } = data

  return (
    <div>
      {/* Baseline summary */}
      {baseline && (
        <div className="grid grid-cols-4 border-t-[4px] border-b-[4px] border-black mb-8">
          {[
            { label: 'Avg first day', value: Math.round(baseline.mean_first_day_readers).toLocaleString() },
            { label: 'Free subs', value: baseline.total_free_subscribers.toLocaleString() },
            { label: 'Paying subs', value: baseline.total_paying_subscribers.toLocaleString() },
            { label: 'Revenue (month)', value: `\u00a3${parseFloat(baseline.monthly_revenue).toFixed(2)}` },
          ].map((item, i) => (
            <div
              key={i}
              className={`py-3.5 px-2.5 ${i > 0 ? 'border-l-2 border-black' : ''}`}
            >
              <div className="label-ui text-grey-400 mb-0.5">
                {item.label}
              </div>
              <div className="font-mono text-lg font-bold text-black tracking-tight tabular-nums">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sort controls */}
      <div className="flex items-center gap-3 mb-4">
        <span className="text-ui-xs text-grey-400">Sort:</span>
        {(['date', 'readers', 'sources'] as SortKey[]).map(key => (
          <button
            key={key}
            onClick={() => setSort(key)}
            className={`text-ui-xs ${
              sort === key
                ? 'text-black font-medium'
                : 'text-grey-400 hover:text-black'
            }`}
          >
            {key === 'date' ? 'Date' : key === 'readers' ? 'Readers' : 'Source diversity'}
          </button>
        ))}
      </div>

      {/* Piece grid */}
      {sortedPieces.length === 0 ? (
        <div className="py-20 text-center text-ui-sm text-grey-400">
          No pieces yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sortedPieces.map(piece => (
            <PieceTile key={piece.id} piece={piece} />
          ))}
        </div>
      )}

      {/* Topics */}
      {topics.length > 0 && (
        <div className="mt-10">
          <div className="border-t-[4px] border-black pt-2.5 mb-4">
            <div className="label-ui font-bold text-black">
              Topic performance
            </div>
          </div>
          <div className="space-y-1">
            {topics.map(t => (
              <div key={t.topic} className="flex items-center justify-between py-2 border-b border-grey-200">
                <div className="text-ui-xs text-black font-medium">{t.topic}</div>
                <div className="text-ui-xs text-grey-400 tabular-nums">
                  {t.piece_count} pieces &middot; {Math.round(t.mean_readers)} avg readers
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Piece tile — miniature provenance bar + stats
// =============================================================================

function PieceTile({ piece }: { piece: OverviewPiece }) {
  return (
    <Link
      href={`/traffology/piece/${piece.id}`}
      className="block bg-white p-4 hover:bg-grey-100 transition-colors"
    >
      <div className="text-ui-xs font-medium text-black mb-1 truncate">
        {piece.title}
      </div>
      {piece.published_at && (
        <div className="text-mono-xs text-grey-300 mb-3">
          {new Date(piece.published_at).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric',
          })}
        </div>
      )}

      {/* Miniature provenance bar */}
      <div className="mb-3">
        {piece.buckets.length > 0 ? (
          <ProvenanceBar buckets={piece.buckets} height={16} />
        ) : (
          <div className="h-4 bg-grey-100" />
        )}
      </div>

      <div className="flex items-center justify-between text-mono-xs text-grey-400 tabular-nums">
        <span>{(piece.total_readers ?? 0).toLocaleString()} readers</span>
        <span>
          {piece.top_source_name
            ? `${piece.top_source_name} (${piece.top_source_pct ? Math.round(piece.top_source_pct * 100) : 0}%)`
            : '\u2014'}
        </span>
      </div>
    </Link>
  )
}

function OverviewSkeleton() {
  return (
    <div>
      <div className="grid grid-cols-4 border-t-[4px] border-b-[4px] border-black mb-8">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className={`py-3.5 px-2.5 ${i > 1 ? 'border-l-2 border-black' : ''}`}>
            <div className="h-3 w-16 animate-pulse bg-grey-100 mb-2" />
            <div className="h-5 w-20 animate-pulse bg-grey-100" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="bg-white p-4">
            <div className="h-4 w-40 animate-pulse bg-grey-100 mb-2" />
            <div className="h-3 w-24 animate-pulse bg-grey-100 mb-3" />
            <div className="h-4 animate-pulse bg-grey-100 mb-3" />
            <div className="h-3 w-full animate-pulse bg-grey-100" />
          </div>
        ))}
      </div>
    </div>
  )
}
