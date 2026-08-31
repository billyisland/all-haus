'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../../../../stores/auth'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { getPiece, type PieceDetail, type SourceWithBuckets } from '../../../../lib/traffology-api'
import { renderObservation } from '../../../../lib/traffology-templates'
import { FeedItem } from '../../../../components/traffology/FeedItem'
import { ProvenanceBar } from '../../../../components/traffology/ProvenanceBar'

export default function TraffologyPiecePage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const params = useParams()
  const pieceId = params.pieceId as string

  const [data, setData] = useState<PieceDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !user) router.push('/auth?mode=login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user || !pieceId) return
    let cancelled = false
    setLoading(true)
    getPiece(pieceId)
      .then(res => { if (!cancelled) setData(res) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [user, pieceId])

  if (authLoading || !user || loading) return <PieceSkeleton />
  if (!data) return <div className="py-20 text-center text-ui-sm text-grey-400">Piece not found.</div>

  const { piece, sources, observations } = data
  const rendered = observations.map(renderObservation)
  const maxReaders = Math.max(...sources.map(s => s.reader_count), 1)

  return (
    <div>
      {/* Back link */}
      <Link
        href="/traffology"
        className="btn-text-muted mb-6 inline-block"
      >
        &larr; Feed
      </Link>

      {/* Title */}
      <h1 className="font-serif text-[26px] font-bold italic text-black tracking-tight leading-tight mb-0.5">
        {piece.title}
      </h1>
      {piece.published_at && (
        <div className="text-ui-xs text-grey-300 mb-6">
          Published {new Date(piece.published_at).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'long', year: 'numeric',
          })}
        </div>
      )}

      {/* Summary strip */}
      <SummaryStrip piece={piece} />

      {/* Date readout for hover */}
      <div className="mt-6 h-[18px] flex justify-end items-baseline mb-2">
        <div
          className="text-[12px] font-semibold tracking-tight transition-opacity duration-75"
          style={{ color: 'var(--ah-klein-blue)', opacity: hoverInfo ? 1 : 0 }}
        >
          {hoverInfo || ''}
        </div>
      </div>

      {/* Provenance diagram */}
      <div className="flex flex-col">
        {sources.map(source => (
          <SourceRow
            key={source.source_id}
            source={source}
            maxReaders={maxReaders}
            totalReaders={piece.total_readers}
            isSelected={selectedSource === source.source_id}
            onSelect={() =>
              setSelectedSource(
                selectedSource === source.source_id ? null : source.source_id
              )
            }
            onHoverInfo={setHoverInfo}
          />
        ))}
      </div>

      {/* Filtered observation feed */}
      {rendered.length > 0 && (
        <div className="mt-9">
          <div className="border-t-[4px] border-black pt-2.5 mb-0.5">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-black">
              Story of this piece
            </div>
          </div>
          {rendered.map(obs => (
            <FeedItem key={obs.id} observation={obs} />
          ))}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Summary strip — 4-column stats bar
// =============================================================================

function SummaryStrip({ piece }: { piece: PieceDetail['piece'] }) {
  const rank = piece.rank_this_year
    ? `${ordinal(piece.rank_this_year)} this year`
    : piece.rank_all_time
    ? `${ordinal(piece.rank_all_time)} all time`
    : '\u2014'

  const topSource = piece.top_source_name
    ? `${piece.top_source_name}${piece.top_source_pct ? ` (${Math.round(piece.top_source_pct * 100)}%)` : ''}`
    : '\u2014'

  const items = [
    { label: 'Readers', value: (piece.total_readers ?? 0).toLocaleString() },
    { label: 'Rank', value: rank },
    { label: 'Top source', value: topSource },
    { label: 'Conversions', value: `${piece.paid_conversions ?? 0} paid` },
  ]

  return (
    <div className="grid grid-cols-4 border-t-[4px] border-b-[4px] border-black">
      {items.map((item, i) => (
        <div
          key={i}
          className={`py-3.5 px-2.5 ${i > 0 ? 'border-l-2 border-black' : ''}`}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-grey-400 mb-0.5">
            {item.label}
          </div>
          <div className="text-[17px] font-bold text-black tracking-tight">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// Source row — label + bar + count
// =============================================================================

function SourceRow({
  source,
  maxReaders,
  totalReaders,
  isSelected,
  onSelect,
  onHoverInfo,
}: {
  source: SourceWithBuckets
  maxReaders: number
  totalReaders: number
  isSelected: boolean
  onSelect: () => void
  onHoverInfo: (info: string | null) => void
}) {
  const pct = (source.reader_count / maxReaders) * 100

  return (
    <div>
      <div
        onClick={onSelect}
        className={`grid items-center cursor-pointer py-1 border-b border-grey-200 transition-colors ${
          isSelected ? 'bg-grey-100' : ''
        }`}
        style={{ gridTemplateColumns: '128px 1fr 46px' }}
      >
        {/* Label */}
        <div className="text-[12px] font-semibold text-black overflow-hidden text-ellipsis whitespace-nowrap pr-2 flex items-center gap-1.5">
          <span>{source.display_name}</span>
          {source.is_new_for_writer && (
            <span
              className="text-[8px] font-bold uppercase tracking-[0.1em] px-1 py-px leading-tight flex-shrink-0 border-[1.5px]"
              style={{ color: 'var(--ah-klein-blue)', borderColor: 'var(--ah-klein-blue)' }}
            >
              New
            </span>
          )}
        </div>

        {/* Bar */}
        <div className="relative h-6">
          <div
            className="absolute top-0 left-0 h-full overflow-hidden"
            style={{ width: `${Math.max(pct, 3)}%` }}
          >
            <ProvenanceBar
              buckets={source.buckets}
              height={24}
              onHoverInfo={onHoverInfo}
            />
          </div>
        </div>

        {/* Count */}
        <div className="text-[12px] font-bold text-black text-right tabular-nums">
          {source.reader_count.toLocaleString()}
        </div>
      </div>

      {/* Expanded detail */}
      {isSelected && (
        <div className="bg-grey-100 py-2.5 px-2.5 border-b border-grey-200" style={{ paddingLeft: 128 }}>
          <div className="text-[12px] text-grey-600 leading-relaxed">
            {source.reader_count} of {totalReaders} total readers
            ({Math.round((source.reader_count / totalReaders) * 100)}%).
            {source.is_new_for_writer && (
              <><br />This source has not sent you readers before.</>
            )}
            {source.source_type === 'mailing-list' && (
              <><br />Subscribers who opened the email and clicked through.</>
            )}
            {source.source_type === 'direct' && (
              <><br />Typed the URL, used a bookmark, or a source that doesn&rsquo;t pass referrer data.</>
            )}
            {source.bounce_rate > 0 && (
              <><br />Bounce rate: {Math.round(source.bounce_rate * 100)}%</>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function PieceSkeleton() {
  return (
    <div>
      <div className="h-8 w-64 animate-pulse bg-grey-100 mb-4" />
      <div className="h-4 w-40 animate-pulse bg-grey-100 mb-6" />
      <div className="grid grid-cols-4 border-t-[4px] border-b-[4px] border-black">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className={`py-3.5 px-2.5 ${i > 1 ? 'border-l-2 border-black' : ''}`}>
            <div className="h-3 w-16 animate-pulse bg-grey-100 mb-2" />
            <div className="h-5 w-20 animate-pulse bg-grey-100" />
          </div>
        ))}
      </div>
      <div className="mt-6 space-y-2">
        {[1, 2, 3, 4, 5].map(i => (
          <div key={i} className="h-8 animate-pulse bg-grey-100" />
        ))}
      </div>
    </div>
  )
}
