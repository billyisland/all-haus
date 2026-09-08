'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../stores/auth'
import { publishNote, type CrossPostTarget, type QuoteTarget } from '../../lib/publishNote'
import { publishReply } from '../../lib/replies'
import {
  linkedAccounts as linkedAccountsApi,
  type LinkedAccount,
} from '../../lib/api'
import { Glasshouse } from './Glasshouse'
import { useEditorOverlay, seedFromNote } from '../../stores/editorOverlay'

const NOTE_CHAR_LIMIT = 1000
const NUDGE_WORDS_THRESHOLD = 400

// Every colour here is in the INVERTING family (`ink`/`white`/`bone`/greys).
// This panel is mounted at the WorkspaceView root with NO light island above
// it, so its ground resolves through the `html.dark` inversion — and a
// never-inverting foreground on top of one (`ink-925` on `white` = 26 26 24 on
// 30 29 26, a contrast ratio of 1.03:1) is invisible. Foreground and ground
// must be in the SAME inversion family; see web/CLAUDE.md › Global light/dark
// mode.
const TOKENS = {
  panelBorder: 'var(--ah-ink)',
  bannerBg: 'var(--ah-bone)',
  bannerFg: 'var(--ah-ink)',
  hintFg: 'var(--ah-grey-600)',
  errorFg: 'var(--ah-crimson)',
  publishBg: 'var(--ah-ink)',
  publishFg: 'var(--ah-bone)',
  publishDisabled: 'var(--ah-grey-300)',
  // Inset well a touch darker than the now-white Glasshouse pane (bg-glasshouse).
  fieldBg: 'var(--ah-glasshouse-well)',
}

type Protocol = 'allhaus' | 'nostr' | 'atproto' | 'activitypub'

const PROTOCOL_LABELS: Record<Protocol, string> = {
  allhaus: 'ALL.HAUS',
  nostr: 'NOSTR',
  atproto: 'BLUESKY',
  activitypub: 'MASTODON',
}

// Maps a linked-account protocol to the cross-post protocol the publish path
// fans out to. nostr_external/rss can't receive an original cross-post.
const PROTOCOL_FROM_LINKED: Record<LinkedAccount['protocol'], Protocol | null> = {
  atproto: 'atproto',
  activitypub: 'activitypub',
  nostr_external: null,
  rss: null,
}

export interface ReplyTarget {
  // The event being threaded under. For a reply to a top-level note/article this
  // is that event; for a reply to a comment this is the conversation ROOT (so
  // target_event_id stays the root and the comment is linked via the parent
  // fields below — see ConversationView).
  eventId: string
  eventKind: number
  // The author being replied to (parent comment author for nested replies) —
  // drives the NIP-10 `p` tag and the "Replying to …" line.
  authorPubkey: string
  authorName: string
  excerpt?: string
  // Set when replying to a comment rather than a top-level post: the parent
  // comment's UUID (index linkage) and its Nostr event id (NIP-10 `e` reply tag).
  parentCommentId?: string
  parentCommentEventId?: string
}

interface ComposerProps {
  open: boolean
  replyTarget?: ReplyTarget | null
  // When set, the note is published as a NIP-18 quote embedding this target.
  // Mutually exclusive with replyTarget.
  quoteTarget?: QuoteTarget | null
  onClose: () => void
  onPublished?: () => void
  // Slice 13: separate signal for reply publishes so the parent can refetch
  // the affected card's inline thread without refetching every vessel's items.
  onReplied?: (targetEventId: string) => void
}

// Note/reply/quote composer. Article writing graduated to the global
// EditorOverlay (the full ArticleEditor in a Glasshouse) — the "Write an
// article →" affordance and the long-note nudge open that overlay, seeding it
// with the in-progress note body.
export function Composer({ open, replyTarget, quoteTarget, onClose, onPublished, onReplied }: ComposerProps) {
  const { user } = useAuth()
  const [body, setBody] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Native protocols always broadcast; linked networks are admitted here but
  // additionally gated by the per-send cross-post pills below.
  const [enabledProtocols] = useState<Set<Protocol>>(
    () => new Set<Protocol>(['allhaus', 'nostr', 'atproto', 'activitypub']),
  )
  const [linkedByProtocol, setLinkedByProtocol] = useState<Partial<Record<Protocol, LinkedAccount>>>({})
  // Per-send cross-post toggles, seeded from each presence's cross_post_default
  // (the "Default on" checkbox in Reach other networks) — so settings pick the
  // default and the pill is the per-note override.
  const [crossPostOn, setCrossPostOn] = useState<Partial<Record<Protocol, boolean>>>({})
  const [nudgeDismissed, setNudgeDismissed] = useState(false)
  const [showNudge, setShowNudge] = useState(false)

  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setBody('')
    setError(null)
    setPublishing(false)
    setNudgeDismissed(false)
    setShowNudge(false)
    const t = setTimeout(() => bodyRef.current?.focus(), 0)

    // Fetch linked accounts so the protocol toggles know which non-native
    // protocols can actually receive a cross-post. Failure is non-fatal —
    // toggles fall back to disconnected state and the publish remains a
    // pure Nostr broadcast.
    let cancelled = false
    linkedAccountsApi
      .list()
      .then(({ accounts }) => {
        if (cancelled) return
        const map: Partial<Record<Protocol, LinkedAccount>> = {}
        const on: Partial<Record<Protocol, boolean>> = {}
        for (const acc of accounts) {
          if (!acc.isValid) continue
          const p = PROTOCOL_FROM_LINKED[acc.protocol]
          if (p && !map[p]) {
            map[p] = acc
            on[p] = acc.crossPostDefault
          }
        }
        setLinkedByProtocol(map)
        setCrossPostOn(on)
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedByProtocol({})
          setCrossPostOn({})
        }
      })

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open])

  // Note→article elevation: carry the in-progress body (with a heading-prefixed
  // first line promoted to the title) into the article editor overlay, then
  // close this composer. One-way per slice 10.
  const openArticleEditor = useCallback(() => {
    useEditorOverlay.getState().open(seedFromNote(body))
    onClose()
  }, [body, onClose])

  // 400-word nudge. Per spec, one-shot per session — once dismissed it doesn't
  // re-show until the Composer reopens.
  useEffect(() => {
    if (nudgeDismissed) {
      setShowNudge(false)
      return
    }
    const wordCount = body.trim() === '' ? 0 : body.trim().split(/\s+/).length
    if (wordCount >= NUDGE_WORDS_THRESHOLD) setShowNudge(true)
  }, [body, nudgeDismissed])

  if (!open) return null

  // External quotes append "\n\n<url>" to the published body (see publishNote),
  // so reserve that length here. Otherwise a body within the limit in the box
  // produces an over-limit note: the relay accepts the signed event but the
  // index POST (content.max(1000)) rejects it, orphaning the event on the relay.
  const quoteUrlReserve =
    quoteTarget?.isExternal && quoteTarget.quotedUrl ? quoteTarget.quotedUrl.length + 2 : 0
  const charCount = body.length + quoteUrlReserve
  const overLimit = charCount > NOTE_CHAR_LIMIT
  // Every send from this surface is a public broadcast (the recipient "To"
  // field is gone; DMs live in the Messages inbox). Non-native protocols only
  // fire a cross-post when a valid linked account exists for that protocol.
  const broadcastNostrSelected = enabledProtocols.has('nostr')
  const linkedProtocols = (['atproto', 'activitypub'] as const).filter(
    (p) => linkedByProtocol[p],
  )
  const crossPostTargets: { protocol: Protocol; account: LinkedAccount }[] = []
  for (const p of linkedProtocols) {
    if (!enabledProtocols.has(p)) continue
    if (!crossPostOn[p]) continue
    crossPostTargets.push({ protocol: p, account: linkedByProtocol[p]! })
  }

  const isReply = !!replyTarget
  const isQuote = !!quoteTarget

  const canPublish =
    !!user &&
    !!body.trim() &&
    !overLimit &&
    !publishing &&
    (isReply || isQuote || broadcastNostrSelected)

  async function handlePublish() {
    if (!canPublish || !user) return
    setPublishing(true)
    setError(null)
    try {
      if (isQuote && quoteTarget) {
        await publishNote(body, user.pubkey, quoteTarget)
        onPublished?.()
        onClose()
        return
      }
      if (isReply && replyTarget) {
        await publishReply({
          content: body,
          targetEventId: replyTarget.eventId,
          targetKind: replyTarget.eventKind,
          targetAuthorPubkey: replyTarget.authorPubkey,
          parentCommentId: replyTarget.parentCommentId,
          parentCommentEventId: replyTarget.parentCommentEventId,
        })
        onReplied?.(replyTarget.eventId)
        onPublished?.()
        onClose()
        return
      }
      const cross: CrossPostTarget[] = crossPostTargets.map(({ account }) => ({
        linkedAccountId: account.id,
        actionType: 'original',
      }))
      await publishNote(body, user.pubkey, undefined, cross.length > 0 ? cross : undefined)
      onPublished?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish.')
      setPublishing(false)
    }
  }

  // Glasshouse owns the scrim / ✕ / Escape; route all three here so a publish
  // in flight can't be dismissed out from under itself.
  function handleClose() {
    if (!publishing) onClose()
  }

  return (
    <Glasshouse
      onClose={handleClose}
      maxWidth={640}
      ariaLabel={isReply ? 'Reply' : isQuote ? 'Quote' : 'New note'}
      persistKey="composer"
      resizable
    >
      {/* Flex column that fills the pane: when the pane is content-sized (default)
          `h-full` resolves to auto so the textarea stays compact; when the pane is
          stretched it resolves to the explicit height, giving the flex-1 textarea
          free space to fill. */}
      <div
        className="flex flex-col h-full max-h-[var(--gh-h)] overflow-y-auto"
        style={{ padding: 24 }}
        // Explain base kind (C2): answers any interior hover a more specific
        // leaf doesn't; the pane chrome stays with the generic `pane` tag.
        data-explain="composer"
      >
        {/* Mode label — also reserves top-right clearance for the Glasshouse ✕. */}
        <div
          className="label-ui"
          style={{ color: TOKENS.hintFg, marginBottom: 16, paddingRight: 32 }}
        >
          {isReply ? 'REPLY' : isQuote ? 'QUOTE' : 'NOTE'}
        </div>
        {isReply && replyTarget && (
          <div
            style={{
              background: TOKENS.bannerBg,
              padding: '10px 12px',
              marginBottom: 16,
            }}
          >
            <div
              className="label-ui"
              style={{ color: TOKENS.hintFg }}
            >
              Replying to {replyTarget.authorName}
            </div>
            {replyTarget.excerpt && (
              <p
                className="font-serif italic text-[13px] mt-1"
                style={{ color: TOKENS.bannerFg, lineHeight: 1.45 }}
              >
                {replyTarget.excerpt}
              </p>
            )}
          </div>
        )}

        {isQuote && quoteTarget && (
          <div
            style={{
              background: TOKENS.bannerBg,
              padding: '10px 12px',
              marginBottom: 16,
              borderLeft: `4px solid ${TOKENS.panelBorder}`,
            }}
          >
            <div className="label-ui" style={{ color: TOKENS.hintFg }}>
              Quoting{' '}
              {quoteTarget.previewAuthorName ??
                (quoteTarget.authorPubkey
                  ? `${quoteTarget.authorPubkey.slice(0, 10)}…`
                  : (quoteTarget.quotedSource ?? 'a post'))}
            </div>
            {quoteTarget.previewTitle && (
              <p
                className="font-sans text-ui-xs mt-1"
                style={{ color: TOKENS.bannerFg, fontWeight: 500 }}
              >
                {quoteTarget.previewTitle}
              </p>
            )}
            {quoteTarget.previewContent && (
              // Clamped for the BANNER only. previewContent is the snapshot that
              // gets stored (quotePreviewContent — a whole note, up to 1000
              // chars), which is right for the inset a reader later expands and
              // far too much for a strip above the textarea.
              <p
                className="font-serif italic text-[13px] mt-1 line-clamp-3"
                style={{ color: TOKENS.bannerFg, lineHeight: 1.45 }}
              >
                {quoteTarget.previewContent}
              </p>
            )}
          </div>
        )}

        <textarea
          ref={bodyRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What are you thinking?"
          className="font-serif text-[16px] w-full flex-1"
          style={{
            background: TOKENS.fieldBg,
            padding: '12px 14px',
            minHeight: 160,
            resize: 'none',
            outline: 'none',
            lineHeight: 1.55,
            marginTop: 16,
          }}
        />
        {showNudge && (
          <div
            style={{
              marginTop: 8,
              padding: '10px 12px',
              background: TOKENS.bannerBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <span className="font-sans text-ui-xs" style={{ color: TOKENS.bannerFg }}>
              This is getting long. Switch to article mode?
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={openArticleEditor}
                className="label-ui"
                data-explain="composer.article"
                style={{
                  padding: '6px 10px',
                  background: TOKENS.publishBg,
                  color: TOKENS.publishFg,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Switch
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowNudge(false)
                  setNudgeDismissed(true)
                }}
                className="label-ui"
                style={{
                  padding: '6px 10px',
                  background: 'transparent',
                  color: TOKENS.hintFg,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </span>
          </div>
        )}
        {!isReply && !isQuote && (
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <button
              type="button"
              onClick={openArticleEditor}
              className="font-sans text-ui-xs"
              data-explain="composer.article"
              style={{
                background: 'transparent',
                border: 'none',
                color: TOKENS.hintFg,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Make this an article →
            </button>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 12,
            gap: 16,
          }}
        >
          <div className="font-mono text-mono-xs" style={{ color: TOKENS.hintFg }}>
            {error ? (
              <span style={{ color: TOKENS.errorFg }}>{error}</span>
            ) : isReply || isQuote ? (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            ) : !broadcastNostrSelected ? (
              <span style={{ color: TOKENS.errorFg }}>
                Cross-protocol broadcast needs Nostr as the anchor. Include Nostr to publish.
              </span>
            ) : crossPostTargets.length > 0 ? (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                Publishing to Nostr ·{' '}
                {crossPostTargets.map((t) => PROTOCOL_LABELS[t.protocol]).join(' · ')} —{' '}
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            ) : (
              <span style={{ color: overLimit ? TOKENS.errorFg : TOKENS.hintFg }}>
                {charCount}/{NOTE_CHAR_LIMIT}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Per-send cross-post pills — one per valid linked network, seeded
                from cross_post_default. Only plain notes cross-post from this
                composer (replies/quotes publish through their own paths). */}
            {!isReply && !isQuote &&
              linkedProtocols.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setCrossPostOn((prev) => ({ ...prev, [p]: !prev[p] }))}
                  className={`label-ui toggle-chip ${crossPostOn[p] ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                  data-explain="composer.crosspost"
                  title={
                    crossPostOn[p]
                      ? `Will also post to ${PROTOCOL_LABELS[p]} (@${linkedByProtocol[p]?.externalHandle ?? ''})`
                      : `Not posting to ${PROTOCOL_LABELS[p]} this time`
                  }
                >
                  {PROTOCOL_LABELS[p]}
                </button>
              ))}
            <button
              type="button"
              onClick={handlePublish}
              disabled={!canPublish}
              className="font-sans text-ui-xs"
              style={{
                padding: '8px 16px',
                background: canPublish ? TOKENS.publishBg : TOKENS.publishDisabled,
                color: TOKENS.publishFg,
                border: 'none',
                cursor: canPublish ? 'pointer' : 'default',
              }}
            >
              {publishing
                ? isReply
                  ? 'Replying…'
                  : isQuote
                    ? 'Quoting…'
                    : 'Publishing…'
                : isReply
                  ? 'Reply'
                  : isQuote
                    ? 'Quote'
                    : 'Publish'}
            </button>
          </div>
        </div>
      </div>
    </Glasshouse>
  )
}
