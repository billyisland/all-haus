import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ChangeEvent } from 'react'
import { useAuth } from '../stores/auth'
import { publishNote } from '../lib/publishNote'
import { failureSentence } from '../lib/api/client'
import {
  NOTE_CHAR_LIMIT,
  crossPostAccounts as crossPostCapable,
  quoteUrlReserve as quoteUrlReserveFor,
  type CrossPostTarget,
  type QuoteTarget,
} from '../lib/note-compose'
import type { NoteEvent } from '../lib/ndk'
import type { LinkedAccount } from '../lib/api'
import { useMediaAttachments } from './useMediaAttachments'
import { useLinkedAccounts, useLinkedAccountsFailed } from './useLinkedAccounts'
import { useEditorOverlay, seedFromNote } from '../stores/editorOverlay'
import { activeGlasshouseRect } from '../components/workspace/Glasshouse'
import { prefetchEditorOverlay } from '../components/workspace/prefetchEditor'

// =============================================================================
// useNoteComposer — the whole BEHAVIOUR of a short-form compose surface, shared
// by the two there are (the global `ComposeOverlay` and the workspace
// `Composer`), which now differ in presentation and nothing else.
//
// The compose-surfaces rule said "a change to one owes the other the same", and
// a rule kept by remembering drifted by nine things (walkthrough A3): the
// workspace box — the one a member normally meets — had no pictures, no embed
// previews, no dirty-close confirm, refused an image-only post, counted the
// text without the image URLs that ship with it, and seeded its cross-post
// pills from the member's defaults where the overlay ignored them; the overlay
// posted on a bare Enter, offered a network that cannot receive an original
// post, and let an external quote's appended URL push a note over the index's
// limit. One hook is the construction that stops the next one.
// =============================================================================

// The ceiling, the networks a note can be cross-posted to and their labels
// live in `lib/note-compose.ts`, shared with the plain-HTML register; they are
// re-exported here for the surfaces that already import them from the hook.
export { NOTE_CHAR_LIMIT, CROSS_POST_LABELS } from '../lib/note-compose'

interface Options {
  open: boolean
  /** Non-null means the note is published as a quote of this target. */
  quoteTarget: QuoteTarget | null
  /** The state-clearing close — after a publish, and the confirmed dismiss. */
  close: () => void
  onPublished?: (note: NoteEvent) => void
}

export function useNoteComposer({ open, quoteTarget, close, onPublished }: Options) {
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(false)
  // Per-send overrides of each account's `crossPostDefault`. The DEFAULT is
  // the member's own setting (the "Default on" box in Reach other networks) and
  // the pill is the per-note override, so what is stored here is only what the
  // writer changed — which is also what makes a late linked-accounts load land
  // correctly: there is nothing to re-seed.
  const [crossPostOverrides, setCrossPostOverrides] = useState<Record<string, boolean>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Set by `onSupersede` for every superseder EXCEPT the editor escalation,
  // which is a real handover and carries the text with it. Read on the next
  // opening, which otherwise starts a fresh note.
  const supersededRef = useRef(false)
  const escalatingRef = useRef(false)
  const media = useMediaAttachments()
  const linkedAccounts = useLinkedAccounts()
  const linkedAccountsFailed = useLinkedAccountsFailed()

  const isQuote = !!quoteTarget

  // A SUPERSEDE IS NOT A DISCARD. Every opening is a fresh note except one that
  // follows a supersede — any ∀-menu destination, a profile opened from a
  // byline — where the writer never said to throw it away. Opening also warms
  // the article-editor chunk: the escalation is one click away and that chunk
  // is fetched, not bundled.
  useEffect(() => {
    if (!open) return
    if (supersededRef.current) {
      supersededRef.current = false
      setConfirmDismiss(false)
    } else {
      setContent('')
      setPublishing(false)
      setError(null)
      setConfirmDismiss(false)
      setNudgeDismissed(false)
      setCrossPostOverrides({})
      media.reset()
    }
    // The editor chunk is warmed only for someone who can reach it.
    if (useAuth.getState().user?.canWrite === true) prefetchEditorOverlay()
    const t = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(t)
    // `media.reset` is stable; the effect is about the opening edge alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const imageCount = media.attachments.filter((a) => a.type === 'image').length
  // An image-only note is a note.
  const hasContent = content.trim().length > 0 || imageCount > 0

  // The count is of what SHIPS: the text plus every image URL `buildContent`
  // appends, plus — for an external quote — the "\n\n<url>" `publishNote`
  // appends. A body within the limit in the box must not produce an over-limit
  // note: the relay accepts the signed event and the index POST
  // (content.max(1000)) refuses it, orphaning the event on the relay.
  const quoteUrlReserve = quoteUrlReserveFor(quoteTarget)
  const charCount = media.totalCharCount(content) + quoteUrlReserve
  const isOver = charCount > NOTE_CHAR_LIMIT
  const canPost = !!user && hasContent && !isOver && !publishing && !media.uploading

  // THE OFFER ARRIVES WHERE THE WALL IS — over the limit, in the unit the
  // surface enforces. Only a plain note escalates; a quote belongs to the post
  // it quotes. Dismissible per opening.
  //
  // AND ONLY A WRITER IS OFFERED AN ARTICLE (READER-WRITER-SPLIT-ADR §6.2): a
  // reader's escalation would land on the editor's explanation, with the note
  // left behind. Over the limit, a reader's banner says the one way on —
  // shorten it — rather than nothing, since Post has just gone dead.
  const canEscalate = user?.canWrite === true && !isQuote
  const showNudge = isOver && !nudgeDismissed && canEscalate
  const showTooLong = isOver && !isQuote && !canEscalate

  const crossPostAccounts = useMemo(
    () =>
      isQuote
        ? []
        : crossPostCapable(linkedAccounts ?? []),
    [linkedAccounts, isQuote],
  )
  const isCrossPostOn = useCallback(
    (a: LinkedAccount) => crossPostOverrides[a.id] ?? a.crossPostDefault,
    [crossPostOverrides],
  )
  const toggleCrossPost = useCallback(
    (a: LinkedAccount) =>
      setCrossPostOverrides((prev) => ({ ...prev, [a.id]: !(prev[a.id] ?? a.crossPostDefault) })),
    [],
  )
  const activeCrossPosts = crossPostAccounts.filter(isCrossPostOn)

  // The one escalation path, shared by the standing button and the banner.
  // THE PANE IS NOT CLOSED HERE: the editor's pane supersedes this one at the
  // moment it mounts, so the two cross in a single commit, and `enterFrom`
  // hands the newcomer this pane's box so it grows out of it. The attachments
  // go with the body — they are uploaded blobs held OUTSIDE the text, so
  // nothing else would carry them.
  const escalateToArticle = useCallback(() => {
    escalatingRef.current = true
    useEditorOverlay.getState().open({
      ...seedFromNote(content, media.attachments),
      enterFrom: activeGlasshouseRect(),
    })
  }, [content, media.attachments])

  const handlePost = useCallback(async () => {
    if (!canPost || !user) return
    setPublishing(true)
    setError(null)
    try {
      const finalContent = media.buildContent(content)
      // A quote carries no cross-posts (it publishes through its own path),
      // so `activeCrossPosts` is empty for one by construction.
      const crossPosts: CrossPostTarget[] = activeCrossPosts.map((a) => ({
        linkedAccountId: a.id,
        actionType: 'original' as const,
      }))
      const result = await publishNote(
        finalContent,
        user.pubkey,
        quoteTarget ?? undefined,
        crossPosts.length > 0 ? crossPosts : undefined,
      )
      onPublished?.({
        type: 'note',
        id: result.noteEventId,
        pubkey: user.pubkey,
        content: finalContent,
        publishedAt: Math.floor(Date.now() / 1000),
        quotedEventId: quoteTarget && !quoteTarget.isExternal ? quoteTarget.eventId : undefined,
      })
      setPublishing(false)
      close()
    } catch (err) {
      setError(failureSentence(err, 'Couldn’t post your note. It’s still here, so please try again.'))
      setPublishing(false)
    }
  }, [canPost, user, media, content, activeCrossPosts, quoteTarget, onPublished, close])

  // The single close path, wired to Glasshouse's scrim / ✕ / Escape. A publish
  // in flight is not dismissed out from under itself, and a dirty box takes a
  // two-step confirm.
  const dismiss = useCallback(() => {
    if (publishing) return
    if (hasContent && !confirmDismiss) {
      setConfirmDismiss(true)
      return
    }
    setConfirmDismiss(false)
    close()
  }, [publishing, hasContent, confirmDismiss, close])

  // For Glasshouse's `onSupersede`. The escalation is a handover (the body
  // travels into the editor), so its close really does clear; every other
  // superseder leaves a draft to come back to. The surface decides what the
  // close itself means for its host — `onSuspend` or `close`.
  const onSupersede = useCallback((onSuspend: () => void) => {
    if (escalatingRef.current) {
      escalatingRef.current = false
      close()
      return
    }
    supersededRef.current = true
    onSuspend()
  }, [close])

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setContent(val)
    setConfirmDismiss(false)
    media.detectEmbeds(val)
  }

  // ENTER IS A NEWLINE. A note is prose with line breaks the published card
  // keeps (`whitespace-pre-wrap`), so a bare Enter that posts takes away the
  // one key the writer needs for them — and posts a half-written thought.
  // Cmd/Ctrl+Enter posts, on both surfaces.
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handlePost()
    }
  }

  function clearError() {
    setError(null)
    media.clearError()
  }

  return {
    content,
    textareaRef,
    handleChange,
    handleKeyDown,
    media,
    charCount,
    isOver,
    canPost,
    publishing,
    displayError: error ?? media.error,
    clearError,
    confirmDismiss,
    dismiss,
    onSupersede,
    showNudge,
    showTooLong,
    canEscalate,
    dismissNudge: () => setNudgeDismissed(true),
    escalateToArticle,
    isQuote,
    crossPostAccounts,
    isCrossPostOn,
    toggleCrossPost,
    activeCrossPosts,
    // An outage is NOT "you have linked nothing": the member's other networks
    // are what the pills are for, so silence would let them press Post
    // believing it goes out everywhere it usually does.
    linkedAccountsFailed: !isQuote && linkedAccountsFailed,
    handlePost,
  }
}
