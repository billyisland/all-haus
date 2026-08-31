'use client'

import { useState } from 'react'
import { admin as adminApi, type Report } from '../../lib/api'
import { timeAgo } from '../../lib/format'

export function ReportCard({ report, onResolved }: { report: Report; onResolved: () => void }) {
  const [acting, setActing] = useState(false)
  const isResolved = report.status === 'resolved'

  async function handleAction(action: 'remove' | 'suspend' | 'dismiss') {
    const labels = { remove: 'Remove this content?', suspend: 'Suspend this account?', dismiss: 'Dismiss this report?' }
    if (!confirm(labels[action])) return
    setActing(true)
    try {
      await adminApi.resolveReport(report.id, action)
      onResolved()
    } catch { alert('Failed to take action.') }
    finally { setActing(false) }
  }

  return (
    <div className={`bg-glasshouse-well px-6 py-5 ${isResolved ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="label-ui text-grey-300">
              {report.targetType}
            </span>
            <span className="font-mono text-mono-xs text-grey-300">·</span>
            <span className="font-mono text-mono-xs text-grey-300">{timeAgo(report.createdAt)}</span>
            {isResolved && (
              <>
                <span className="font-mono text-mono-xs text-grey-300">·</span>
                <span className="label-ui text-grey-400">
                  {report.resolution}
                </span>
              </>
            )}
          </div>

          <p className="text-ui-sm text-black mb-1">
            Reported by <span className="font-semibold">{report.reporterDisplayName ?? report.reporterUsername}</span>
          </p>
          <p className="text-ui-xs text-grey-600 mb-2">{report.reason}</p>

          {report.contentPreview && (
            <div className="border-l-2 border-grey-200 pl-3 py-1">
              <p className="text-[13px] font-serif italic text-grey-600 line-clamp-3">{report.contentPreview}</p>
            </div>
          )}
        </div>
      </div>

      {!isResolved && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => handleAction('remove')}
            disabled={acting}
            className="btn-text-danger"
          >
            Remove content
          </button>
          <button
            onClick={() => handleAction('suspend')}
            disabled={acting}
            className="btn-text-muted"
          >
            Suspend user
          </button>
          <button
            onClick={() => handleAction('dismiss')}
            disabled={acting}
            className="btn-text-muted"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
