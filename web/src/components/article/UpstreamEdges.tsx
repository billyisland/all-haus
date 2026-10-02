'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  upstreamEdges,
  upstreamEdgesEnabled,
  resolver,
  tributes as tributesApi,
  tributesEnabled,
  type CreditEdge,
  type CitationEdge,
  type ViewerDispute,
  type TributeView,
} from '../../lib/api'
import { ApiError } from '../../lib/api/client'
import { useAuth } from '../../stores/auth'
import { useCitationDraft, type CitationDraft } from '../../stores/citationDraft'
import { clearMarkers, excerptMatchesAt, insertMarkerAt, MARKER_CLASS } from '../../lib/citation-anchor'
import { ProfileLink } from '../ui/ProfileLink'

// =============================================================================
// Upstream Edges — piece-foot apparatus (UPSTREAM-EDGES-ADR, Phase 1)
//
// Renders a piece's CREDITS (acknowledged debts, with any disclaimers adjacent)
// and CITATIONS ("X argues Y", with the pinned excerpt and disputes) as an
// endnote block at the foot of the article, ahead of replies.
//
// Authoring (Phase 1 follow-up): the piece author gets inline "Add credit" /
// "Add citation" composers; any signed-in reader can dispute a credit/citation
// and withdraw their own dispute. A third-party dispute holds a refundable £5
// stake on the disputant's reading tab (the cited/credited party stakes nothing).
//
// The reader is the fixed-light surface (no per-feed palette in scope), so this
// follows the reader's own grey idiom + .label-ui — never per-feed palette
// fields. No single-pixel lines: separation is whitespace, emphasis the 4px slab;
// text fields are the inset bg-glasshouse-well.
//
// Inline-in-prose citation marker (shipped 2026-06-23): a citation anchored to a
// span (char_start) draws a numbered superscript marker in the body, jumping to
// its entry in this apparatus. Injection is imperative (the body is
// dangerouslySetInnerHTML) via web/src/lib/citation-anchor.ts; authoring captures
// the offset from the author's text selection (QuoteSelector "Cite" → the
// citationDraft store → the composer below). Unanchored citations (manual add,
// no selection) still list at the foot without a marker.
// =============================================================================

export function UpstreamEdges({
  articleDbId,
  isAuthor = false,
  articleBodyRef,
  bodyHtml,
}: {
  articleDbId?: string
  isAuthor?: boolean
  // The rendered free-body element + its HTML, so anchored citations can inject
  // their in-prose markers. The HTML string is a dependency: React replaces the
  // body's innerHTML when it changes, wiping markers, so we re-inject on change.
  articleBodyRef?: RefObject<HTMLDivElement | null>
  bodyHtml?: string
}) {
  const { user } = useAuth()
  const [credits, setCredits] = useState<CreditEdge[]>([])
  const [citations, setCitations] = useState<CitationEdge[]>([])
  const [tributeList, setTributeList] = useState<TributeView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [addingCredit, setAddingCredit] = useState(false)
  const [addingCitation, setAddingCitation] = useState(false)
  const [addingTribute, setAddingTribute] = useState(false)

  // Both layers ship dark (suspended 2026-08-25 by operator directive): the
  // whole apparatus behind edgesOn, the money edge additionally behind
  // tributesOn. When edgesOn is false this component fetches nothing and
  // renders nothing (after the hooks — an early return above them would trip
  // rules-of-hooks).
  const edgesOn = upstreamEdgesEnabled()
  const tributesOn = tributesEnabled()

  const draft = useCitationDraft((s) => s.draft)
  const clearDraft = useCitationDraft((s) => s.clear)
  const citationComposerRef = useRef<HTMLDivElement>(null)
  const tributeComposerRef = useRef<HTMLDivElement>(null)
  // When a tribute is composed FROM a citation (Phase-4 composition), the
  // composer opens seeded with the cited source as the payee + the link recorded.
  const [tributeSeed, setTributeSeed] = useState<{
    target: string
    citationEdgeId: string
    citationNum: number
  } | null>(null)
  // Phase-5 chains: when an inspirer chooses "Accept & pass a share upstream",
  // we consent then open a child composer seeded with the parent context.
  const [chainSeed, setChainSeed] = useState<{
    parentTributeId: string
    parentPercentageBps: number
  } | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const load = useCallback(async () => {
    if (!articleDbId || !edgesOn) return
    const [c, q, t] = await Promise.all([
      upstreamEdges.getCredits(articleDbId).catch(() => ({ credits: [] })),
      upstreamEdges.getCitations(articleDbId).catch(() => ({ citations: [] })),
      tributesOn
        ? tributesApi.getForArticle(articleDbId).catch(() => ({ tributes: [] as TributeView[] }))
        : Promise.resolve({ tributes: [] as TributeView[] }),
    ])
    if (!aliveRef.current) return
    setCredits(c.credits)
    setCitations(q.citations)
    setTributeList(t.tributes)
    setLoaded(true)
  }, [articleDbId, edgesOn, tributesOn])

  useEffect(() => {
    void load()
  }, [load])

  // A selection-captured draft (from the body's "Cite" affordance) opens the
  // composer prefilled and brings it into view.
  useEffect(() => {
    if (!draft || !isAuthor) return
    setAddingCitation(true)
    const id = requestAnimationFrame(() =>
      citationComposerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
    return () => cancelAnimationFrame(id)
  }, [draft, isAuthor])

  // Open the tribute composer seeded from a citation: the cited source becomes
  // the payee (author-confirmed via the live resolver preview) and the link is
  // carried through to POST /tributes as citationEdgeId.
  const openTributeFromCitation = useCallback((c: CitationEdge, num: number) => {
    const seed = c.source.username ?? c.source.uri ?? c.source.authorPubkey ?? ''
    setTributeSeed({ target: seed, citationEdgeId: c.id, citationNum: num })
    setAddingTribute(true)
    requestAnimationFrame(() =>
      tributeComposerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    )
  }, [])

  // The third consent option (C1): accept the offer (proposed → live), then open
  // a child composer to pass a share of this now-live share further upstream.
  const acceptAndPass = useCallback(
    async (tribute: TributeView) => {
      // consent() is the commit point. Once it resolves the offer is ACCEPTED;
      // a subsequent reload failure must not propagate as an accept failure —
      // that would surface "try again" and invite a re-click that re-consents an
      // already-live tribute. So only a genuine consent() rejection escapes to
      // the caller's catch; a stale row is tolerable, a double-accept is not.
      await tributesApi.consent(tribute.id)
      if (!aliveRef.current) return
      setChainSeed({ parentTributeId: tribute.id, parentPercentageBps: tribute.percentageBps })
      try {
        await load()
      } catch {
        // Accept already landed; leave the row stale rather than rethrow.
      }
      requestAnimationFrame(() =>
        tributeComposerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      )
    },
    [load],
  )

  // Inject the in-prose markers for anchored citations. Numbering follows the
  // foot order (citations are returned ordered by char_start, so anchored ones
  // lead and their numbers line up). Insert descending so an earlier marker
  // never shifts a later offset's basis.
  useEffect(() => {
    const root = articleBodyRef?.current
    if (!root || !loaded) return
    clearMarkers(root)
    const anchored = citations
      .map((c, i) => ({ c, num: i + 1 }))
      // Anchored AND the live body text at the span still matches the stored
      // excerpt — drop the marker if an edit/republish shifted the offsets, so
      // it never lands on unrelated prose (verify on the clean, marker-free root
      // before any insertion splits the basis).
      .filter(
        ({ c }) =>
          c.charStart != null &&
          c.charEnd != null &&
          excerptMatchesAt(root, c.charStart, c.charEnd, c.excerpt),
      )
      .sort((a, b) => b.c.charStart! - a.c.charStart!)
    for (const { c, num } of anchored) {
      insertMarkerAt(root, c.charStart!, buildMarker(num, c.id, !!c.disputes.citedAuthor))
    }
    return () => clearMarkers(root)
  }, [articleBodyRef, loaded, citations, bodyHtml])

  if (!edgesOn) return null
  if (!loaded) return null
  const showTributes = tributesOn
  const hasContent = credits.length > 0 || citations.length > 0 || tributeList.length > 0
  // Hide the whole apparatus for a reader of a piece with no edges; the author
  // always sees it (so they can attach credits/citations).
  if (!hasContent && !isAuthor) return null

  const canDispute = !!user && !isAuthor
  // Foot order = citation number (the GET returns them ordered by char_start);
  // lets a citation-linked tribute name the citation it sprang from.
  const citationNumById = new Map(citations.map((c, i) => [c.id, i + 1]))

  return (
    <section className="mt-16 space-y-10">
      {(credits.length > 0 || isAuthor) && (
        <div>
          <h2 className="label-ui text-grey-400 mb-4">Credits</h2>
          {credits.length > 0 && (
            <ul className="space-y-5">
              {credits.map((c) => (
                <CreditRow
                  key={c.id}
                  credit={c}
                  canDispute={canDispute}
                  viewerIsParty={!!user && !!c.target.accountId && user.id === c.target.accountId}
                  onChanged={load}
                />
              ))}
            </ul>
          )}
          {isAuthor && articleDbId && (
            <div className="mt-4">
              {addingCredit ? (
                <CreditComposer
                  articleId={articleDbId}
                  onDone={() => { setAddingCredit(false); void load() }}
                  onCancel={() => setAddingCredit(false)}
                />
              ) : (
                <button className="btn-text" onClick={() => setAddingCredit(true)}>
                  + Add credit
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {(citations.length > 0 || isAuthor) && (
        <div>
          <h2 className="label-ui text-grey-400 mb-4">Citations</h2>
          {citations.length > 0 && (
            <ul className="space-y-6">
              {citations.map((c, i) => (
                <CitationRow
                  key={c.id}
                  citation={c}
                  num={i + 1}
                  canDispute={canDispute}
                  viewerIsParty={!!user?.pubkey && !!c.source.authorPubkey && user.pubkey === c.source.authorPubkey}
                  canTribute={isAuthor && tributesOn}
                  onAddTribute={() => openTributeFromCitation(c, i + 1)}
                  onChanged={load}
                />
              ))}
            </ul>
          )}
          {isAuthor && articleDbId && (
            <div className="mt-4" ref={citationComposerRef}>
              {addingCitation ? (
                <CitationComposer
                  // Remount on a fresh selection so the seeded excerpt updates.
                  key={draft ? `${draft.charStart}-${draft.charEnd}` : 'manual'}
                  articleId={articleDbId}
                  seed={draft}
                  onDone={() => { setAddingCitation(false); clearDraft(); void load() }}
                  onCancel={() => { setAddingCitation(false); clearDraft() }}
                />
              ) : (
                <button className="btn-text" onClick={() => setAddingCitation(true)}>
                  + Add citation
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showTributes && (tributeList.length > 0 || isAuthor) && (
        <div>
          <h2 className="label-ui text-grey-400 mb-4">Tributes</h2>
          {tributeList.length > 0 && (
            <ul className="space-y-5">
              {renderTributeForest(tributeList, {
                userId: user?.id ?? null,
                citationNumById,
                onChanged: load,
                onAcceptAndPass: acceptAndPass,
              })}
            </ul>
          )}
          {/* The chain child composer (opened by an inspirer who chose "Accept &
              pass a share upstream") — appears for ANY accepting inspirer, not
              just the article author. */}
          {chainSeed && articleDbId && (
            <div className="mt-4" ref={tributeComposerRef}>
              <TributeComposer
                key={`chain-${chainSeed.parentTributeId}`}
                articleId={articleDbId}
                parentTributeId={chainSeed.parentTributeId}
                parentPercentageBps={chainSeed.parentPercentageBps}
                onDone={() => { setChainSeed(null); void load() }}
                onCancel={() => setChainSeed(null)}
              />
            </div>
          )}
          {isAuthor && articleDbId && !chainSeed && (
            <div className="mt-4" ref={tributeComposerRef}>
              {addingTribute ? (
                <TributeComposer
                  // Remount when the citation seed changes so the prefilled
                  // target + recorded link update.
                  key={tributeSeed ? `cite-${tributeSeed.citationEdgeId}` : 'manual'}
                  articleId={articleDbId}
                  seedTarget={tributeSeed?.target}
                  citationEdgeId={tributeSeed?.citationEdgeId}
                  citationNum={tributeSeed?.citationNum}
                  onDone={() => { setAddingTribute(false); setTributeSeed(null); void load() }}
                  onCancel={() => { setAddingTribute(false); setTributeSeed(null) }}
                />
              ) : (
                <button
                  className="btn-text"
                  onClick={() => { setTributeSeed(null); setAddingTribute(true) }}
                >
                  + Add tribute
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ── Tribute ──────────────────────────────────────────────────────────────

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)
}

// The honest status phrase shown after the render line. A declined/lapsed share
// returns to whoever offered it — the article author for a root tribute, the
// parent inspirer for a chained child (C5).
function tributeStatusPhrase(t: TributeView): string {
  const returnsTo = t.depth > 0 ? 'the offerer' : 'the author'
  switch (t.status) {
    case 'live':
      return 'active'
    case 'declined':
      return `declined — share returns to ${returnsTo}`
    case 'lapsed':
      return `lapsed — share returned to ${returnsTo}`
    case 'proposed':
    default:
      // Never "accruing/held" — until they accept the share is the offerer's
      // own earnings under a revocable offer, not money held in the payee's name.
      return t.reachable
        ? 'proposed — awaiting their reply'
        : 'proposed — no payee reached yet'
  }
}

// Depth cap mirror (server: MAX_CHAIN_DEPTH in tributes.ts / migration 128). A
// node already at the cap can't spawn a child, so the third consent option is
// suppressed there.
const MAX_CHAIN_DEPTH = 8

// Render the tributes as a nested tree (root → children → …) rather than a flat
// list. The flat list is created-ordered, so we re-order by walking the tree:
// each node is followed immediately by its subtree, and indents by depth.
function renderTributeForest(
  tributes: TributeView[],
  ctx: {
    userId: string | null
    citationNumById: Map<string, number>
    onChanged: () => void
    onAcceptAndPass: (t: TributeView) => Promise<void>
  },
): ReactNode[] {
  const ids = new Set(tributes.map((t) => t.id))
  const childrenOf = new Map<string | null, TributeView[]>()
  for (const t of tributes) {
    // Re-root an orphan (parent absent from the payload) under null so its share
    // still renders — money must never silently vanish from the apparatus.
    const key = t.parentTributeId && ids.has(t.parentTributeId) ? t.parentTributeId : null
    const list = childrenOf.get(key)
    if (list) list.push(t)
    else childrenOf.set(key, [t])
  }
  const renderRow = (t: TributeView): ReactNode => (
    <TributeRow
      key={t.id}
      tribute={t}
      viewerIsInspirer={!!ctx.userId && !!t.target.accountId && ctx.userId === t.target.accountId}
      citationNum={t.citationEdgeId ? ctx.citationNumById.get(t.citationEdgeId) ?? null : null}
      onChanged={ctx.onChanged}
      onAcceptAndPass={ctx.onAcceptAndPass}
    />
  )
  // Visited-set guard: the schema prevents cycles, but a money surface never
  // recurses forever on a malformed payload (each id is rendered at most once).
  const seen = new Set<string>()
  const walk = (parentId: string | null): ReactNode[] =>
    (childrenOf.get(parentId) ?? []).flatMap((t) => {
      if (seen.has(t.id)) return []
      seen.add(t.id)
      return [renderRow(t), ...walk(t.id)]
    })
  const out = walk(null)
  // Force-render any node a cycle kept off every root path (a loop with no
  // entry point), flat, so no consented share is hidden.
  for (const t of tributes) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    out.push(renderRow(t), ...walk(t.id))
  }
  return out
}

function TributeRow({
  tribute,
  viewerIsInspirer,
  citationNum,
  onChanged,
  onAcceptAndPass,
}: {
  tribute: TributeView
  viewerIsInspirer: boolean
  /** When this tribute was composed from a citation, its foot number. */
  citationNum: number | null
  onChanged: () => void
  /** Accept this offer, then open a composer to pass a share further upstream. */
  onAcceptAndPass: (t: TributeView) => Promise<void>
}) {
  const { target } = tribute
  const name = target.displayName ?? target.username ?? 'an unnamed source'
  const isChild = tribute.depth > 0
  // The share is a conditional offer until accepted — the verb must say so:
  // the public line never asserts the money is already theirs, and the wording
  // is a constraint rather than a preference (docs/adr/LEGAL-BRAKES.md).
  const earningsVerb =
    tribute.status === 'live' ? 'goes to' : tribute.status === 'proposed' ? 'will go to' : 'was offered to'
  // A child redirects a share of its PARENT'S slice (rendered directly above in
  // the tree), not the piece's earnings — "X% of that share goes to W".
  const ofWhat = isChild ? 'that share' : 'this piece’s earnings'
  const canChain = tribute.depth < MAX_CHAIN_DEPTH
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)

  const act = async (fn: () => Promise<unknown>, fail: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch {
      setError(fail)
      setBusy(false)
    }
  }

  return (
    <li
      className="text-ui-sm text-grey-600 leading-relaxed"
      // Tree indent by depth (structural spacing, not a token-able size).
      style={isChild ? { marginLeft: Math.min(tribute.depth, MAX_CHAIN_DEPTH) * 20 } : undefined}
    >
      <span className="text-black">
        {isChild && <span className="text-grey-400" aria-hidden>↳ </span>}
        <span className="font-medium">{bpsToPercent(tribute.percentageBps)}%</span> of {ofWhat}{' '}
        {earningsVerb}{' '}
        {target.accountId && target.username ? (
          <ProfileLink href={`/${target.username}`} className="font-medium text-black hover:underline">
            {name}
          </ProfileLink>
        ) : (
          <span className="font-medium text-black">{name}</span>
        )}
        {tribute.status === 'proposed' && ' if they accept'}
      </span>
      <span className="label-ui text-grey-400 ml-2">· {tributeStatusPhrase(tribute)}</span>
      {tribute.citationEdgeId && citationNum != null && (
        <a
          href={`#citation-${tribute.citationEdgeId}`}
          className="label-ui text-grey-400 ml-2 hover:text-black hover:underline transition-colors"
        >
          · for the source cited at [{citationNum}]
        </a>
      )}

      {/* The inspirer's own consent affordance (they reach this via the offer
          notification / claim, which comps them the read). Three options (C1):
          accept, accept-and-pass-upstream, or decline. */}
      {viewerIsInspirer && tribute.status === 'proposed' && (
        <div className="pl-4 mt-1 flex flex-wrap items-center gap-4">
          <span className="text-ui-xs text-grey-600">
            {isChild ? 'You’ve been offered a share.' : 'This writer is offering you a share.'}
          </span>
          <button
            className="btn-soft disabled:opacity-50"
            disabled={busy}
            onClick={() => act(() => tributesApi.consent(tribute.id), 'Could not accept — try again.')}
          >
            Accept
          </button>
          {canChain && (
            <button
              className="btn-text disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                onAcceptAndPass(tribute).catch(() => {
                  setError('Could not accept — try again.')
                  setBusy(false)
                })
              }}
            >
              Accept &amp; pass a share upstream
            </button>
          )}
          <button
            className="btn-text-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => act(() => tributesApi.decline(tribute.id), 'Could not decline — try again.')}
          >
            Decline
          </button>
          {error && <span className="text-ui-xs text-crimson">{error}</span>}
        </div>
      )}

      {/* The author can withdraw a still-proposed tribute. */}
      {tribute.mine && tribute.status === 'proposed' && !viewerIsInspirer && (
        <div className="pl-4 mt-1">
          {withdrawing ? (
            <p className="text-ui-xs text-grey-600">
              Withdraw this tribute?{' '}
              <button
                className="btn-text-danger disabled:opacity-50"
                disabled={busy}
                onClick={() => act(() => tributesApi.withdraw(tribute.id), 'Could not withdraw — try again.')}
              >
                {busy ? 'Withdrawing…' : 'Withdraw'}
              </button>{' '}
              <button className="btn-text-muted" disabled={busy} onClick={() => setWithdrawing(false)}>
                Keep
              </button>
              {error && <span className="text-crimson ml-2">{error}</span>}
            </p>
          ) : (
            <button className="btn-text-muted" onClick={() => setWithdrawing(true)}>
              Withdraw
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function TributeComposer({
  articleId,
  seedTarget,
  citationEdgeId,
  citationNum,
  parentTributeId,
  parentPercentageBps,
  onDone,
  onCancel,
}: {
  articleId: string
  /** Pre-fill the payee (composed from a citation); author can still edit it. */
  seedTarget?: string
  /** Phase-4 composition: record this tribute against a citation on the piece. */
  citationEdgeId?: string
  citationNum?: number
  /** Phase-5 chains: when set, this composes a CHILD that redirects a share of
   *  the parent tribute's slice upstream (the offerer is the parent's payee). */
  parentTributeId?: string
  parentPercentageBps?: number
  onDone: () => void
  onCancel: () => void
}) {
  const isChild = parentTributeId != null
  // The composer is remounted (keyed on the seed) when composed from a citation,
  // so initialising from seedTarget is correct.
  const [target, setTarget] = useState(seedTarget ?? '')
  const [percent, setPercent] = useState('')
  const [email, setEmail] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useResolvePreview(target)

  const pctNum = Number(percent)
  const pctValid = Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 90
  const ready = target.trim() && pctValid

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await tributesApi.create({
        articleId,
        percentageBps: Math.round(pctNum * 100),
        target: target.trim(),
        inviteEmail: email.trim() || undefined,
        note: note.trim() || undefined,
        citationEdgeId,
        parentTributeId,
      })
      onDone()
    } catch {
      setError(
        isChild
          ? 'Could not pass the share on — it may leave you too little of your own share, or the chain is at its maximum depth.'
          : 'Could not add tribute — the share may leave the author too little, or the piece is in a publication.',
      )
      setBusy(false)
    }
  }

  return (
    <div className="bg-glasshouse-well/40 rounded p-4 space-y-3">
      {isChild && (
        <p className="text-ui-xs text-grey-600">
          Passing a share of your{' '}
          {parentPercentageBps != null && (
            <span className="font-medium">{bpsToPercent(parentPercentageBps)}%</span>
          )}{' '}
          share further upstream — to whoever inspired you. You keep the rest of your share.
        </p>
      )}
      {citationNum != null && (
        <p className="text-ui-xs text-grey-600">
          Offering a share to the source you cited at [{citationNum}]. Confirm the payee below.
        </p>
      )}
      <div>
        <FieldLabel>{isChild ? 'Who inspired you' : 'Who inspired this piece'}</FieldLabel>
        <input
          className={FIELD}
          placeholder="username, npub, handle, URL, or a name"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          autoFocus
        />
        {preview && <p className="mt-1 text-ui-xs text-grey-600">{preview}</p>}
      </div>
      <div>
        <FieldLabel>
          {isChild ? 'Share of your share (%)' : 'Share of this piece’s earnings (%)'}
        </FieldLabel>
        <input
          className={FIELD}
          type="number"
          inputMode="decimal"
          min="0.01"
          max="90"
          step="0.5"
          placeholder="e.g. 10"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
        <p className="mt-1 text-ui-xs text-grey-600">
          {isChild
            ? 'You keep the rest of your share. The shares you pass on together can take at most 90% of it.'
            : 'You keep the rest. A piece’s tributes together can take at most 90%.'}
        </p>
      </div>
      <div>
        <FieldLabel>Their email (so we can reach them)</FieldLabel>
        <input
          className={FIELD}
          type="email"
          placeholder="we contact them privately — never via social DMs"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <p className="mt-1 text-ui-xs text-grey-600">
          If they&rsquo;re already on all.haus we&rsquo;ll reach them in-app instead. Until they accept,
          the share stays part of your earnings, reserved pending their reply; if they never accept, it stays yours.
        </p>
      </div>
      <div>
        <FieldLabel>Note (optional)</FieldLabel>
        <input
          className={FIELD}
          placeholder="a personal word on why"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {error && <p className="text-ui-xs text-crimson">{error}</p>}
      <div className="flex items-center gap-4">
        <button className="btn-soft disabled:opacity-50" disabled={busy || !ready} onClick={submit}>
          {busy ? 'Offering…' : isChild ? 'Pass the share on' : 'Offer tribute'}
        </button>
        <button className="btn-text-muted" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Credit ────────────────────────────────────────────────────────────────

function CreditRow({
  credit,
  canDispute,
  viewerIsParty,
  onChanged,
}: {
  credit: CreditEdge
  canDispute: boolean
  viewerIsParty: boolean
  onChanged: () => void
}) {
  const { target } = credit
  const name = target.displayName ?? target.username ?? 'an unnamed source'
  const [disputing, setDisputing] = useState(false)

  return (
    <li className="text-ui-sm text-grey-600 leading-relaxed">
      <span className="text-black">
        {target.accountId && target.username ? (
          <ProfileLink href={`/${target.username}`} className="font-medium hover:underline">
            {name}
          </ProfileLink>
        ) : (
          <span className="font-medium">{name}</span>
        )}
      </span>
      {credit.note && <span> — {credit.note}</span>}

      {/* The viewer's own disclaimer is rendered (with Withdraw) by the
          DisputeAffordance below, so drop it from the public list to avoid an echo. */}
      {credit.disclaimers
        .filter((d) => d.id !== credit.mine?.id)
        .map((d) => (
          <p key={d.id} className="mt-1 pl-4 text-ui-xs text-grey-600">
            <span className="text-grey-400">↳ </span>
            {d.byCreditedParty ? 'They reject this attribution: ' : 'Disputed: '}
            {d.counterCharacterisation}
          </p>
        ))}

      <DisputeAffordance
        mine={credit.mine}
        canDispute={canDispute}
        viewerIsParty={viewerIsParty}
        disputing={disputing}
        setDisputing={setDisputing}
        onChanged={onChanged}
        targetKey={{ creditEdgeId: credit.id }}
        label="Reject this attribution"
        allowWiderExcerpt={false}
      />
    </li>
  )
}

// ── Citation ──────────────────────────────────────────────────────────────

// Build an in-prose marker element (injected imperatively into the body). An
// anchor jumping to citation-<id> at the foot; crimson when the cited author
// has disputed. Structure/colour live in the .citation-marker CSS (tokens).
function buildMarker(num: number, citationId: string, disputed: boolean): HTMLElement {
  const el = document.createElement('a')
  el.className = disputed ? `${MARKER_CLASS} ${MARKER_CLASS}--disputed` : MARKER_CLASS
  el.textContent = String(num)
  el.href = `#citation-${citationId}`
  el.setAttribute('role', 'doc-noteref')
  el.setAttribute('aria-label', `Citation ${num}${disputed ? ', disputed by the cited author' : ''}`)
  el.onclick = (e) => {
    e.preventDefault()
    const target = document.getElementById(`citation-${citationId}`)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Brief wash so the eye lands on the right entry, then fades.
    target.style.transition = 'background-color 0.6s'
    target.style.backgroundColor = 'rgb(var(--ah-crimson-rgb) / 0.08)'
    window.setTimeout(() => { target.style.backgroundColor = '' }, 1400)
  }
  return el
}

function CitationRow({
  citation,
  num,
  canDispute,
  viewerIsParty,
  canTribute,
  onAddTribute,
  onChanged,
}: {
  citation: CitationEdge
  num: number
  canDispute: boolean
  viewerIsParty: boolean
  /** Author + tributes-on: offer this cited source a share (Phase-4 composition). */
  canTribute: boolean
  onAddTribute: () => void
  onChanged: () => void
}) {
  const [showContext, setShowContext] = useState(false)
  const [showThirdParty, setShowThirdParty] = useState(false)
  const [disputing, setDisputing] = useState(false)
  const { source, disputes } = citation

  const sourceLabel = source.displayName ?? source.username ?? source.uri ?? null
  const cited = disputes.citedAuthor
  // Only offer a tribute for an addressable source — a plain-label citation has
  // no payee to reach (the generic "+ Add tribute" still covers that case).
  const tributable = !!(source.username || source.uri || source.authorPubkey)

  return (
    <li id={`citation-${citation.id}`} className="space-y-2 scroll-mt-8 rounded">
      <p className="text-ui-sm text-black leading-relaxed">
        <span className="label-ui text-grey-400 mr-2 align-baseline">{num}</span>
        {citation.characterisation}
      </p>

      <blockquote className="font-serif italic text-grey-600 leading-relaxed pl-4">
        “{citation.excerpt}”
      </blockquote>

      {sourceLabel && (
        <p className="label-ui text-grey-400">
          {source.username ? (
            <ProfileLink href={`/${source.username}`} className="hover:underline">
              {sourceLabel}
            </ProfileLink>
          ) : (
            sourceLabel
          )}
        </p>
      )}

      {/* The cited author's own dispute — rendered inline (max one). */}
      {cited && (
        <div className="pl-4 text-ui-xs text-grey-600">
          <p>
            <span className="text-grey-400">↳ </span>
            The cited author disputes this: {cited.counterCharacterisation}
          </p>
          {cited.widerExcerpt && (
            <div className="mt-1">
              <button
                onClick={() => setShowContext((v) => !v)}
                className="label-ui text-grey-400 hover:text-black hover:underline transition-colors"
              >
                {showContext ? 'Hide fuller context' : 'Show fuller context'}
              </button>
              {showContext && (
                <blockquote className="mt-1 font-serif italic text-grey-600 leading-relaxed">
                  “{cited.widerExcerpt}”
                </blockquote>
              )}
            </div>
          )}
        </div>
      )}

      {/* Third-party disputes — a count only, on expansion (never a badge). */}
      {disputes.thirdPartyCount > 0 && (
        <div className="pl-4">
          <button
            onClick={() => setShowThirdParty((v) => !v)}
            className="label-ui text-grey-400 hover:text-black hover:underline transition-colors"
          >
            {showThirdParty
              ? 'Hide disputes'
              : `${disputes.thirdPartyCount} ${disputes.thirdPartyCount === 1 ? 'dispute' : 'disputes'}`}
          </button>
          {showThirdParty && (
            <p className="mt-1 text-ui-xs text-grey-600">
              {disputes.thirdPartyCount}{' '}
              {disputes.thirdPartyCount === 1 ? 'reader has' : 'readers have'} disputed this citation.
            </p>
          )}
        </div>
      )}

      <DisputeAffordance
        mine={disputes.mine}
        canDispute={canDispute}
        viewerIsParty={viewerIsParty}
        disputing={disputing}
        setDisputing={setDisputing}
        onChanged={onChanged}
        targetKey={{ citationEdgeId: citation.id }}
        label="Dispute this citation"
        allowWiderExcerpt
        // When the viewer IS the cited author, their dispute already shows in
        // the inline cited-author block above — don't echo it.
        suppressMineText={!!disputes.mine && disputes.mine.id === disputes.citedAuthor?.id}
      />

      {canTribute && tributable && (
        <button className="btn-text-muted" onClick={onAddTribute}>
          + Offer a tribute to this source
        </button>
      )}
    </li>
  )
}

// ── Dispute affordance (file / withdraw), shared by both row types ──────────

function DisputeAffordance({
  mine,
  canDispute,
  viewerIsParty,
  disputing,
  setDisputing,
  onChanged,
  targetKey,
  label,
  allowWiderExcerpt,
  suppressMineText = false,
}: {
  mine: ViewerDispute | null
  canDispute: boolean
  viewerIsParty: boolean
  disputing: boolean
  setDisputing: (v: boolean) => void
  onChanged: () => void
  targetKey: { citationEdgeId?: string; creditEdgeId?: string }
  label: string
  allowWiderExcerpt: boolean
  // True ⇒ the viewer's own dispute text already renders elsewhere (the inline
  // cited-author block), so only the Withdraw control is drawn here — no echo.
  suppressMineText?: boolean
}) {
  const [withdrawing, setWithdrawing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (mine) {
    return (
      <div className="pl-4 mt-1">
        {!suppressMineText && (
          <p className="text-ui-xs text-grey-600">
            <span className="text-grey-400">↳ </span>
            You disputed this: {mine.counterCharacterisation}
            {mine.staked && <span className="text-grey-400"> · £5 stake held</span>}
          </p>
        )}
        {withdrawing ? (
          <p className="mt-1 text-ui-xs text-grey-600">
            Withdraw your dispute
            {mine.staked && <> — your £5 stake is refunded</>}?{' '}
            <button
              className="btn-text-danger disabled:opacity-50"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  await upstreamEdges.withdrawDispute(mine.id)
                  onChanged()
                } catch {
                  setError('Could not withdraw — try again.')
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </button>{' '}
            <button className="btn-text-muted" disabled={busy} onClick={() => setWithdrawing(false)}>
              Keep
            </button>
            {error && <span className="text-crimson ml-2">{error}</span>}
          </p>
        ) : (
          <button className="mt-1 btn-text-muted" onClick={() => setWithdrawing(true)}>
            Withdraw
          </button>
        )}
      </div>
    )
  }

  if (!canDispute) return null

  return disputing ? (
    <DisputeComposer
      targetKey={targetKey}
      viewerIsParty={viewerIsParty}
      allowWiderExcerpt={allowWiderExcerpt}
      onDone={() => { setDisputing(false); onChanged() }}
      onCancel={() => setDisputing(false)}
    />
  ) : (
    <div className="pl-4 mt-1">
      <button className="btn-text-muted" onClick={() => setDisputing(true)}>
        {label}
      </button>
    </div>
  )
}

// ── Composers ───────────────────────────────────────────────────────────────

const FIELD =
  'w-full bg-glasshouse-well border-none rounded px-3 py-2 text-ui-sm text-black placeholder:text-grey-300 focus:outline-none'

// Debounced omnivorous-identifier preview: confirms what the raw string will
// resolve to (member / external source / feed), or that it'll be a plain label.
function useResolvePreview(value: string): string | null {
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => {
    const v = value.trim()
    if (v.length < 2) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      resolver
        .resolve(v, 'general')
        .then((r) => {
          if (cancelled) return
          const m = r.matches?.[0]
          if (m?.type === 'native_account' && m.account) {
            setPreview(`→ ${m.account.displayName || m.account.username} · all.haus member`)
          } else if (m?.type === 'external_source' && m.externalSource) {
            setPreview(`→ ${m.externalSource.displayName || m.externalSource.sourceUri} · ${m.externalSource.protocol}`)
          } else if (m?.type === 'rss_feed' && m.rssFeed) {
            setPreview(`→ ${m.rssFeed.title || m.rssFeed.feedUrl} · feed`)
          } else {
            setPreview('→ recorded as a plain label')
          }
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [value])
  return preview
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="label-ui text-grey-600 mb-1 block">{children}</label>
}

function CreditComposer({
  articleId,
  onDone,
  onCancel,
}: {
  articleId: string
  onDone: () => void
  onCancel: () => void
}) {
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useResolvePreview(target)

  const submit = async () => {
    if (!target.trim()) return
    setBusy(true)
    setError(null)
    try {
      await upstreamEdges.createCredit({ articleId, target: target.trim(), note: note.trim() || undefined })
      onDone()
    } catch {
      setError('Could not add credit — try again.')
      setBusy(false)
    }
  }

  return (
    <div className="bg-glasshouse-well/40 rounded p-4 space-y-3">
      <div>
        <FieldLabel>Who or what you owe</FieldLabel>
        <input
          className={FIELD}
          placeholder="username, npub, handle, URL, or a name"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          autoFocus
        />
        {preview && <p className="mt-1 text-ui-xs text-grey-600">{preview}</p>}
      </div>
      <div>
        <FieldLabel>Note (optional)</FieldLabel>
        <input
          className={FIELD}
          placeholder="how this piece is in their debt"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {error && <p className="text-ui-xs text-crimson">{error}</p>}
      <div className="flex items-center gap-4">
        <button className="btn-soft disabled:opacity-50" disabled={busy || !target.trim()} onClick={submit}>
          {busy ? 'Adding…' : 'Add credit'}
        </button>
        <button className="btn-text-muted" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function CitationComposer({
  articleId,
  seed,
  onDone,
  onCancel,
}: {
  articleId: string
  // A span selected in the article body — prefills the passage and carries the
  // char offsets through, so the citation lands anchored (a marker appears).
  seed?: CitationDraft | null
  onDone: () => void
  onCancel: () => void
}) {
  const [source, setSource] = useState('')
  const [excerpt, setExcerpt] = useState(seed?.excerpt ?? '')
  const [characterisation, setCharacterisation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = useResolvePreview(source)

  const anchored = seed != null
  const ready = source.trim() && excerpt.trim() && characterisation.trim()

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await upstreamEdges.createCitation({
        articleId,
        source: source.trim(),
        excerpt: excerpt.trim(),
        characterisation: characterisation.trim(),
        // Only send offsets when the excerpt is still the selected span; if the
        // author rewrote it the anchor no longer matches, so drop it.
        ...(anchored && excerpt.trim() === seed!.excerpt.trim()
          ? { charStart: seed!.charStart, charEnd: seed!.charEnd }
          : {}),
      })
      onDone()
    } catch {
      setError('Could not add citation — try again.')
      setBusy(false)
    }
  }

  return (
    <div className="bg-glasshouse-well/40 rounded p-4 space-y-3">
      <div>
        <FieldLabel>Source</FieldLabel>
        <input
          className={FIELD}
          placeholder="username, npub, handle, URL, or a name"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          autoFocus
        />
        {preview && <p className="mt-1 text-ui-xs text-grey-600">{preview}</p>}
      </div>
      <div>
        <FieldLabel>Passage cited</FieldLabel>
        <textarea
          className={`${FIELD} resize-none leading-relaxed`}
          rows={3}
          placeholder="the exact words you are citing"
          value={excerpt}
          onChange={(e) => setExcerpt(e.target.value)}
        />
        {anchored && (
          <p className="mt-1 text-ui-xs text-grey-600">
            {excerpt.trim() === seed!.excerpt.trim()
              ? '↳ Anchored to your selection — a marker will appear in the text.'
              : '↳ Edited away from the selection — this citation will not be anchored.'}
          </p>
        )}
      </div>
      <div>
        <FieldLabel>What you claim about it</FieldLabel>
        <textarea
          className={`${FIELD} resize-none leading-relaxed`}
          rows={2}
          placeholder="“X argues Y” — your faithfulness claim"
          value={characterisation}
          onChange={(e) => setCharacterisation(e.target.value)}
        />
      </div>
      {error && <p className="text-ui-xs text-crimson">{error}</p>}
      <div className="flex items-center gap-4">
        <button className="btn-soft disabled:opacity-50" disabled={busy || !ready} onClick={submit}>
          {busy ? 'Adding…' : 'Add citation'}
        </button>
        <button className="btn-text-muted" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function DisputeComposer({
  targetKey,
  viewerIsParty,
  allowWiderExcerpt,
  onDone,
  onCancel,
}: {
  targetKey: { citationEdgeId?: string; creditEdgeId?: string }
  viewerIsParty: boolean
  allowWiderExcerpt: boolean
  onDone: () => void
  onCancel: () => void
}) {
  const [counter, setCounter] = useState('')
  const [wider, setWider] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!counter.trim()) return
    setBusy(true)
    setError(null)
    try {
      await upstreamEdges.fileDispute({
        ...targetKey,
        counterCharacterisation: counter.trim(),
        widerExcerpt: allowWiderExcerpt && wider.trim() ? wider.trim() : undefined,
      })
      onDone()
    } catch (err) {
      // F1: one active dispute per edge. A 409 means the viewer already has a
      // live dispute here — idempotent, so reload to surface it (and its
      // Withdraw affordance) rather than prompting a pointless retry.
      if (err instanceof ApiError && err.status === 409) {
        onDone()
        return
      }
      setError('Could not file dispute — try again.')
      setBusy(false)
    }
  }

  return (
    <div className="pl-4 mt-2">
      <div className="bg-glasshouse-well/40 rounded p-4 space-y-3">
        <p className="text-ui-xs text-grey-600">
          {viewerIsParty
            ? 'You are the cited party — no stake is held.'
            : 'A refundable £5 stake is held on your reading tab while this dispute stands. You get it back when you withdraw.'}
        </p>
        <div>
          <FieldLabel>Your counter-claim</FieldLabel>
          <textarea
            className={`${FIELD} resize-none leading-relaxed`}
            rows={2}
            placeholder="what is wrong with this characterisation"
            value={counter}
            onChange={(e) => setCounter(e.target.value)}
            autoFocus
          />
        </div>
        {allowWiderExcerpt && (
          <div>
            <FieldLabel>Fuller context (optional)</FieldLabel>
            <textarea
              className={`${FIELD} resize-none leading-relaxed`}
              rows={2}
              placeholder="a wider quotation that restores the meaning"
              value={wider}
              onChange={(e) => setWider(e.target.value)}
            />
          </div>
        )}
        {error && <p className="text-ui-xs text-crimson">{error}</p>}
        <div className="flex items-center gap-4">
          <button className="btn-soft disabled:opacity-50" disabled={busy || !counter.trim()} onClick={submit}>
            {busy ? 'Filing…' : 'File dispute'}
          </button>
          <button className="btn-text-muted" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
