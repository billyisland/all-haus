'use client'

import { useState, useEffect, useCallback } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { apiErrorMessage } from '../../lib/api/client'
import {
  MUTES_LOAD_FAILED, MUTES_EMPTY, MUTES_UNMUTE, MUTES_UNMUTE_FAILED, SETTINGS_RETRY,
} from '../../content/settings'
import { social, type MutedUser } from '../../lib/api'

// Muted accounts — the quieter half of BlockList, and the same shape: bare
// content for a `SettingsSection`, which owns the label and the card. See
// BlockList's header for why neither draws a heading of its own any more.

export function MuteList() {
  const [mutes, setMutes] = useState<MutedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [unmuting, setUnmuting] = useState<string | null>(null)

  // A load that FAILED is not an empty list, and an undo that failed is not a
  // success: both used to be swallowed, so an outage read as "No muted accounts"
  // and a refused unmute left the row standing with nothing said (W2).
  const [loadFailed, setLoadFailed] = useState(false)
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadFailed(false)
    social.listMutes()
      .then(data => setMutes(data.mutes))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleUnmute(userId: string) {
    setUnmuting(userId)
    setRowError(null)
    try {
      await social.unmute(userId)
      setMutes(prev => prev.filter(m => m.userId !== userId))
    } catch (err) {
      setRowError({ userId, message: apiErrorMessage(err) ?? MUTES_UNMUTE_FAILED })
    }
    finally { setUnmuting(null) }
  }

  return (
    <div>
      {loading ? (
        <div className="space-y-0.5">{[1, 2].map(i => <div key={i} className="h-11 animate-pulse bg-glasshouse-well" />)}</div>
      ) : loadFailed ? (
        <p className="text-ui-xs text-grey-600">
          {MUTES_LOAD_FAILED}{' '}
          <button onClick={load} className="btn-text-muted">{SETTINGS_RETRY}</button>
        </p>
      ) : mutes.length === 0 ? (
        <p className="text-ui-xs text-grey-600">{MUTES_EMPTY}</p>
      ) : (
        <div className="space-y-0.5">
          {mutes.map(m => (
            <div key={m.userId} className="bg-glasshouse-well flex items-center justify-between px-4 py-3">
              <ProfileLink href={`/${m.username}`} className="text-ui-sm text-black hover:opacity-70">
                {m.displayName ?? m.username}
                <span className="text-grey-600 ml-1">@{m.username}</span>
              </ProfileLink>
              <span className="flex items-center gap-3">
                {rowError?.userId === m.userId && (
                  <span role="alert" className="text-ui-xs text-crimson">{rowError.message}</span>
                )}
                <button
                  onClick={() => handleUnmute(m.userId)}
                  disabled={unmuting === m.userId}
                  className="btn-text-muted disabled:opacity-50"
                >
                  {unmuting === m.userId ? '…' : MUTES_UNMUTE}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
