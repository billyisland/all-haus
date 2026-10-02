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
import * as C from '../../content/networks'

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
      <p className="text-ui-sm text-black">{C.FOLLOW_IMPORT_TITLE}</p>
      <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
        {C.FOLLOW_IMPORT_INTRO_START}
        {importable.includes('activitypub') && C.FOLLOW_IMPORT_INTRO_MASTODON}
        {C.FOLLOW_IMPORT_INTRO_END}
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
            ? C.FOLLOW_IMPORT_PLACEHOLDER_WITH_MASTODON
            : C.FOLLOW_IMPORT_PLACEHOLDER
        }
        className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm mt-3"
      />
      <div className="mt-2 space-y-1">
        {ri.resolving && (
          <p className="font-mono text-mono-xs text-grey-600">{C.FOLLOW_IMPORT_RESOLVING}</p>
        )}
        {(ri.doneEmpty || ri.resolveError) && (
          <p className="font-mono text-mono-xs text-grey-600">
            {C.FOLLOW_IMPORT_NO_MATCH}
          </p>
        )}
        {onlyUnimportable && (
          <p className="font-mono text-mono-xs text-grey-600">
            {C.FOLLOW_IMPORT_UNIMPORTABLE}
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
              {C.FOLLOW_IMPORT_ACTION}
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
      setFileError(C.OPML_UNREADABLE)
      return
    }
    if (preview.entries === 0) {
      setFileError(C.OPML_NO_URLS)
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
        {C.OPML_INTRO}
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
          {C.OPML_UPLOAD}
        </button>
      )}
      {pending && (
        <div className="mt-2">
          <p className="font-mono text-mono-xs text-grey-600">
            {C.opmlFileSummary(pending.fileName, pending.entries, pending.folders)}
          </p>
          <p className="text-ui-xs text-grey-600 mt-1">
            {C.opmlCreatesUpTo(Math.min(pending.folders + 1, 10))}
          </p>
          <div className="flex items-center gap-4 mt-2">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className="btn-text"
            >
              {C.OPML_IMPORT}
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="btn-text-muted"
            >
              {C.OPML_CANCEL}
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
            {C.OPML_READING}
          </p>
        )}
        {opmlImport.runs.map((run) => {
          const name =
            opmlImport.feeds[run.feedId]?.name?.trim() || C.OPML_DEFAULT_FEED_NAME
          const processed = run.imported + run.skipped + run.failed
          return (
            <p key={run.id} className="font-mono text-mono-xs text-grey-600">
              {C.opmlRunLead(name)}
              {run.status === 'failed' ? (
                <span className="text-red-600">
                  {C.opmlRunFailed(run.error)}
                </span>
              ) : run.status === 'done' ? (
                C.opmlRunDone(run.imported, run.skipped, run.failed)
              ) : (
                C.importProgress(processed, run.total)
              )}
            </p>
          )
        })}
        {opmlImport.runs.length > 0 && (
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            {allDone
              ? C.OPML_DONE
              : C.OPML_RUNNING}
            {plan?.truncated &&
              C.opmlTruncated(plan.totalEntries, plan.remoteTotal)}
            {(plan?.foldedFolders ?? 0) > 0 &&
              C.opmlFolded(plan!.foldedFolders)}
            {(plan?.invalidEntries ?? 0) > 0 &&
              C.opmlInvalid(plan!.invalidEntries)}
            {allDone &&
              anyFailedEntries &&
              C.OPML_FAILED_ENTRIES}
          </p>
        )}
      </div>
    </div>
  )
}
