'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { useAuth } from '../../stores/auth'
import { createAutoSaver, createDraftTargeter, type SavedDraft } from '../../lib/drafts'
import { ImageUpload } from './ImageUpload'
import { TagInput } from './TagInput'
import { PAYWALL_GATE_MARKER } from './PaywallGateNode'
import { splitAtGateMarker, gatePositionPct as gatePositionFor } from '../../lib/gate-marker'
import { markdownExtensions, promptForLink } from './extensions'
import { uploadImage, isEmbeddableUrl } from '../../lib/media'
import { failureSentence } from '../../lib/api/client'
import { validatePaywalledPublish } from '../../lib/publish-validation'
import { NAV_BAR_H } from '../workspace/NavBar'
import { toDateTimeLocalValue, formatDateInputEcho, formatPrice } from '../../lib/format'
import { auth as authApi } from '../../lib/api'
import { TermsConsent } from '../legal/TermsConsent'
import { TERMS_PURPOSE, termsVersionMismatch, TERMS_ACCEPT_FAILED, WRITER_TERMS_LEAD, TERMS_ACCEPT_AND_CONTINUE } from '../../content/terms-consent'

// =============================================================================
// Article Editor
//
// Rich text editor with:
//   - WYSIWYG with markdown shortcuts
//   - Inline paywall gate marker (visible divider, not a slider)
//   - Image upload via gateway (drag-and-drop, paste, file picker)
//   - Rich media embedding via oEmbed
//   - Character/word count
//   - NIP-23 markdown serialisation on publish
//   - Auto-save to drafts
//   - Edit mode for updating published articles
// =============================================================================

interface EditorProps {
  initialTitle?: string
  initialDek?: string
  initialContent?: string
  initialGatePosition?: number
  initialPrice?: number
  initialCommentsEnabled?: boolean
  initialTags?: string[]
  initialCoverImageUrl?: string | null
  /** Set when reopening a saved draft — pins every save to that exact row. */
  initialDraftId?: string | null
  editingEventId?: string
  editingDTag?: string
  publicationMemberships?: PublicationContext[]
  initialPublicationId?: string | null
  onPublish?: (data: PublishData) => void | Promise<void>
  onSchedule?: (data: PublishData, scheduledAt: string) => Promise<void>
  /** 'page' = standalone /write (full-page frame, clearing the nav row's band);
   *  'overlay' = inside the EditorOverlay Glasshouse pane (no frame/band). */
  chrome?: 'page' | 'overlay'
}

export interface PublicationContext {
  id: string
  slug: string
  name: string
  can_publish: boolean
  default_article_price_pence?: number
}

export interface PublishData {
  title: string
  dek: string
  content: string
  freeContent: string
  paywallContent: string
  isPaywalled: boolean
  pricePence: number
  gatePositionPct: number
  commentsEnabled: boolean
  publicationId?: string | null
  showOnWriterProfile: boolean
  sendEmail?: boolean
  tags: string[]
  coverImageUrl?: string | null
  /** The working draft row, if one exists — deleted after a successful publish. */
  draftId?: string | null
}

export function ArticleEditor({
  initialTitle = '',
  initialDek = '',
  initialContent = '',
  initialGatePosition = 50,
  initialPrice,
  initialCommentsEnabled = true,
  initialTags = [],
  initialCoverImageUrl = null,
  initialDraftId = null,
  editingEventId,
  editingDTag,
  publicationMemberships = [],
  initialPublicationId = null,
  onPublish,
  onSchedule,
  chrome = 'page',
}: EditorProps) {
  const { user } = useAuth()
  const isOverlay = chrome === 'overlay'

  const [title, setTitle] = useState(initialTitle)
  const [dek, setDek] = useState(initialDek)
  const defaultPrice = initialPrice ?? user?.defaultArticlePricePence ?? 0
  const [pricePence, setPricePence] = useState(defaultPrice)
  const [commentsEnabled, setCommentsEnabled] = useState(initialCommentsEnabled)
  const [articleTags, setArticleTags] = useState<string[]>(initialTags)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  // ONE timer for the status line (CA-E8). Five uncancelled 2s clears used to
  // wipe a sticky "Save failed" whenever a "Saved" had fired in the 2s before
  // it (an autosave, then a manual save that failed). Every status goes
  // through here: the pending clear is cancelled first, and only a transient
  // status schedules one.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showDraftStatus = (text: string, transient = false) => {
    if (statusTimer.current) clearTimeout(statusTimer.current)
    statusTimer.current = transient
      ? setTimeout(() => { statusTimer.current = null; setDraftStatus(null) }, 2000)
      : null
    setDraftStatus(text)
  }
  useEffect(() => () => { if (statusTimer.current) clearTimeout(statusTimer.current) }, [])
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(initialDraftId ?? null)
  const [uploading, setUploading] = useState(false)
  const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(initialPublicationId)
  const [showOnWriterProfile, setShowOnWriterProfile] = useState(true)
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(initialCoverImageUrl ?? null)
  const [coverUploading, setCoverUploading] = useState(false)
  // The cover is one article-lifetime decision, so it is a toolbar button that
  // opens a panel on press — not a permanent 50px band above the writing
  // surface. The button's own ✓ says whether one is set, so the panel does not
  // have to stand open to report it (same grammar as Paywall).
  const [coverOpen, setCoverOpen] = useState(false)
  const [showPublishConfirm, setShowPublishConfirm] = useState(false)
  const [sendEmail, setSendEmail] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [showSchedulePicker, setShowSchedulePicker] = useState(false)
  const [scheduleDateTime, setScheduleDateTime] = useState('')
  // THE FIRST PAYWALLED PUBLISH IS WHERE THE WRITER AGREEMENT IS ACCEPTED (A3).
  // Pre-flighted off the session payload so the writer meets the document
  // BEFORE the piece is signed rather than as a 403 afterwards — the gateway
  // refuses either way, and this is only the polite half.
  //
  // The pending action is held because the gate interrupts a press that was
  // already made, and accepting should finish that press rather than ask for
  // it again. It is a ref and not state: nothing renders from it.
  const [showWriterTerms, setShowWriterTerms] = useState(false)
  const [writerTermsChecked, setWriterTermsChecked] = useState(false)
  const [acceptingWriterTerms, setAcceptingWriterTerms] = useState(false)
  const pendingPaidAction = useRef<null | (() => void | Promise<void>)>(null)

  const isEditing = !!editingEventId
  const userSetPrice = useRef(!!initialPrice || user?.defaultArticlePricePence != null)
  // The ref is what onUpdate's closure reads; this is what the render reads, so
  // the suggestion line can step aside the moment the writer names a price.
  const [priceIsOwn, setPriceIsOwn] = useState(userSetPrice.current)
  const selectedPub = publicationMemberships.find(p => p.id === selectedPublicationId)

  // Refs so the onUpdate closure always sees current values
  const titleRef = useRef(title)
  titleRef.current = title
  const dekRef = useRef(dek)
  dekRef.current = dek
  const pricePenceRef = useRef(pricePence)
  pricePenceRef.current = pricePence
  const coverImageUrlRef = useRef(coverImageUrl)
  coverImageUrlRef.current = coverImageUrl
  const commentsEnabledRef = useRef(commentsEnabled)
  commentsEnabledRef.current = commentsEnabled
  const currentDraftIdRef = useRef(currentDraftId)
  currentDraftIdRef.current = currentDraftId
  const editorRef = useRef<Editor | null>(null)
  // Set once the article is published/scheduled — its working draft is disposed
  // (publish-now deletes it; schedule owns it), so the unmount flush must NOT
  // recreate it (that was the "draft + published article, both listed" bug).
  const disposedRef = useRef(false)

  // Every save of the working draft goes through ONE targeter, so a new
  // piece's first save mints its own row (never the gateway's guess, which
  // overwrote an unrelated draft) and a second save racing it lands on that
  // same row (lib/drafts.ts › createDraftTargeter).
  const saveWorkingDraft = useMemo(() => createDraftTargeter(), [])
  const autoSaver = useMemo(() => createAutoSaver(3000, saveWorkingDraft), [saveWorkingDraft])

  // A DraftData snapshot from the current refs. Always carries the known
  // draftId/dTag so a save TARGETS the existing row (never re-guesses — the
  // duplicate-draft invariant).
  const snapshotDraft = useCallback(() => ({
    title: titleRef.current,
    dek: dekRef.current,
    content: editorRef.current?.storage.markdown.getMarkdown() ?? '',
    gatePositionPct: 50,
    pricePence: pricePenceRef.current,
    coverImageUrl: coverImageUrlRef.current,
    commentsEnabled: commentsEnabledRef.current,
    draftId: currentDraftIdRef.current ?? undefined,
    dTag: editingDTag,
  }), [editingDTag])

  // ONE DEFINITION OF "SAVE WHAT IS IN THE BUFFER", so Preview, Save draft and
  // teardown cannot disagree about what a saved draft is. All three want the
  // same three things and always did — cancel the pending autosave, skip the
  // write when nothing changed, and never spawn an empty draft row — and until
  // this existed only teardown did all three: `Save draft` called `saveDraft`
  // unconditionally, so pressing it on an empty editor minted a row.
  //
  // Returns the draft's id once the server holds this buffer, or null when
  // there is nothing worth saving. The not-dirty case still returns an id when
  // one exists: the row IS current, which is what a caller about to open a
  // preview of it needs to hear.
  const flushDraft = useCallback(async (): Promise<string | null> => {
    autoSaver.cancel()
    // Published or scheduled — the working draft is disposed and must not be
    // recreated (the "draft + published article, both in the dashboard" bug).
    if (disposedRef.current) return null
    const data = snapshotDraft()
    const hasContent = !!(data.title.trim() || data.content.trim() || data.dek.trim())
    if (!hasContent) return null
    if (!autoSaver.isDirty(data)) return currentDraftIdRef.current ?? null
    const saved = await saveWorkingDraft(data)
    autoSaver.markSaved(data)
    setCurrentDraftId(saved.draftId)
    return saved.draftId
  }, [autoSaver, snapshotDraft, saveWorkingDraft])

  // Flush any unsaved work on unmount instead of silently dropping it (M21).
  // The editor closes far more often as an overlay than the old /write page
  // did, and title/dek/price-only changes (or edits within the 3s debounce
  // window) had no persisted state. Fire-and-forget so teardown isn't blocked —
  // which is also why it calls `flushDraft` without awaiting it and swallows
  // the rejection: a component coming apart has nowhere to report one.
  useEffect(() => () => {
    void flushDraft().catch(() => {})
  }, [flushDraft])

  const handleCoverUpload = useCallback(async (file: File) => {
    setCoverUploading(true)
    setPublishError(null)
    try {
      const result = await uploadImage(file)
      setCoverImageUrl(result.url)
    } catch (err) {
      setPublishError(failureSentence(err, 'Couldn’t upload the cover image. Please try again.'))
    } finally {
      setCoverUploading(false)
    }
  }, [])

  const editor = useEditor({
    extensions: [
      // Everything with a markdown boundary — StarterKit, tiptap-markdown, the
      // link mark, the embed and the paywall gate — comes from the one home the
      // round-trip suite also runs, so an extension that serialises cannot be
      // registered in one and not the other. What follows takes no part in
      // markdown and is the editor's alone.
      ...markdownExtensions(),
      ImageUpload.configure({
        onUploadStart: () => setUploading(true),
        onUploadEnd: () => setUploading(false),
        onUploadError: (err) => {
          setUploading(false)
          setPublishError(failureSentence(err, 'Couldn’t upload that image. Please try again.'))
        },
      }),
      Placeholder.configure({
        placeholder: 'Start writing…',
      }),
      CharacterCount,
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        // `flex-1` fills the white page when its parent is a flex column (the
        // overlay); inert on /write, where the parent is plain flow.
        class: 'prose prose-lg max-w-none focus:outline-none min-h-[400px] flex-1',
      },
    },
    onUpdate: ({ editor }) => {
      // Auto-suggest price based on word count (unless the user set one manually)
      if (!userSetPrice.current) {
        const words = editor.storage.characterCount.words()
        const suggested = suggestPrice(words)
        setPricePence(suggested)
        pricePenceRef.current = suggested
      }

      // Auto-save draft — pinned to the working row via draftId (dTag covers
      // the first save when editing a published article, so the edit draft
      // never shadows an unrelated new-article draft)
      const content = editor.storage.markdown.getMarkdown()
      autoSaver(
        { title: titleRef.current, dek: dekRef.current, content, gatePositionPct: 50, pricePence: pricePenceRef.current, coverImageUrl: coverImageUrlRef.current, commentsEnabled: commentsEnabledRef.current, draftId: currentDraftIdRef.current ?? undefined, dTag: editingDTag },
        (saved) => {
          setCurrentDraftId(saved.draftId)
          showDraftStatus('Saved', true)
        },
        () => showDraftStatus('Couldn’t save the draft')
      )
    },
  })
  editorRef.current = editor

  // Seed the autosaver with the loaded snapshot once the editor exists (§0f-4).
  // lastSaved starts "" inside createAutoSaver, so an untouched open-then-close
  // otherwise reads dirty and the unmount flush saves — which, for a published
  // article opened via Edit (dTag set), MINTS a fresh draft row through the
  // (writer_id, nostr_d_tag) upsert: "draft + published article, both in the
  // dashboard", the exact class the one-draft invariant bans. The editor mounts
  // only after init populated every initial* prop, so this snapshot is the true
  // loaded state.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!editor || seededRef.current) return
    seededRef.current = true
    autoSaver.markSaved(snapshotDraft())
  }, [editor, autoSaver, snapshotDraft])

  // Autosave on metadata changes too (M21) — the TipTap onUpdate above only
  // fires on BODY edits, so a title/dek/price/cover/comments change scheduled
  // nothing. Skip the initial mount (nothing dirtied yet) and only fire once
  // the editor exists so the snapshot has real content.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!editor) return
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    autoSaver(
      snapshotDraft(),
      (saved) => {
        setCurrentDraftId(saved.draftId)
        showDraftStatus('Saved', true)
      },
      () => showDraftStatus('Couldn’t save the draft'),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, dek, pricePence, coverImageUrl, commentsEnabled, editor])

  // Check if a paywall gate marker exists in the document
  const hasGateMarker = useCallback(() => {
    if (!editor) return false
    let found = false
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'paywallGate') {
        found = true
        return false
      }
    })
    return found
  }, [editor])

  // Does this press need the Writer Agreement first? Asked at the PRESS and not
  // during render, because the answer depends on the document's current
  // contents and a render-time read would go stale the moment a gate marker is
  // typed or deleted. Returns true when it has taken over — the caller stops.
  const paidActionNeedsTerms = useCallback(
    (resume: () => void | Promise<void>) => {
      if (!hasGateMarker()) return false
      // Absent session ⇒ no claim either way; the gateway is the guard and it
      // will say so. Never assume "accepted" from an unhydrated store.
      if (user?.terms.writer.isCurrent !== false) return false
      pendingPaidAction.current = resume
      setWriterTermsChecked(false)
      setPublishError(null)
      setShowWriterTerms(true)
      return true
    },
    [hasGateMarker, user],
  )

  const acceptWriterTerms = useCallback(async () => {
    const version = user?.terms.writer.current
    if (!version) return
    setAcceptingWriterTerms(true)
    setPublishError(null)
    try {
      await authApi.acceptTerms('writer', version)
      await useAuth.getState().fetchMe()
      setShowWriterTerms(false)
      const resume = pendingPaidAction.current
      pendingPaidAction.current = null
      await resume?.()
    } catch (err: any) {
      // A refusal here means the text moved between render and press. Say so
      // and leave the gate standing, rather than publishing under the version
      // the client happened to be holding.
      setPublishError(
        err?.body?.error === 'terms_version_mismatch'
          ? termsVersionMismatch('writer')
          : TERMS_ACCEPT_FAILED,
      )
      await useAuth.getState().fetchMe()
    } finally {
      setAcceptingWriterTerms(false)
    }
  }, [user])

  const handlePublish = useCallback(async () => {
    if (!editor || !title.trim()) return

    // A debounced autosave landing mid-publish could recreate the draft row
    // after the publish flow deletes it — drop any pending save first.
    autoSaver.cancel()
    setPublishing(true)
    setPublishError(null)
    setShowPublishConfirm(false)

    try {
      const fullContent = editor.storage.markdown.getMarkdown()
      const isPaywalled = hasGateMarker()

      let freeContent = fullContent
      let paywallContent = ''
      let gatePositionPct = 0

      if (isPaywalled) {
        const splitResult = splitAtGateMarker(fullContent)
        freeContent = splitResult.free
        paywallContent = splitResult.paywall
        // Calculate approximate gate position for the DB
        gatePositionPct = gatePositionFor(freeContent, paywallContent)
      }

      const validationError = validatePaywalledPublish({
        isPaywalled,
        paywallContent,
        pricePence,
        publicationId: selectedPublicationId,
      })
      if (validationError) {
        setPublishError(validationError)
        return
      }

      const data: PublishData = {
        title: title.trim(),
        dek: dek.trim(),
        content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
        freeContent,
        paywallContent,
        isPaywalled,
        pricePence: isPaywalled ? pricePence : 0,
        gatePositionPct,
        commentsEnabled,
        publicationId: selectedPublicationId,
        showOnWriterProfile,
        sendEmail: isEditing ? false : sendEmail,
        tags: articleTags,
        coverImageUrl,
        draftId: currentDraftId,
      }

      if (onPublish) {
        // Set BEFORE the await (§0f-4): onPublish closes the overlay inside
        // itself, so React can commit the unmount before this continuation
        // resumes — a flag set after the await leaves the flush seeing
        // disposed=false and re-saving the just-deleted draft. Reset on catch.
        disposedRef.current = true
        await onPublish(data)
      }
    } catch (err) {
      disposedRef.current = false // publish failed — the draft still exists
      console.error('Publish error:', err)
      setPublishError(failureSentence(err, 'Couldn’t publish the article. Your draft is still here, so please try again.'))
    } finally {
      setPublishing(false)
    }
  }, [editor, title, dek, pricePence, onPublish, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, sendEmail, isEditing, articleTags, coverImageUrl, currentDraftId, autoSaver])

  // Show the publish confirmation panel for new personal articles;
  // submit-for-review and edits skip confirmation and go straight through.
  const handlePublishClick = useCallback(() => {
    const isSubmitForReview = selectedPub && !selectedPub.can_publish
    const proceed = () => {
      if (isEditing || isSubmitForReview) {
        void handlePublish()
      } else {
        setSendEmail(true)
        setShowPublishConfirm(true)
      }
    }
    // Gated here rather than inside `handlePublish`, so that it also catches
    // the EDIT path — which skips the confirmation panel entirely and would
    // otherwise go straight to the gateway's 403.
    if (paidActionNeedsTerms(proceed)) return
    proceed()
  }, [isEditing, selectedPub, handlePublish, paidActionNeedsTerms])

  const runSchedule = useCallback(async () => {
    if (!editor || !title.trim() || !scheduleDateTime || !onSchedule) return

    // Same as publish: a pending autosave must not race the schedule save.
    autoSaver.cancel()
    setPublishing(true)
    setPublishError(null)

    try {
      const fullContent = editor.storage.markdown.getMarkdown()
      const isPaywalled = hasGateMarker()

      let freeContent = fullContent
      let paywallContent = ''
      let gatePositionPct = 0

      if (isPaywalled) {
        const splitResult = splitAtGateMarker(fullContent)
        freeContent = splitResult.free
        paywallContent = splitResult.paywall
        gatePositionPct = gatePositionFor(freeContent, paywallContent)
      }

      const validationError = validatePaywalledPublish({
        isPaywalled,
        paywallContent,
        pricePence,
        publicationId: selectedPublicationId,
      })
      if (validationError) {
        setPublishError(validationError)
        return
      }

      // Save onto the piece's OWN row first, and schedule that row. With no id
      // yet (typed and scheduled inside the autosave's debounce, or while its
      // first save is still in flight), the schedule's save would otherwise
      // have nothing to target — and the gateway's guess is somebody else's
      // draft. `flushDraft` goes through the targeter, so it waits for an
      // in-flight first save rather than minting a second row.
      const draftId = (await flushDraft()) ?? currentDraftIdRef.current

      const data: PublishData = {
        title: title.trim(),
        dek: dek.trim(),
        content: fullContent.replace(PAYWALL_GATE_MARKER, '').trim(),
        freeContent,
        paywallContent,
        isPaywalled,
        pricePence: isPaywalled ? pricePence : 0,
        gatePositionPct,
        commentsEnabled,
        publicationId: selectedPublicationId,
        showOnWriterProfile,
        sendEmail: false,
        tags: articleTags,
        coverImageUrl,
        draftId,
      }

      // Set BEFORE the await (§0f-4) — same unmount race as handlePublish.
      disposedRef.current = true
      await onSchedule(data, new Date(scheduleDateTime).toISOString())
    } catch (err) {
      disposedRef.current = false // schedule failed — the draft still exists
      console.error('Schedule error:', err)
      setPublishError(failureSentence(err, 'Couldn’t schedule the article. Your draft is still here, so please try again.'))
    } finally {
      setPublishing(false)
      setShowSchedulePicker(false)
      setScheduleDateTime('')
    }
  }, [editor, title, dek, pricePence, onSchedule, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, articleTags, scheduleDateTime, coverImageUrl, autoSaver, flushDraft])

  // Scheduling paid access is selling it, just later: `POST
  // /drafts/:id/schedule` refuses a paywalled draft the same way the publish
  // route does, so the writer is asked at the gesture rather than finding the
  // piece silently un-scheduled days afterwards.
  const handleScheduleSubmit = useCallback(() => {
    if (paidActionNeedsTerms(runSchedule)) return
    void runSchedule()
  }, [paidActionNeedsTerms, runSchedule])

  if (!editor) return null

  const wordCount = editor.storage.characterCount.words()
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const gateInserted = hasGateMarker()

  return (
    // data-explain: the editor's Explain base kind (C2) — answers any interior
    // hover a more specific leaf doesn't. Inert on the standalone /write page
    // (Explain only runs in the workspace).
    <div data-explain="editor" className={isOverlay ? 'px-6 sm:px-10 py-8 flex-1 flex flex-col' : 'mx-auto max-w-editor-frame px-4 sm:px-6 pb-8 bg-glasshouse min-h-screen ah-clear-bar-band'}>
      {/* THE DOCUMENT COLUMN. Everything the writer touches sits in one centred
          column, capped at `.ah-measure` — the READER's own column, and, when
          the pane is stretched, the reader's own curve (lib/workspace/measure.ts,
          published as `--ah-measure` by Glasshouse). Without a cap the measure is
          whatever the pane leaves over (the body is `prose … max-w-none`), which
          a 1000px pane made 840 and a stretched one far worse.

          IT WAS A HARD 640, AND THE CAP MOVING IS A DELIBERATE TRADE (operator
          decision, 2026-09-12). A fixed 640 made widening the pane strictly
          fidelity-preserving — editor prose and reader prose were the same 640 at
          18px/32, so line breaks, image scale and where the paywall gate falls
          could not move on publish — but it also meant a stretched pane bought
          the writer nothing at all but parchment. `ArticleReader` now takes the
          SAME class, so the two are still one geometry at any given pane width;
          what is given up is that a piece no longer has one canonical measure
          across panes of different widths, which across devices it never had.

          Outside a pane (/write) the class falls back to `maxWidth.article`, so
          the standalone editor is pixel-unchanged: its frame is already
          `max-w-editor-frame` (780), the cap trims ~12px there as before, and it
          stays correct if that frame ever widens. */}
      {/* `ah-editor-column` is the focus fade's anchor as well as the column:
          the toolbar is an earlier SIBLING of the body, so the column's
          `:has(.ProseMirror-focused)` is what lets the body's focus reach it
          (globals.css § 1g). */}
      <div className={`ah-editor-column ah-measure w-full mx-auto ${isOverlay ? 'flex-1 flex flex-col min-w-0' : ''}`}>
      {/* Title card — DOCUMENT, not a tool, so it scrolls away like a real
          page rather than standing permanently over the writing surface.
          The right inset (pr-12) clears the pane's floating ✕, and it is needed
          ONLY on the mobile sheet: with the document column capped and centred
          the desktop pane's ✕ is 150px clear of the card's right edge, while a
          full-screen sheet puts them on top of each other. `md:` is the
          boundary rather than `useIsMobile` because it maps exactly onto it
          (≥768 / ≤767) and geometry that can be CSS should not be a JS
          branch. */}
      <div className={`bg-glasshouse-well py-4 mb-5 pl-5 ${isOverlay ? 'pr-12 md:pr-5' : 'pr-5'}`}>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Article title"
          className="w-full border-none bg-transparent font-serif text-2xl font-medium italic text-black placeholder:text-grey-300 focus:outline-none sm:text-3xl"
          style={{ letterSpacing: '-0.02em' }}
        />
      </div>

      {/* Standfirst card */}
      <div className="bg-glasshouse-well px-5 py-4 mb-5" data-explain="editor.dek">
        <input
          type="text"
          value={dek}
          onChange={(e) => setDek(e.target.value)}
          placeholder="Add a subtitle or standfirst…"
          className="w-full border-none bg-transparent font-serif text-lg text-grey-600 italic placeholder:text-grey-300 focus:outline-none"
        />
      </div>

      {/* The STICKY block, and the toolbar is all that is left in it. Title and
          standfirst are the document and scroll away above; the cover is one
          decision per article and lives behind a toolbar button. The overlay
          chrome sticks to `top: 0` (the Glasshouse pane's top); the standalone
          page sticks to the sitewide nav bar's inner edge (NAV_BAR_H — the bar
          is fixed at z-58, so a toolbar pinned at 0 would slide underneath it
          and stay hidden). The `pb-5` is PADDING, not a margin: content scrolls
          BEHIND a sticky element, so only the element's own box is opaque and a
          margin there would let prose ride up into the gap under the toolbar. */}
      <div
        className="sticky z-20 bg-glasshouse pb-5"
        style={{ top: isOverlay ? 0 : NAV_BAR_H }}
      >
      {/* Editor toolbar. The focus fade goes on THIS row and not on the sticky
          wrapper above it: an opacity below 1 there would take the wrapper's
          background with it, and prose scrolls behind a sticky element. */}
      <div className="ah-editor-chrome flex items-center gap-0.5 sm:gap-1 px-2 sm:px-4 py-2.5">
        <ToolbarButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </ToolbarButton>
        <span className="contents max-[479px]:hidden">
          <ToolbarButton
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          >
            H2
          </ToolbarButton>
        </span>
        <span className="hidden sm:contents">
          <ToolbarButton
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          >
            H3
          </ToolbarButton>
        </span>
        <ToolbarButton
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo;
        </ToolbarButton>
        <span className="contents max-[479px]:hidden">
          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            &bull;
          </ToolbarButton>
        </span>
        <ToolbarButton
          active={false}
          onClick={() => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = 'image/jpeg,image/png,image/gif,image/webp'
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0]
              if (!file) return
              try {
                setUploading(true)
                const result = await uploadImage(file)
                editor.chain().focus().setImage({ src: result.url }).run()
              } catch (err) {
                setPublishError(failureSentence(err, 'Couldn’t upload that image. Please try again.'))
              } finally {
                setUploading(false)
              }
            }
            input.click()
          }}
        >
          {uploading ? '…' : 'img'}
        </ToolbarButton>
        <ToolbarButton
          active={editor.isActive('link')}
          onClick={() => promptForLink(editor)}
        >
          link
        </ToolbarButton>
        <ToolbarButton
          active={false}
          onClick={() => {
            const url = window.prompt('Paste a YouTube, Vimeo or Spotify URL:')?.trim()
            if (!url) return
            // Only what the renderer turns into a player becomes an embed: an
            // embed node for anything else publishes as a bare link, after the
            // editor has shown a grey embed block for it (walkthrough A4).
            if (!isEmbeddableUrl(url)) {
              window.alert(
                "That isn’t a YouTube, Vimeo or Spotify link, so it can’t be embedded. Use the link button to add it as an ordinary link instead.",
              )
              return
            }
            editor.chain().focus().setEmbed({ src: url }).run()
          }}
        >
          embed
        </ToolbarButton>
        <ToolbarButton
          active={coverOpen}
          onClick={() => setCoverOpen((v) => !v)}
        >
          {coverImageUrl ? 'cover ✓' : 'cover'}
        </ToolbarButton>

        {/* Paywall gate button */}
        <span className="mx-1 text-grey-600">|</span>
        <ToolbarButton
          active={gateInserted}
          accent
          dataExplain="editor.paywall"
          onClick={() => {
            if (gateInserted) {
              editor.commands.removePaywallGate()
            } else {
              editor.commands.insertPaywallGate()
            }
          }}
        >
          {gateInserted ? 'Paywall ✓' : 'Paywall'}
        </ToolbarButton>

        <div className="ml-auto shrink-0 text-xs text-grey-600 max-[479px]:hidden">
          {wordCount} words &middot; {readMinutes} min read
        </div>
      </div>

      {/* The cover panel, opened from the toolbar's `cover` button. It lives
          BELOW the toolbar row rather than above it so pressing the button
          never shifts the button out from under the pointer. It fades with the
          toolbar rather than separately — they are one block of tools, and a
          full-opacity panel under a receded toolbar reads as two surfaces. */}
      {coverOpen && (
        <div className="ah-editor-chrome bg-glasshouse-well/40 px-5 py-4 mt-2">
          {coverImageUrl ? (
            <div className="flex items-start gap-4">
              <div
                className="w-32 sm:w-40 bg-grey-200"
                style={{ aspectRatio: '16 / 9' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={coverImageUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  className="btn-text"
                  disabled={coverUploading}
                  onClick={() => {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'image/jpeg,image/png,image/gif,image/webp'
                    input.onchange = (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0]
                      if (file) void handleCoverUpload(file)
                    }
                    input.click()
                  }}
                >
                  {coverUploading ? 'Uploading…' : 'Replace'}
                </button>
                <button
                  type="button"
                  className="btn-text-danger"
                  disabled={coverUploading}
                  onClick={() => setCoverImageUrl(null)}
                >
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn-text"
              disabled={coverUploading}
              onClick={() => {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = 'image/jpeg,image/png,image/gif,image/webp'
                input.onchange = (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0]
                  if (file) void handleCoverUpload(file)
                }
                input.click()
              }}
            >
              {coverUploading ? 'Uploading…' : '+ Add cover image'}
            </button>
          )}
        </div>
      )}
      </div>{/* end sticky */}

      {/* Editor content — THE PAPER. This was `bg-glasshouse-well`, so the
          writer typed on greige sunk into white while the reader read the same
          words on white: it read as a form field, and form fields feel cramped.
          It is now the pane's own ground, the lightest layer in both modes (in
          light `glasshouse` IS white, the reading-surface token; in dark the
          step exists and the body becomes the lighter of the two, which is
          again the reading surface) — and the chrome cards stay the wells.
          NO HORIZONTAL PADDING: with the ground identical to the pane's it
          bought nothing visually and cost the measure 80px, which would have
          put editor prose at 560 against the reader's 640 — the opposite of
          what the column cap above exists to do. The gutters are the document
          column's own centring. In the overlay it grows to fill a
          stretched-taller pane (flex-1) so the whole page stays writable; long
          articles still grow past it and scroll. */}
      <div className={`bg-glasshouse pb-8 ${isOverlay ? 'flex-1 flex flex-col' : ''}`}>
        <EditorContent
          editor={editor}
          className={isOverlay ? 'flex-1 flex flex-col' : undefined}
        />
      </div>

      {/* Tags */}
      <div className="mt-5" data-explain="editor.tags">
        <TagInput value={articleTags} onChange={setArticleTags} />
      </div>

      {/* Article settings card — publishing, price, replies */}
      <div className="mt-5 bg-glasshouse-well/40 px-5 py-4 space-y-3">
        {/* Publishing as */}
        {publicationMemberships.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap" data-explain="editor.publication">
            <label className="label-ui text-grey-600">Publishing as</label>
            <select
              value={selectedPublicationId ?? ''}
              onChange={(e) => setSelectedPublicationId(e.target.value || null)}
              className="bg-glasshouse-well px-3 py-1.5 text-sm text-black"
            >
              <option value="">Yourself</option>
              {publicationMemberships.map(pub => (
                <option key={pub.id} value={pub.id}>{pub.name}</option>
              ))}
            </select>
            {selectedPublicationId && (
              <label className="flex items-center gap-2 ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnWriterProfile}
                  onChange={(e) => setShowOnWriterProfile(e.target.checked)}
                />
                <span className="text-ui-xs text-grey-600">Also show on personal profile</span>
              </label>
            )}
          </div>
        )}

        {/* Price — only when paywall gate is inserted */}
        {gateInserted && (
          <div className="flex items-center gap-4" data-explain="editor.price">
            <label className="label-ui text-grey-600">Price</label>
            <div className="flex items-center gap-2">
              <span className="text-ui-xs text-grey-600">&pound;</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={(pricePence / 100).toFixed(2)}
                onChange={(e) => {
                  userSetPrice.current = true
                  setPriceIsOwn(true)
                  // A cleared/partial field parses to NaN, which would JSON-
                  // serialise to null and fail publish — treat it as 0 and let
                  // the pre-publish validation ask for a real price.
                  const pence = Math.round(parseFloat(e.target.value) * 100)
                  setPricePence(Number.isFinite(pence) ? pence : 0)
                }}
                className="w-24 bg-glasshouse-well border-none px-3 py-1.5 text-sm focus:outline-none"
              />
              {/* The SUGGESTION, never the box's own value (walkthrough A5):
                  it printed the current price, so a writer who typed £4.00
                  read "Suggested: £4.00". Once the price is theirs the line
                  steps aside rather than arguing with it. */}
              {!priceIsOwn && (
                <span className="text-mono-xs text-grey-600">
                  Suggested: {formatPrice(suggestPrice(wordCount))} for {wordCount.toLocaleString('en-GB')} words
                </span>
              )}
            </div>
          </div>
        )}

        {/* Replies toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={commentsEnabled}
            onChange={(e) => setCommentsEnabled(e.target.checked)}
          />
          <span className="text-ui-xs text-grey-600">
            Allow replies
          </span>
        </label>
      </div>

      {/* Publish confirmation panel */}
      {/* THE WRITER AGREEMENT STANDS IN FRONT OF EVERY PAID PRESS, and replaces
          the publish row rather than sitting beside it — the writer pressed
          Publish, met a document, and accepting is what finishes that press.
          It is the same control the reader meets at card registration. */}
      {showWriterTerms && (
        <div className="mt-6 bg-glasshouse-well/40 px-5 py-4 rounded">
          <p className="text-ui-sm text-grey-600 mb-3">
            {WRITER_TERMS_LEAD}
          </p>
          <TermsConsent
            kind="writer"
            checked={writerTermsChecked}
            onChange={setWriterTermsChecked}
            purpose={TERMS_PURPOSE.sell}
            state={user?.terms.writer ?? null}
            disabled={acceptingWriterTerms}
          />
          <div className="flex items-center gap-3">
            <button
              onClick={() => void acceptWriterTerms()}
              disabled={!writerTermsChecked || acceptingWriterTerms}
              className="btn disabled:opacity-50"
            >
              {acceptingWriterTerms ? 'Accepting…' : TERMS_ACCEPT_AND_CONTINUE}
            </button>
            <button
              onClick={() => {
                pendingPaidAction.current = null
                setShowWriterTerms(false)
              }}
              className="text-sm text-grey-600 hover:text-black transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {showPublishConfirm && !showWriterTerms && (
        <div className="mt-6 bg-glasshouse-well/40 px-5 py-4 rounded">
          <p className="text-sm text-grey-600 mb-3">Your article will go live as soon as you press Publish.</p>
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(e) => setSendEmail(e.target.checked)}
            />
            <span className="text-sm text-grey-600">
              Email subscribers
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={handlePublish}
              disabled={publishing}
              className="btn disabled:opacity-50"
            >
              {publishing ? 'Publishing…' : 'Publish'}
            </button>
            <button
              onClick={() => setShowPublishConfirm(false)}
              className="text-sm text-grey-600 hover:text-black transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Publish button */}
      {publishError && (
        <div className="mt-6 bg-red-50 px-5 py-3 text-sm text-red-700">
          {publishError}
        </div>
      )}
      {!showPublishConfirm && !showWriterTerms && (
      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={handlePublishClick}
          disabled={publishing || !title.trim() || wordCount < 10}
          className="btn disabled:opacity-50"
        >
          {publishing
            ? (isEditing ? 'Updating…' : 'Publishing…')
            : isEditing
              ? 'Update'
              : selectedPub && !selectedPub.can_publish
                ? 'Submit for review'
                : 'Publish'}
        </button>
        {!isEditing && onSchedule && (
          <button
            onClick={() => setShowSchedulePicker(!showSchedulePicker)}
            disabled={publishing || !title.trim() || wordCount < 10}
            data-explain="editor.schedule"
            className="text-sm text-grey-600 hover:text-black transition-colors disabled:opacity-50"
          >
            Schedule
          </button>
        )}
        {/* PREVIEW. The editor holds unsaved state, so a preview of the last
            autosave is a lie — it flushes first, through the same `flushDraft`
            Save and teardown use.
            THE TAB IS OPENED SYNCHRONOUSLY ON THE CLICK and pointed at the URL
            when the save lands: because the flush is an `await`, opening after
            it would be a popup the browser blocks, so the button would do
            nothing — intermittently, depending on how fast the save was, which
            is the worst failure available here. A tab that opens and then
            reports a failure is recoverable; one that never opens is not. */}
        <button
          className="text-sm text-grey-600 hover:text-black transition-colors disabled:opacity-50"
          data-explain="editor.preview"
          disabled={previewing}
          onClick={async () => {
            if (!editor) return
            const tab = window.open('', '_blank')
            setPreviewing(true)
            try {
              const draftId = await flushDraft()
              if (!draftId) {
                // Nothing to preview — an empty buffer, or a piece already
                // published. Say so in the tab we opened rather than leaving a
                // blank one standing.
                if (tab) tab.close()
                showDraftStatus('Nothing to preview yet', true)
                return
              }
              const url = `/preview/${draftId}`
              if (tab) tab.location.href = url
              // No tab to point at (a blocker that refused even the
              // synchronous open) — go there in place rather than silently
              // doing nothing.
              else window.location.href = url
            } catch {
              if (tab) tab.close()
              showDraftStatus('Couldn’t save the draft')
            } finally {
              setPreviewing(false)
            }
          }}
        >
          {previewing ? 'Opening preview…' : 'Preview'}
        </button>
        <button
          className="text-sm text-grey-300 hover:text-grey-600 transition-colors"
          data-explain="editor.draft"
          onClick={async () => {
            if (!editor) return
            showDraftStatus('Saving…')
            try {
              const draftId = await flushDraft()
              showDraftStatus(draftId ? 'Saved' : 'Nothing to save', true)
            } catch {
              showDraftStatus('Couldn’t save the draft')
            }
          }}
        >
          Save draft
        </button>
        {draftStatus && (
          <span className="text-xs text-grey-600">{draftStatus}</span>
        )}
      </div>
      )}

      {/* Schedule picker — stands down behind the terms gate, like the publish
          row above: two live controls for the same blocked act is the case the
          gate exists to remove. */}
      {showSchedulePicker && !showWriterTerms && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="datetime-local"
            value={scheduleDateTime}
            onChange={e => setScheduleDateTime(e.target.value)}
            min={toDateTimeLocalValue(new Date())}
            className="bg-glasshouse-well px-3 py-1.5 text-sm focus:outline-none"
          />
          {/* The widget draws the date in the BROWSER's order, which nothing
              in our markup can change; the echo states it in this site's.
              See `formatDateInputEcho`. */}
          {formatDateInputEcho(scheduleDateTime) && (
            <span className="text-mono-xs text-grey-600">
              {formatDateInputEcho(scheduleDateTime)}
            </span>
          )}
          <button
            onClick={handleScheduleSubmit}
            disabled={publishing || !scheduleDateTime}
            className="btn text-sm disabled:opacity-50"
          >
            {publishing ? 'Scheduling…' : 'Confirm schedule'}
          </button>
          <button
            onClick={() => { setShowSchedulePicker(false); setScheduleDateTime('') }}
            className="text-sm text-grey-600 hover:text-black"
          >
            Cancel
          </button>
        </div>
      )}
      </div>{/* end document column */}
    </div>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function ToolbarButton({
  active,
  accent,
  dataExplain,
  onClick,
  children,
}: {
  active: boolean
  accent?: boolean
  /** Explain kind tag (C2) — same pattern as Byline/VesselBar. */
  dataExplain?: string
  onClick: () => void
  children: React.ReactNode
}) {
  const accentStyles = accent
    ? active
      ? 'bg-grey-100 text-crimson border-2 border-crimson'
      : 'text-crimson hover:bg-grey-100 border-2 border-transparent'
    : active
      ? 'bg-grey-100 text-black'
      : 'text-grey-600 hover:bg-grey-100 hover:text-black'

  return (
    <button
      onClick={onClick}
      data-explain={dataExplain}
      className={`rounded px-1.5 sm:px-2.5 py-1 text-xs font-medium transition-colors ${accentStyles}`}
    >
      {children}
    </button>
  )
}

// Price suggestion per ADR §II.2. Floored at 30p (walkthrough A5): under 700
// words it suggested £0, which a paywalled publish refuses (price ≥ 1p), so the
// auto-filled box handed a short piece a price it could not be sold at.
function suggestPrice(wordCount: number): number {
  if (wordCount < 700)   return 30
  if (wordCount < 1500)  return 50
  if (wordCount < 3000)  return 75
  if (wordCount < 5000)  return 100
  if (wordCount < 7000)  return 120
  if (wordCount < 9000)  return 140
  if (wordCount < 11000) return 160
  if (wordCount < 13000) return 180
  if (wordCount < 15000) return 200
  return 200
}
