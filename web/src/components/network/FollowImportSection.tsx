'use client'

// =============================================================================
// FollowImportSection — the paste-an-identity import path (FOLLOW-GRAPH-IMPORT
// -ADR §7.2, D8): any resolvable identity with a publicly readable graph can
// seed an import, no account link required. The input is omnivorous (universal
// resolver — handle, npub, NIP-05, DID, URL); resolved external accounts whose
// protocol the server can import offer "Import follows". The run hook is owned
// by the parent (NetworkReachPanel) so the per-presence "Import follows"
// affordance and this paste path share one at-a-time run + status area.
// =============================================================================

import { useRef, useState } from 'react'
import { useResolverInput } from '../../hooks/useResolverInput'
import type { MatchOption } from '../../lib/workspace/resolve'
import type { UseFollowImportRun } from '../../hooks/useFollowImportRun'
import { useOpmlImport } from '../../hooks/useOpmlImport'
import type { FollowImportProtocol } from '../../lib/api'
import { FollowImportStatus } from './FollowImportStatus'

export function FollowImportSection({
  importable,
  opml = false,
  followImport,
}: {
  importable: string[]
  /** Server capability gate for the OPML upload path (Phase 1d). */
  opml?: boolean
  followImport: UseFollowImportRun
}) {
  // `import` context (ADR §7.4): external-first ranking, and an exact native
  // username hit no longer short-circuits the external account whose graph
  // this surface actually needs.
  const ri = useResolverInput({ maxPolls: 3, context: 'import' })

  const isCandidate = (m: MatchOption) =>
    m.add.sourceType === 'external_source' &&
    'sourceUri' in m.add &&
    importable.includes(m.add.protocol)
  const candidates = ri.matches.filter(isCandidate)
  // Resolved fine, but to a network whose graph we can't read yet (1c/1d) or
  // to something graph-less — say so rather than showing nothing.
  const onlyUnimportable =
    !ri.pending && ri.matches.length > 0 && candidates.length === 0

  const busy =
    followImport.starting ||
    followImport.run?.status === 'pending' ||
    followImport.run?.status === 'running'

  async function handleImport(opt: MatchOption) {
    if (opt.add.sourceType !== 'external_source' || !('sourceUri' in opt.add))
      return
    const ok = await followImport.start({
      protocol: opt.add.protocol as FollowImportProtocol,
      originIdentity: opt.add.sourceUri,
    })
    if (ok) ri.reset()
  }

  return (
    <div>
      <p className="text-ui-sm text-black">Bring your follows</p>
      <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
        Already follow people elsewhere? Paste a Bluesky handle,
        {importable.includes('activitypub') && ' a Mastodon handle,'} an npub,
        or a NIP-05 address and all.haus builds a new feed from everyone that
        account follows. One-way: nothing changes on the other network.
      </p>
      <input
        type="text"
        value={ri.query}
        onChange={e => ri.onQueryChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ri.submit()
          }
        }}
        placeholder={
          importable.includes('activitypub')
            ? 'alice.bsky.social · @user@instance · npub1…'
            : 'alice.bsky.social · npub1… · name@domain.com'
        }
        className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm mt-3"
      />
      <div className="mt-2 space-y-1">
        {ri.resolving && (
          <p className="font-mono text-mono-xs text-grey-600">RESOLVING…</p>
        )}
        {(ri.doneEmpty || ri.resolveError) && (
          <p className="font-mono text-mono-xs text-grey-600">
            No match. Press Enter to search, or try a full handle, npub, or
            NIP-05 address.
          </p>
        )}
        {onlyUnimportable && (
          <p className="font-mono text-mono-xs text-grey-600">
            Found it, but importing follows isn&rsquo;t available for that
            network yet.
          </p>
        )}
        {candidates.map(opt => (
          <div
            key={opt.key}
            className="flex items-center justify-between gap-4"
          >
            <div className="min-w-0">
              <span className="text-ui-xs text-black truncate">
                {opt.label}
              </span>
              {opt.sublabel && (
                <span className="label-ui text-grey-600 ml-2">
                  {opt.sublabel}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleImport(opt)}
              disabled={busy}
              className="btn-text shrink-0"
            >
              Import follows
            </button>
          </div>
        ))}
        <FollowImportStatus
          starting={followImport.starting}
          run={followImport.run}
          feed={followImport.feed}
          error={followImport.error}
        />
      </div>
      {opml && <OpmlImportBlock />}
    </div>
  )
}

// -----------------------------------------------------------------------------
// OPML upload (Phase 1d, ADR §5.4): the RSS "follow graph" is the export file
// every feed reader produces. The file is previewed client-side purely for the
// confirmation copy (folders → feeds is the server's call, so the count is
// "up to"); on confirm the raw text goes up and one run per planned feed comes
// back, polled together. Per-run lines + the aggregate no-silent-caps facts
// (truncation, folded folders, invalid/dead entries) render below.
// -----------------------------------------------------------------------------

interface OpmlPreview {
  fileName: string
  text: string
  entries: number
  folders: number
}

function previewOpml(fileName: string, text: string): OpmlPreview | null {
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml')
    if (
      doc.querySelector('parsererror') ||
      doc.documentElement.tagName.toLowerCase() !== 'opml'
    )
      return null
    const outlines = Array.from(doc.getElementsByTagName('outline'))
    const hasUrl = (o: Element) =>
      o.getAttribute('xmlUrl') ?? o.getAttribute('xmlurl')
    const entries = outlines.filter(hasUrl).length
    const body = doc.querySelector('body')
    const folders = body
      ? Array.from(body.children).filter(
          (c) => c.tagName.toLowerCase() === 'outline' && !hasUrl(c),
        ).length
      : 0
    return { fileName, text, entries, folders }
  } catch {
    return null
  }
}

function OpmlImportBlock() {
  const opmlImport = useOpmlImport()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<OpmlPreview | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)

  const busy =
    opmlImport.starting ||
    opmlImport.runs.some(
      (r) => r.status === 'pending' || r.status === 'running',
    )
  const allDone =
    opmlImport.runs.length > 0 &&
    opmlImport.runs.every((r) => r.status === 'done' || r.status === 'failed')
  const anyFailedEntries = opmlImport.runs.some(
    (r) => r.status === 'done' && r.failed > 0,
  )
  const plan = opmlImport.plan

  async function handleFile(file: File) {
    setFileError(null)
    const text = await file.text()
    const preview = previewOpml(file.name, text)
    if (!preview) {
      setFileError(
        'Could not read that file as OPML — export a fresh copy from your reader and try again.',
      )
      return
    }
    if (preview.entries === 0) {
      setFileError('No feed URLs found in this file.')
      return
    }
    setPending(preview)
  }

  async function handleConfirm() {
    if (!pending) return
    const ok = await opmlImport.start({ opml: pending.text })
    if (ok) setPending(null)
  }

  return (
    <div className="mt-4">
      <p className="text-ui-xs text-grey-600 leading-relaxed">
        Coming from a feed reader instead? Upload its OPML export and your
        subscriptions arrive as feeds — one per folder.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".opml,.xml,text/xml,text/x-opml,application/xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void handleFile(f)
        }}
      />
      {!pending && (
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="btn-text mt-2"
        >
          Upload an OPML file
        </button>
      )}
      {pending && (
        <div className="mt-2">
          <p className="font-mono text-mono-xs text-grey-600">
            {pending.fileName.toUpperCase()} — {pending.entries} FEED URLS
            {pending.folders > 0 && ` IN ${pending.folders} FOLDERS`}
          </p>
          <p className="text-ui-xs text-grey-600 mt-1">
            This creates up to {Math.min(pending.folders + 1, 10)}{' '}
            {Math.min(pending.folders + 1, 10) === 1 ? 'feed' : 'feeds'} in
            your workspace.
          </p>
          <div className="flex items-center gap-4 mt-2">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className="btn-text"
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="btn-text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="mt-2 space-y-1">
        {opmlImport.error && (
          <p className="font-mono text-mono-xs text-red-600">
            {opmlImport.error}
          </p>
        )}
        {fileError && (
          <p className="font-mono text-mono-xs text-grey-600">{fileError}</p>
        )}
        {opmlImport.starting && (
          <p className="font-mono text-mono-xs text-grey-600">
            READING FILE…
          </p>
        )}
        {opmlImport.runs.map((run) => {
          const name =
            opmlImport.feeds[run.feedId]?.name?.trim() || 'Imported feeds'
          const processed = run.imported + run.skipped + run.failed
          return (
            <p key={run.id} className="font-mono text-mono-xs text-grey-600">
              &ldquo;{name}&rdquo; —{' '}
              {run.status === 'failed' ? (
                <span className="text-red-600">
                  FAILED{run.error ? ` — ${run.error}` : ''}
                </span>
              ) : run.status === 'done' ? (
                <>
                  {run.imported} IMPORTED
                  {run.skipped > 0 && ` · ${run.skipped} ALREADY PRESENT`}
                  {run.failed > 0 && ` · ${run.failed} FAILED`}
                </>
              ) : (
                <>
                  IMPORTING {processed}/{run.total}…
                </>
              )}
            </p>
          )
        })}
        {opmlImport.runs.length > 0 && (
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            {allDone
              ? 'Your imported feeds are in your workspace — retune, redistribute, or delete them like any feed.'
              : 'Building your feeds in the workspace — you can keep working while they fill.'}
            {plan?.truncated &&
              ` Imported the first ${plan.totalEntries} of ${plan.remoteTotal} feed URLs; re-import a smaller file for the rest.`}
            {(plan?.foldedFolders ?? 0) > 0 &&
              ` ${plan!.foldedFolders} extra folders were folded into the first feed.`}
            {(plan?.invalidEntries ?? 0) > 0 &&
              ` ${plan!.invalidEntries} entries were skipped (not valid feed URLs).`}
            {allDone &&
              anyFailedEntries &&
              ' Failed entries were dead or unreachable feeds — everything else came through.'}
          </p>
        )}
      </div>
    </div>
  )
}
