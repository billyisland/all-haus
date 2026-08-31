'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  followImports,
  type FollowImportCreated,
  type OpmlImportPlanSummary,
  type WorkspaceFeed,
} from '../lib/api'
import { apiErrorMessage } from '../lib/api/client'
import { useFeedArrivals } from '../stores/feedArrivals'

// =============================================================================
// useOpmlImport — start an OPML import and follow its progress (FOLLOW-GRAPH-
// IMPORT-ADR §5.4, Phase 1d). The multi-run sibling of useFollowImportRun:
// folders map to one feed per folder under the server's feed cap, so one
// upload mints SEVERAL runs, polled together until all are terminal. Every
// minted feed is announced to the live workspace via useFeedArrivals.
// =============================================================================

const POLL_MS = 2000

export interface UseOpmlImport {
  /** Upload the OPML text. Resolves true when the runs were created. No-op
   *  while an upload is starting or any run is still in flight. */
  start: (input: { opml: string; feedName?: string }) => Promise<boolean>
  starting: boolean
  runs: FollowImportCreated[]
  /** Minted feeds, keyed by feed id, for naming runs in the summary. */
  feeds: Record<string, WorkspaceFeed>
  plan: OpmlImportPlanSummary | null
  error: string | null
  reset: () => void
}

export function useOpmlImport(): UseOpmlImport {
  const [starting, setStarting] = useState(false)
  const [runs, setRuns] = useState<FollowImportCreated[]>([])
  const [feeds, setFeeds] = useState<Record<string, WorkspaceFeed>>({})
  const [plan, setPlan] = useState<OpmlImportPlanSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  const inFlight = runs.some(
    (r) => r.status === 'pending' || r.status === 'running',
  )

  const start = useCallback(
    async (input: { opml: string; feedName?: string }): Promise<boolean> => {
      if (starting || inFlight) return false
      setStarting(true)
      setError(null)
      try {
        const res = await followImports.createOpml(input)
        setRuns(res.runs.map((r) => r.import))
        setFeeds(
          Object.fromEntries(res.runs.map((r) => [r.feed.id, r.feed])),
        )
        setPlan(res.plan)
        const arrivals = useFeedArrivals.getState()
        res.runs.forEach((r) => arrivals.announce(r.feed))
        return true
      } catch (err) {
        setError(
          apiErrorMessage(err) ?? 'Could not read that file — try again.',
        )
        return false
      } finally {
        setStarting(false)
      }
    },
    [starting, inFlight],
  )

  useEffect(() => {
    if (!inFlight || starting) return
    const t = setInterval(() => {
      const pending = runs.filter(
        (r) => r.status === 'pending' || r.status === 'running',
      )
      void Promise.allSettled(
        pending.map((r) =>
          followImports.get(r.id).then(({ import: next }) => {
            setRuns((prev) =>
              prev.map((p) => (p.id === next.id ? { ...p, ...next } : p)),
            )
          }),
        ),
      )
      // Transient poll failures are ignored — the runs are server-side.
    }, POLL_MS)
    return () => clearInterval(t)
  }, [inFlight, starting, runs])

  const reset = useCallback(() => {
    setRuns([])
    setFeeds({})
    setPlan(null)
    setError(null)
    setStarting(false)
  }, [])

  return { start, starting, runs, feeds, plan, error, reset }
}
