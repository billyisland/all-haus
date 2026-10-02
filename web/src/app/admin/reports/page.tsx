'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../../../stores/auth'
import { admin as adminApi, isResolved, type Report } from '../../../lib/api'
import { ReportCard } from '../../../components/admin/ReportCard'
import { PlatformBlocksPanel } from '../../../components/admin/PlatformBlocksPanel'
import { AdminShell } from '../../../components/admin/AdminShell'

// =============================================================================
// The moderation queue.
//
// THERE IS NO RESOLVED-ONLY QUERY, so the Resolved tab asks for everything and
// narrows here. That is a real cap rather than a tidy one: the route pages at
// `limit` (max 100), so a tree with more than 100 reports would silently show
// a slice of them — the page says so when the response comes back full rather
// than letting the list read as complete. A resolved-only filter on the route
// is the fix, and it belongs to the session that touches the gateway.
//
// The filter was `?status=pending|resolved`, a parameter the route has never
// read: all three tabs returned the open list, so Resolved showed open reports
// and All hid resolved ones.
// =============================================================================

type ReportFilter = 'open' | 'resolved' | 'all'

const FILTERS: ReadonlyArray<{ key: ReportFilter; label: string; empty: string }> = [
  { key: 'open', label: 'Open', empty: 'Nothing is waiting.' },
  { key: 'resolved', label: 'Resolved', empty: 'Nothing has been resolved yet.' },
  { key: 'all', label: 'All', empty: 'No reports.' },
]

/** The route's own ceiling (`parseLimit(req.query.limit, 50, 100)`). */
const PAGE_LIMIT = 100

export default function AdminReportsPage() {
  const { user } = useAuth()
  const [reports, setReports] = useState<Report[]>([])
  const [counts, setCounts] = useState<{ overdue: number; appeals: number } | null>(null)
  const [capped, setCapped] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataLoading, setDataLoading] = useState(true)
  const [filter, setFilter] = useState<ReportFilter>('open')

  const fetchReports = useCallback(async () => {
    setDataLoading(true)
    try {
      // 'open' is the route's default set (open + under_review); the other two
      // need every row, and 'resolved' narrows what comes back.
      const data = await adminApi.listReports({
        all: filter !== 'open',
        limit: PAGE_LIMIT,
      })
      setReports(
        filter === 'resolved'
          ? data.reports.filter((r) => isResolved(r.status))
          : data.reports
      )
      setCounts({ overdue: data.overdueCount, appeals: data.openAppealCount })
      setCapped(data.reports.length >= data.limit)
      setError(null)
    } catch {
      // An outage renders as an outage, never as an empty state.
      setError('Couldn’t load reports. Please reload the page to try again.')
    } finally {
      setDataLoading(false)
    }
  }, [filter])

  useEffect(() => {
    if (user?.isAdmin) void fetchReports()
  }, [user, fetchReports])

  return (
    <AdminShell title="Site owner" width="feed">
      <div className="flex gap-2 mb-8">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`tab-pill ${filter === f.key ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* THE TWO FACTS ABOUT THE QUEUE THAT ARE NOT ON ANY CARD. Both are
          counted in SQL over the whole table, not over the page — a figure
          about a source is computed from the source, never from what a filter
          left, which is the same rule the reading log's paging follows. An
          overdue count derived from the hundred rows on screen would read 0 on
          the day it mattered most. */}
      {!dataLoading && !error && counts !== null && (counts.overdue > 0 || counts.appeals > 0) && (
        <p className="-mt-4 mb-6 text-ui-xs">
          {counts.overdue > 0 && (
            <span className="text-crimson">
              {counts.overdue} report{counts.overdue === 1 ? ' is' : 's are'} past the
              triage deadline we publish.{' '}
            </span>
          )}
          {counts.appeals > 0 && (
            <span className="text-grey-600">
              {counts.appeals} appeal{counts.appeals === 1 ? '' : 's'} waiting — seven days each.
            </span>
          )}
        </p>
      )}

      {error ? (
        <div className="bg-glasshouse-well px-4 py-3 text-ui-sm text-black">{error}</div>
      ) : dataLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse bg-white" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">
            {FILTERS.find((f) => f.key === filter)!.empty}
          </p>
        </div>
      ) : (
        <>
          {capped && (
            <p className="mb-4 text-ui-xs text-grey-400">
              Showing the most recent {PAGE_LIMIT} reports — there may be older ones.
            </p>
          )}
          <div className="space-y-2">
            {reports.map((r) => (
              <ReportCard key={r.id} report={r} onResolved={() => void fetchReports()} />
            ))}
          </div>
        </>
      )}

      {/* The remedy for everything the queue cannot remove (D7 §7): an item we
          ingested is not ours to take down, so the operator blocks its source
          or its author instead. It lives under the queue because that is where
          the refusal sends them. */}
      <PlatformBlocksPanel />
    </AdminShell>
  )
}
