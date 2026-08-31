'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../../stores/auth'
import { admin as adminApi, type Report } from '../../../lib/api'
import { ReportCard } from '../../../components/admin/ReportCard'
import { AdminShell } from '../../../components/admin/AdminShell'

type ReportFilter = 'pending' | 'resolved' | 'all'

export default function AdminReportsPage() {
  const { user } = useAuth()
  const [reports, setReports] = useState<Report[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [filter, setFilter] = useState<ReportFilter>('pending')

  async function fetchReports() {
    setDataLoading(true)
    try {
      const statusParam = filter === 'all' ? undefined : filter
      const data = await adminApi.listReports(statusParam)
      setReports(data.reports)
    } catch {}
    finally { setDataLoading(false) }
  }

  useEffect(() => { if (user?.isAdmin) void fetchReports() }, [user, filter])

  return (
    <AdminShell title="Site owner" width="feed">
      {/* Filter tabs */}
      <div className="flex gap-2 mb-8">
        {(['pending', 'resolved', 'all'] as ReportFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`tab-pill ${filter === f ? 'tab-pill-active' : 'tab-pill-inactive'}`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {dataLoading ? (
        <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-24 animate-pulse bg-white" />)}</div>
      ) : reports.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-400">No {filter === 'all' ? '' : filter} reports.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reports.map(r => (
            <ReportCard key={r.id} report={r} onResolved={fetchReports} />
          ))}
        </div>
      )}
    </AdminShell>
  )
}
