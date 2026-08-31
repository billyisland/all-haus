import { request } from './client'
import type { WorkspaceFeed } from './feeds'

// =============================================================================
// Follow-graph import runs (FOLLOW-GRAPH-IMPORT-ADR §7). POST reads the remote
// graph synchronously (allow a few seconds), mints the feed + run row, and the
// gateway sweep populates it in the background; GET is the progress poll.
// Which protocols are importable comes from the /linked-accounts capabilities
// block (`followImportProtocols`) — empty while the server flag is dark.
// =============================================================================

export type FollowImportProtocol =
  | 'atproto'
  | 'nostr_external'
  | 'activitypub'
  | 'rss'

export interface FollowImportRun {
  id: string
  protocol: FollowImportProtocol
  originIdentity: string
  feedId: string
  // 'sync' = a Phase 2 "Sync now" run; 'preview' = its unconfirmed plan.
  kind?: 'import' | 'sync'
  status: 'pending' | 'running' | 'done' | 'failed' | 'preview'
  total: number
  imported: number
  skipped: number
  failed: number
  removed?: number
  removalsTotal?: number
  error?: string | null
}

// The "Sync now" preview (Phase 2, ADR §11.5): the +N/−M plan awaiting
// confirmation, or the up-to-date verdict (no plan row minted). Removals are
// suppressed when the graph read hit the cap (removalsSkipped) — past it the
// server can't tell "unfollowed" from "outside the window".
export type FollowImportSyncPreview =
  | {
      upToDate: true
      feedId: string
      protocol: FollowImportProtocol
      originLabel: string
      removalsSkipped: boolean
    }
  | {
      upToDate: false
      id: string
      feedId: string
      protocol: FollowImportProtocol
      originIdentity: string
      originLabel: string
      adds: number
      removes: number
      addSample: string[]
      removeSample: string[]
      truncated: boolean
      remoteTotal: number
      cap: number
      removalsSkipped: boolean
    }

// The POST response additionally carries the origin label and the
// no-silent-caps truncation facts (§6.5) for the offer/summary copy.
// `unresolved` (AP only, rare): entries the graph read couldn't canonicalise
// to an account — dropped, but stated.
export interface FollowImportCreated extends FollowImportRun {
  originLabel: string
  remoteTotal: number
  truncated: boolean
  cap: number
  unresolved?: number
}

// Aggregate no-silent-caps facts for an OPML upload (§6.5): identity-cap
// truncation, folders folded into the base feed by the feed cap, and invalid
// entries dropped at parse time — the upload summary states them all.
export interface OpmlImportPlanSummary {
  totalEntries: number
  remoteTotal: number
  truncated: boolean
  cap: number
  foldedFolders: number
  invalidEntries: number
}

export const followImports = {
  create: (data: {
    protocol: FollowImportProtocol
    originIdentity: string
    feedName?: string
  }) =>
    request<{ import: FollowImportCreated; feed: WorkspaceFeed }>(
      '/follow-imports',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  // OPML upload (Phase 1d): folders map to one feed per folder under the
  // server's feed cap, so one upload can mint SEVERAL runs.
  createOpml: (data: { opml: string; feedName?: string }) =>
    request<{
      runs: { import: FollowImportCreated; feed: WorkspaceFeed }[]
      plan: OpmlImportPlanSummary
    }>('/follow-imports/opml', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  get: (id: string) =>
    request<{ import: FollowImportRun }>(`/follow-imports/${id}`),

  // Phase 2 "Sync now": preview the diff, then confirm (applies it via the
  // same background engine) or cancel the unconfirmed plan.
  syncPreview: (feedId: string) =>
    request<{ preview: FollowImportSyncPreview }>('/follow-imports/sync', {
      method: 'POST',
      body: JSON.stringify({ feedId }),
    }),

  confirmSync: (id: string) =>
    request<{ import: FollowImportRun }>(`/follow-imports/${id}/confirm`, {
      method: 'POST',
    }),

  cancelSync: (id: string) =>
    request<void>(`/follow-imports/${id}`, { method: 'DELETE' }),
}
