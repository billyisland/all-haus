'use client'

import { useState, useEffect, useCallback } from 'react'
import { ProfileLink } from '../ui/ProfileLink'
import { apiErrorMessage } from '../../lib/api/client'
import {
  BLOCKS_LOAD_FAILED, BLOCKS_EMPTY, BLOCKS_UNBLOCK, BLOCKS_UNBLOCK_FAILED, SETTINGS_RETRY,
} from '../../content/settings'
import { social, type BlockedUser } from '../../lib/api'

// =============================================================================
// BlockList — the accounts this member has blocked, and the way to undo one.
//
// A SETTINGS SECTION, not a tab. It lived on the Network page behind a tab
// pill, but it had always been written in this register — a mono label over a
// well of rows with a text-button each — which is why that page had to wrap it
// in a second well to make it look like a tab panel. With Network dissolved
// (2026-09-15) it renders BARE CONTENT: `SettingsSection` owns the label and
// the card, as it does for every other section in SettingsPanel, so the
// component no longer draws a heading of its own.
// =============================================================================

export function BlockList() {
  const [blocks, setBlocks] = useState<BlockedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [unblocking, setUnblocking] = useState<string | null>(null)

  // A load that FAILED is not an empty list, and an undo that failed is not a
  // success: both used to be swallowed, so an outage read as "No blocked accounts"
  // and a refused unblock left the row standing with nothing said (W2).
  const [loadFailed, setLoadFailed] = useState(false)
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadFailed(false)
    social.listBlocks()
      .then(data => setBlocks(data.blocks))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function handleUnblock(userId: string) {
    setUnblocking(userId)
    setRowError(null)
    try {
      await social.unblock(userId)
      setBlocks(prev => prev.filter(b => b.userId !== userId))
    } catch (err) {
      setRowError({ userId, message: apiErrorMessage(err) ?? BLOCKS_UNBLOCK_FAILED })
    }
    finally { setUnblocking(null) }
  }

  return (
    <div>
      {loading ? (
        <div className="space-y-0.5">{[1, 2].map(i => <div key={i} className="h-11 animate-pulse bg-glasshouse-well" />)}</div>
      ) : loadFailed ? (
        <p className="text-ui-xs text-grey-600">
          {BLOCKS_LOAD_FAILED}{' '}
          <button onClick={load} className="btn-text-muted">{SETTINGS_RETRY}</button>
        </p>
      ) : blocks.length === 0 ? (
        <p className="text-ui-xs text-grey-600">{BLOCKS_EMPTY}</p>
      ) : (
        <div className="space-y-0.5">
          {blocks.map(b => (
            <div key={b.userId} className="bg-glasshouse-well flex items-center justify-between px-4 py-3">
              <ProfileLink href={`/${b.username}`} className="text-ui-sm text-black hover:opacity-70">
                {b.displayName ?? b.username}
                <span className="text-grey-600 ml-1">@{b.username}</span>
              </ProfileLink>
              <span className="flex items-center gap-3">
                {rowError?.userId === b.userId && (
                  <span role="alert" className="text-ui-xs text-crimson">{rowError.message}</span>
                )}
                <button
                  onClick={() => handleUnblock(b.userId)}
                  disabled={unblocking === b.userId}
                  className="btn-text-muted disabled:opacity-50"
                >
                  {unblocking === b.userId ? '…' : BLOCKS_UNBLOCK}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
