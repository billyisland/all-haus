'use client'

import { useState, useEffect } from 'react'
import { drives as drivesApi, type Commission } from '../../lib/api'

export function CommissionsTab() {
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [loading, setLoading] = useState(true)

  async function fetchCommissions() {
    setLoading(true)
    try {
      const data = await drivesApi.myCommissions()
      setCommissions(data.commissions)
    } catch {}
    finally { setLoading(false) }
  }

  useEffect(() => { void fetchCommissions() }, [])

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => <div key={i} className="h-24 animate-pulse bg-glasshouse-well" />)}
      </div>
    )
  }

  if (commissions.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-600">No commission requests yet.</p>
      </div>
    )
  }

  const pending = commissions.filter(c => !c.acceptedAt && c.status === 'open')
  const accepted = commissions.filter(c => c.acceptedAt && ['open', 'funded'].includes(c.status))
  const other = commissions.filter(c => !pending.includes(c) && !accepted.includes(c))

  return (
    <div>
      {pending.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-600 mb-4">Pending</p>
          <div className="space-y-2">
            {pending.map(c => <CommissionCard key={c.id} commission={c} onUpdate={fetchCommissions} />)}
          </div>
        </div>
      )}

      {accepted.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-600 mb-4">Accepted</p>
          <div className="space-y-2">
            {accepted.map(c => <CommissionCard key={c.id} commission={c} onUpdate={fetchCommissions} />)}
          </div>
        </div>
      )}

      {other.length > 0 && (
        <div className="mb-8">
          <p className="label-ui text-grey-600 mb-4">Completed &amp; declined</p>
          <div className="space-y-2">
            {other.map(c => <CommissionCard key={c.id} commission={c} onUpdate={fetchCommissions} />)}
          </div>
        </div>
      )}
    </div>
  )
}

export function CommissionCard({ commission: c, onUpdate }: { commission: Commission; onUpdate: () => void }) {
  const [acting, setActing] = useState(false)
  const [confirmDecline, setConfirmDecline] = useState(false)

  const isPending = !c.acceptedAt && c.status === 'open'
  const isAccepted = !!c.acceptedAt && ['open', 'funded'].includes(c.status)

  async function handleAccept() {
    setActing(true)
    try { await drivesApi.accept(c.id); onUpdate() }
    catch { alert('Failed to accept commission.') }
    finally { setActing(false) }
  }

  async function handleDecline() {
    if (!confirmDecline) {
      setConfirmDecline(true)
      setTimeout(() => setConfirmDecline(false), 3000)
      return
    }
    setActing(true)
    try { await drivesApi.decline(c.id); onUpdate() }
    catch { alert('Failed to decline commission.') }
    finally { setActing(false) }
  }

  const target = c.fundingTargetPence ?? 0
  const progressPct = target > 0
    ? Math.min(100, Math.round((c.currentTotalPence / target) * 100))
    : 0

  return (
    <div className="bg-glasshouse-well px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="label-ui text-grey-300">
              Commission from @{c.commissioner.username}
            </span>
            {isAccepted && (
              <span className="label-ui text-black">Accepted</span>
            )}
            {c.status === 'cancelled' && (
              <span className="label-ui text-grey-300">Declined</span>
            )}
            {c.status === 'published' && (
              <span className="label-ui text-black">Published</span>
            )}
            {c.status === 'fulfilled' && (
              <span className="label-ui text-black">Fulfilled</span>
            )}
          </div>
          <p className="font-serif text-lg font-medium text-black">{c.title}</p>
          {c.description && (
            <p className="text-ui-sm text-grey-600 font-sans mt-1 line-clamp-2">{c.description}</p>
          )}
        </div>

        <div className="text-right flex-shrink-0">
          <p className="font-serif text-lg text-black">
            £{(c.currentTotalPence / 100).toFixed(2)}
          </p>
          {target > 0 && (
            <p className="label-ui text-grey-300">
              of £{(target / 100).toFixed(2)}
            </p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {target > 0 && (
        <div className="mt-3 h-1.5 bg-grey-100 w-full">
          <div
            className="h-full bg-crimson transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}
      <p className="label-ui text-grey-300 mt-1">
        {target > 0 ? `${progressPct}% · ` : ''}{c.pledgeCount} {c.pledgeCount === 1 ? 'pledge' : 'pledges'}
        {c.deadline && ` · due ${new Date(c.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
      </p>

      {/* Actions */}
      {isPending && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={handleAccept} disabled={acting} className="btn text-sm disabled:opacity-50">
            {acting ? '...' : 'Accept'}
          </button>
          <button
            onClick={handleDecline}
            disabled={acting}
            className={`text-ui-xs font-sans transition-colors disabled:opacity-50 ${confirmDecline ? 'text-crimson font-medium' : 'text-grey-300 hover:text-black'}`}
          >
            {acting ? '...' : confirmDecline ? 'Confirm decline?' : 'Decline'}
          </button>
        </div>
      )}
    </div>
  )
}
