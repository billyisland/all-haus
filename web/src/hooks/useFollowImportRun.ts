'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  followImports,
  type FollowImportCreated,
  type FollowImportProtocol,
  type WorkspaceFeed,
} from '../lib/api'
import { apiErrorMessage } from '../lib/api/client'
import { useFeedArrivals } from '../stores/feedArrivals'

// =============================================================================
// useFollowImportRun — start a follow-graph import and follow its progress
// (FOLLOW-GRAPH-IMPORT-ADR §7). One shared shape for the three surfaces
// (post-link offer, NetworkReachPanel, FeedComposer): `start` POSTs the run
// (the gateway reads the remote graph synchronously — allow seconds), the
// minted feed is announced to the live workspace via useFeedArrivals, and the
// run is polled until terminal. Render with <FollowImportStatus>.
// =============================================================================

const POLL_MS = 2000

// The polled GET lacks the create-time-only fields (originLabel, truncation),
// so the live run keeps the created shape and merges progress into it.
export interface UseFollowImportRun {
  /** Kick off a run. Resolves true when the run was created. No-op while one
   *  is starting or in flight. */
  start: (input: {
    protocol: FollowImportProtocol
    originIdentity: string
    feedName?: string
  }) => Promise<boolean>
  starting: boolean
  run: FollowImportCreated | null
  /** The feed the run minted, for naming it in the summary. */
  feed: WorkspaceFeed | null
  error: string | null
  reset: () => void
}

export function useFollowImportRun(): UseFollowImportRun {
  const [starting, setStarting] = useState(false)
  const [run, setRun] = useState<FollowImportCreated | null>(null)
  const [feed, setFeed] = useState<WorkspaceFeed | null>(null)
  const [error, setError] = useState<string | null>(null)

  const active =
    starting || run?.status === 'pending' || run?.status === 'running'

  const start = useCallback(
    async (input: {
      protocol: FollowImportProtocol
      originIdentity: string
      feedName?: string
    }): Promise<boolean> => {
      if (starting || run?.status === 'pending' || run?.status === 'running')
        return false
      setStarting(true)
      setError(null)
      try {
        const res = await followImports.create(input)
        setRun(res.import)
        setFeed(res.feed)
        useFeedArrivals.getState().announce(res.feed)
        return true
      } catch (err) {
        setError(
          apiErrorMessage(err) ?? 'Could not read the follow list — try again.',
        )
        return false
      } finally {
        setStarting(false)
      }
    },
    [starting, run?.status],
  )

  const runId = run?.id ?? null
  useEffect(() => {
    if (!runId || !active || starting) return
    const t = setInterval(() => {
      followImports
        .get(runId)
        .then(({ import: next }) =>
          setRun((prev) =>
            prev && prev.id === runId ? { ...prev, ...next } : prev,
          ),
        )
        .catch(() => {
          // Transient poll failure — keep polling; the run is server-side.
        })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [runId, active, starting])

  const reset = useCallback(() => {
    setRun(null)
    setFeed(null)
    setError(null)
    setStarting(false)
  }, [])

  return { start, starting, run, feed, error, reset }
}
