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
import * as C from '../../content/networks'

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
        {C.IMPORT_READING}
      </p>
    )
  }
  if (!run) return null

  const processed = run.imported + run.skipped + run.failed
  const feedName = feed?.name?.trim() || C.IMPORT_DEFAULT_FEED_NAME

  if (run.status === 'failed') {
    return (
      <p className="font-mono text-mono-xs text-red-600">
        {C.importFailed(run.error)}
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {run.status === 'done' ? (
        <p className="font-mono text-mono-xs text-grey-600">
          {C.importDone(run.imported, run.skipped, run.failed)}
        </p>
      ) : (
        <p className="font-mono text-mono-xs text-grey-600">
          {C.importProgress(processed, run.total)}
        </p>
      )}
      <p className="text-ui-xs text-grey-600 leading-relaxed">
        {run.status === 'done'
          ? C.importDoneSummary(feedName)
          : C.importRunningSummary(feedName)}
        {run.truncated &&
          C.importTruncated(run.total, run.remoteTotal)}
        {(run.unresolved ?? 0) > 0 &&
          C.importUnresolved(run.unresolved!)}
        {run.protocol === 'nostr_external' &&
          C.IMPORT_NOSTR_NAMES}
      </p>
    </div>
  )
}
