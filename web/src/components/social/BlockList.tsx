'use client'

import { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { social, type BlockedUser } from '../../lib/api'

export function BlockList() {
  const [blocks, setBlocks] = useState<BlockedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [unblocking, setUnblocking] = useState<string | null>(null)

  useEffect(() => {
    social.listBlocks()
      .then(data => setBlocks(data.blocks))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleUnblock(userId: string) {
    setUnblocking(userId)
    try {
      await social.unblock(userId)
      setBlocks(prev => prev.filter(b => b.userId !== userId))
    } catch {}
    finally { setUnblocking(null) }
  }

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Blocked accounts</p>
      {loading ? (
        <div className="space-y-2">{[1, 2].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      ) : blocks.length === 0 ? (
        <p className="text-ui-xs text-grey-300">No blocked accounts.</p>
      ) : (
        <div className="bg-glasshouse-well divide-y divide-grey-200/50">
          {blocks.map(b => (
            <div key={b.userId} className="flex items-center justify-between px-4 py-3">
              <ProfileLink href={`/${b.username}`} className="text-ui-sm text-black hover:opacity-70">
                {b.displayName ?? b.username}
                <span className="text-grey-300 ml-1">@{b.username}</span>
              </ProfileLink>
              <button
                onClick={() => handleUnblock(b.userId)}
                disabled={unblocking === b.userId}
                className="btn-text-muted disabled:opacity-50"
              >
                {unblocking === b.userId ? '...' : 'Unblock'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
