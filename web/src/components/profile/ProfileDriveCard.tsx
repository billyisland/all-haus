'use client'

import { useState } from 'react'
import { drives, type PledgeDrive } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { formatDateFromISO } from '../../lib/format'

export function ProfileDriveCard({ drive }: { drive: PledgeDrive }) {
  const { user } = useAuth()
  const [showPledge, setShowPledge] = useState(false)
  const [pledgeAmount, setPledgeAmount] = useState('')
  const [pledging, setPledging] = useState(false)
  const [pledgeError, setPledgeError] = useState<string | null>(null)
  const [pledged, setPledged] = useState(false)

  const target = drive.fundingTargetPence ?? 0
  const progressPct = target > 0
    ? Math.min(100, Math.round((drive.currentTotalPence / target) * 100))
    : 0

  async function handlePledge(e: React.FormEvent) {
    e.preventDefault()
    const pence = Math.round(parseFloat(pledgeAmount) * 100)
    if (isNaN(pence) || pence < 1) { setPledgeError('Enter a valid amount.'); return }

    setPledging(true); setPledgeError(null)
    try {
      await drives.pledge(drive.id, pence)
      setPledged(true)
      setShowPledge(false)
    } catch {
      setPledgeError('Failed to pledge.')
    } finally {
      setPledging(false)
    }
  }

  const isActive = drive.status === 'open' || drive.status === 'funded'

  return (
    <div className="bg-glasshouse-well px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="label-ui text-grey-300">
              Pledge drive
            </span>
            {drive.pinned && (
              <span className="label-ui text-crimson">Pinned</span>
            )}
            <span className={`label-ui ${
              drive.status === 'funded' ? 'text-black' : drive.status === 'cancelled' ? 'text-grey-300' : 'text-grey-400'
            }`}>
              {drive.status}
            </span>
          </div>
          <p className="font-serif text-lg font-medium text-black">{drive.title}</p>
          {drive.description && (
            <p className="text-ui-sm text-grey-600 font-sans mt-1 line-clamp-2">{drive.description}</p>
          )}
        </div>

        <div className="text-right flex-shrink-0">
          <p className="font-serif text-lg text-black">
            £{(drive.currentTotalPence / 100).toFixed(2)}
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
      <div className="mt-1 flex items-center justify-between">
        <p className="label-ui text-grey-300">
          {target > 0 ? `${progressPct}% · ` : ''}{drive.pledgeCount} {drive.pledgeCount === 1 ? 'pledge' : 'pledges'}
        </p>
        <time className="label-ui text-grey-300">
          {formatDateFromISO(drive.createdAt)}
        </time>
      </div>

      {/* Pledge action */}
      {user && isActive && !pledged && (
        <div className="mt-3">
          {!showPledge ? (
            <button
              onClick={() => setShowPledge(true)}
              className="font-mono text-[12px] uppercase tracking-[0.04em] text-grey-400 hover:text-black transition-colors"
            >
              Pledge
            </button>
          ) : (
            <form onSubmit={handlePledge} className="flex items-center gap-2">
              <span className="text-ui-xs font-sans text-grey-400">£</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={pledgeAmount}
                onChange={(e) => setPledgeAmount(e.target.value)}
                placeholder="0.00"
                className="w-24 bg-grey-100 px-2 py-1 text-ui-xs font-sans text-black"
                autoFocus
              />
              <button type="submit" disabled={pledging} className="btn text-sm disabled:opacity-50">
                {pledging ? '…' : 'Pledge'}
              </button>
              <button type="button" onClick={() => setShowPledge(false)} className="text-[12px] font-sans text-grey-300 hover:text-black">
                Cancel
              </button>
            </form>
          )}
          {pledgeError && <p className="mt-1 text-[12px] font-sans text-crimson">{pledgeError}</p>}
        </div>
      )}
      {pledged && (
        <p className="mt-3 font-mono text-[12px] text-grey-400">Pledged — added to your tab.</p>
      )}
    </div>
  )
}
