'use client'

import { useState, useEffect } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { social, type MutedUser } from '../../lib/api'

export function MuteList() {
  const [mutes, setMutes] = useState<MutedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [unmuting, setUnmuting] = useState<string | null>(null)

  useEffect(() => {
    social.listMutes()
      .then(data => setMutes(data.mutes))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleUnmute(userId: string) {
    setUnmuting(userId)
    try {
      await social.unmute(userId)
      setMutes(prev => prev.filter(m => m.userId !== userId))
    } catch {}
    finally { setUnmuting(null) }
  }

  return (
    <div>
      <p className="label-ui text-grey-400 mb-4">Muted accounts</p>
      {loading ? (
        <div className="space-y-2">{[1, 2].map(i => <div key={i} className="h-10 animate-pulse bg-glasshouse-well" />)}</div>
      ) : mutes.length === 0 ? (
        <p className="text-ui-xs text-grey-300">No muted accounts.</p>
      ) : (
        <div className="bg-glasshouse-well divide-y divide-grey-200/50">
          {mutes.map(m => (
            <div key={m.userId} className="flex items-center justify-between px-4 py-3">
              <ProfileLink href={`/${m.username}`} className="text-ui-sm text-black hover:opacity-70">
                {m.displayName ?? m.username}
                <span className="text-grey-300 ml-1">@{m.username}</span>
              </ProfileLink>
              <button
                onClick={() => handleUnmute(m.userId)}
                disabled={unmuting === m.userId}
                className="btn-text-muted disabled:opacity-50"
              >
                {unmuting === m.userId ? '...' : 'Unmute'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
