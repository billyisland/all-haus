'use client'

import { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { trust, type MyVouch } from '../../lib/api'
import { Avatar } from '../ui/Avatar'

// =============================================================================
// VouchList — list of vouches by the authenticated user with withdraw buttons
//
// Renders on the Network page (/network?tab=vouches). Shows all active vouches
// grouped by subject, with dimension labels and withdraw action.
// =============================================================================

const DIMENSION_LABELS: Record<string, string> = {
  humanity: 'Humanity',
  encounter: 'Encounter',
  identity: 'Identity',
  integrity: 'Integrity',
}

export function VouchList() {
  const [vouches, setVouches] = useState<MyVouch[]>([])
  const [loading, setLoading] = useState(true)
  const [withdrawing, setWithdrawing] = useState<Set<string>>(new Set())

  useEffect(() => {
    trust.myVouches()
      .then(d => setVouches(d.vouches))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleWithdraw(id: string) {
    setWithdrawing(prev => new Set([...prev, id]))
    try {
      await trust.withdrawVouch(id)
      setVouches(prev => prev.filter(v => v.id !== id))
    } catch {
      // Withdrawal failed — remove from pending set
    } finally {
      setWithdrawing(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="flex items-center gap-4 py-4 animate-pulse">
            <div className="h-11 w-11 bg-grey-100 flex-shrink-0" />
            <div className="flex-1">
              <div className="h-3.5 w-32 bg-grey-100 mb-2 rounded" />
              <div className="h-3 w-20 bg-grey-100 rounded" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (vouches.length === 0) {
    return (
      <div className="py-20 text-center">
        <p className="text-ui-sm text-grey-400 mb-4">You haven't vouched for anyone yet.</p>
        <p className="text-ui-xs text-grey-300">
          Visit a writer's profile and click "Vouch" to endorse them.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {vouches.map(v => (
        <div key={v.id} className="flex items-center gap-4 py-4">
          <ProfileLink href={`/${v.subject.username}`} className="flex-shrink-0">
            <Avatar
              src={v.subject.avatar}
              name={v.subject.displayName ?? v.subject.username}
              size={44}
            />
          </ProfileLink>
          <div className="flex-1 min-w-0">
            <ProfileLink href={`/${v.subject.username}`} className="group">
              <p className="font-sans text-base font-medium text-black group-hover:opacity-75 transition-opacity truncate">
                {v.subject.displayName ?? v.subject.username}
              </p>
            </ProfileLink>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="label-ui text-grey-400">{DIMENSION_LABELS[v.dimension]}</span>
              <span className="label-ui text-grey-300">
                {v.visibility === 'public' ? 'PUBLIC' : 'AGGREGATE'}
              </span>
            </div>
          </div>
          <button
            onClick={() => handleWithdraw(v.id)}
            disabled={withdrawing.has(v.id)}
            className="btn-text-danger text-ui-xs flex-shrink-0 disabled:opacity-40"
          >
            {withdrawing.has(v.id) ? '...' : 'Withdraw'}
          </button>
        </div>
      ))}
    </div>
  )
}
