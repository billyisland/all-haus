'use client'

import { useState } from 'react'
import { drives, type PledgeDrive } from '../../lib/api'

export function DriveCard({ drive, onUpdate }: { drive: PledgeDrive; onUpdate: () => void }) {
  const [acting, setActing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(drive.title)
  const [editDescription, setEditDescription] = useState(drive.description ?? '')
  const [editTarget, setEditTarget] = useState(
    drive.fundingTargetPence ? (drive.fundingTargetPence / 100).toFixed(2) : ''
  )
  const [editError, setEditError] = useState<string | null>(null)

  const target = drive.fundingTargetPence ?? 0
  const progressPct = target > 0
    ? Math.min(100, Math.round((drive.currentTotalPence / target) * 100))
    : 0

  async function handleCancel() {
    if (!confirm('Cancel this drive? Pledges will be released.')) return
    setActing(true)
    try { await drives.cancel(drive.id); onUpdate() }
    catch { alert('Failed to cancel drive.') }
    finally { setActing(false) }
  }

  async function handlePin() {
    setActing(true)
    try { await drives.togglePin(drive.id); onUpdate() }
    catch { alert('Failed to update pin.') }
    finally { setActing(false) }
  }

  async function handleSaveEdit() {
    const trimmedTitle = editTitle.trim()
    if (!trimmedTitle) { setEditError('Title is required.'); return }
    const pence = editTarget ? Math.round(parseFloat(editTarget) * 100) : undefined
    if (editTarget && (isNaN(pence!) || pence! <= 0)) { setEditError('Enter a valid target amount.'); return }

    setActing(true); setEditError(null)
    try {
      await drives.update(drive.id, {
        title: trimmedTitle,
        description: editDescription.trim() || undefined,
        fundingTargetPence: pence,
      })
      setEditing(false)
      onUpdate()
    } catch { setEditError('Failed to save changes.') }
    finally { setActing(false) }
  }

  const isActive = drive.status === 'open' || drive.status === 'funded'

  if (editing) {
    return (
      <div className="bg-glasshouse-well px-6 py-5 space-y-4">
        <p className="label-ui text-grey-400">Edit pledge drive</p>

        <div>
          <label className="block text-ui-xs font-medium text-grey-600 mb-1">Title</label>
          <input
            type="text"
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            className="w-full bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300"
          />
        </div>

        <div>
          <label className="block text-ui-xs font-medium text-grey-600 mb-1">Description</label>
          <textarea
            value={editDescription}
            onChange={e => setEditDescription(e.target.value)}
            className="w-full bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300 resize-y"
            rows={3}
          />
        </div>

        <div>
          <label className="block text-ui-xs font-medium text-grey-600 mb-1">Target amount (£)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={editTarget}
            onChange={e => setEditTarget(e.target.value)}
            className="w-48 bg-grey-100 px-3 py-2 text-ui-sm text-black placeholder-grey-300"
          />
        </div>

        {editError && <p className="text-ui-xs text-crimson">{editError}</p>}

        <div className="flex gap-3 pt-2">
          <button onClick={handleSaveEdit} disabled={acting} className="btn text-sm disabled:opacity-50">
            {acting ? 'Saving...' : 'Save'}
          </button>
          <button onClick={() => { setEditing(false); setEditError(null) }} className="text-ui-xs text-grey-400 hover:text-black">
            Cancel
          </button>
        </div>
      </div>
    )
  }

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
            <p className="font-mono text-mono-xs text-grey-300 uppercase tracking-[0.06em]">
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
      <p className="font-mono text-mono-xs text-grey-300 mt-1 uppercase tracking-[0.06em]">
        {target > 0 ? `${progressPct}% · ` : ''}{drive.pledgeCount} {drive.pledgeCount === 1 ? 'pledge' : 'pledges'}
      </p>

      {/* Actions */}
      {isActive && (
        <div className="mt-4 flex items-center gap-3">
          <button onClick={() => setEditing(true)} className="text-ui-xs text-grey-400 hover:text-black">
            Edit
          </button>
          <button onClick={handlePin} disabled={acting} className="text-ui-xs text-grey-400 hover:text-black disabled:opacity-50">
            {drive.pinned ? 'Unpin' : 'Pin to profile'}
          </button>
          <button onClick={handleCancel} disabled={acting} className="btn-text-muted disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
