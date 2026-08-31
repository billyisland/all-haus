'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { getFeed, getConcurrent, type TraffologyObservation } from '../../lib/traffology-api'
import { renderObservation, type RenderedObservation } from '../../lib/traffology-templates'
import { FeedItem } from '../../components/traffology/FeedItem'

export default function TraffologyFeedPage() {
  const { user, loading: authLoading } = useAuth()
  const router = useRouter()
  const [observations, setObservations] = useState<RenderedObservation[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [concurrent, setConcurrent] = useState<{ total: number } | null>(null)

  useEffect(() => {
    if (!authLoading && !user) router.push('/auth?mode=login')
  }, [user, authLoading, router])

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function load() {
      try {
        const [feedRes, concRes] = await Promise.all([
          getFeed(),
          getConcurrent().catch(() => null),
        ])
        if (cancelled) return
        setObservations(feedRes.observations.map(renderObservation))
        setCursor(feedRes.nextCursor)
        if (concRes) setConcurrent(concRes)
      } catch {
        // non-fatal
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [user])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await getFeed(cursor)
      setObservations(prev => [
        ...prev,
        ...res.observations.map(renderObservation),
      ])
      setCursor(res.nextCursor)
    } catch {
      // non-fatal
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore])

  if (authLoading || !user) {
    return <FeedSkeleton />
  }

  if (loading) {
    return <FeedSkeleton />
  }

  return (
    <div>
      {/* Live reader count banner */}
      {concurrent && concurrent.total > 0 && (
        <div className="mb-6 py-3 border-t-[4px] border-b-[4px] border-black">
          <div className="label-ui text-grey-300 mb-1">
            Right now
          </div>
          <div className="text-ui-xs leading-relaxed text-black">
            {concurrent.total} {concurrent.total === 1 ? 'person' : 'readers'} on your site right now.
          </div>
        </div>
      )}

      {observations.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">
            No observations yet. Traffology will start generating observations
            once your pieces have session data.
          </p>
        </div>
      ) : (
        <>
          {observations.map((obs) => (
            <FeedItem key={obs.id} observation={obs} />
          ))}

          {cursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-6 btn-text-muted"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div className="space-y-4">
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} className="py-3 border-b-2 border-grey-200">
          <div className="h-3 w-24 animate-pulse bg-grey-100 mb-2" />
          <div className="h-4 w-full animate-pulse bg-grey-100" />
        </div>
      ))}
    </div>
  )
}
