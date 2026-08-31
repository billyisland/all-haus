'use client'

// =============================================================================
// FollowImportStatus — the shared progress/summary line for a follow-graph
// import run (FOLLOW-GRAPH-IMPORT-ADR §7). Rendered by all three import
// surfaces (post-link offer, NetworkReachPanel, FeedComposer), which all sit
// on fixed-light Glasshouse interiors, so the neutral tokens are correct here.
// The no-silent-caps rule (§6.5) lives in this component: truncation is stated
// whenever it happened, and the Nostr no-metadata caveat (D6) is said plainly.
// =============================================================================

import type { WorkspaceFeed } from '../../lib/api'
import type { UseFollowImportRun } from '../../hooks/useFollowImportRun'

export function FollowImportStatus({
  starting,
  run,
  feed,
  error,
}: {
  starting: boolean
  run: UseFollowImportRun['run']
  feed: WorkspaceFeed | null
  error: string | null
}) {
  if (error) {
    return <p className="font-mono text-mono-xs text-red-600">{error}</p>
  }
  if (starting) {
    return (
      <p className="font-mono text-mono-xs text-grey-600">
        READING FOLLOW LIST…
      </p>
    )
  }
  if (!run) return null

  const processed = run.imported + run.skipped + run.failed
  const feedName = feed?.name?.trim() || 'your new feed'

  if (run.status === 'failed') {
    return (
      <p className="font-mono text-mono-xs text-red-600">
        IMPORT FAILED{run.error ? ` — ${run.error}` : ''}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {run.status === 'done' ? (
        <p className="font-mono text-mono-xs text-grey-600">
          IMPORTED {run.imported}
          {run.skipped > 0 && ` · ${run.skipped} ALREADY PRESENT`}
          {run.failed > 0 && ` · ${run.failed} FAILED`}
        </p>
      ) : (
        <p className="font-mono text-mono-xs text-grey-600">
          IMPORTING {processed}/{run.total}…
        </p>
      )}
      <p className="text-ui-xs text-grey-600 leading-relaxed">
        {run.status === 'done'
          ? `“${feedName}” is in your workspace — retune, redistribute, or delete it like any feed.`
          : `Building “${feedName}” in your workspace — you can keep working while it fills.`}
        {run.truncated &&
          ` Imported the most recent ${run.total} of ${run.remoteTotal} follows; the rest stay on the origin network.`}
        {(run.unresolved ?? 0) > 0 &&
          ` ${run.unresolved} follows couldn't be matched to an account and were skipped.`}
        {run.protocol === 'nostr_external' &&
          ' Names fill in over the next few minutes as profiles arrive from relays.'}
      </p>
    </div>
  )
}
