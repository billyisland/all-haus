'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CharacterCount from '@tiptap/extension-character-count'
import { Markdown } from 'tiptap-markdown'
import { useAuth } from '../../stores/auth'
import { createAutoSaver, saveDraft, type SavedDraft } from '../../lib/drafts'
import { ImageUpload } from './ImageUpload'
import { TagInput } from './TagInput'
import { EmbedNode } from './EmbedNode'
import { PaywallGateNode, PAYWALL_GATE_MARKER } from './PaywallGateNode'
import { uploadImage } from '../../lib/media'
import { validatePaywalledPublish } from '../../lib/publish-validation'

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
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(initialDraftId ?? null)
  const [uploading, setUploading] = useState(false)
  const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(initialPublicationId)
  const [showOnWriterProfile, setShowOnWriterProfile] = useState(true)
  const [coverImageUrl, setCoverImageUrl] = useState<string | null>(initialCoverImageUrl ?? null)
  const [coverUploading, setCoverUploading] = useState(false)
  const [showPublishConfirm, setShowPublishConfirm] = useState(false)
  const [sendEmail, setSendEmail] = useState(true)
  const [showSchedulePicker, setShowSchedulePicker] = useState(false)
  const [scheduleDateTime, setScheduleDateTime] = useState('')

  const isEditing = !!editingEventId
  const userSetPrice = useRef(!!initialPrice || user?.defaultArticlePricePence != null)
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

  const autoSaver = useMemo(() => createAutoSaver(3000), [])

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

  // Flush any unsaved work on unmount instead of silently dropping it (M21).
  // The editor closes far more often as an overlay than the old /write page
  // did, and title/dek/price-only changes (or edits within the 3s debounce
  // window) had no persisted state. Fire-and-forget so teardown isn't blocked;
  // gated on isDirty + real content so we never spawn an empty draft row.
  useEffect(() => () => {
    autoSaver.cancel()
    if (disposedRef.current) return
    const data = snapshotDraft()
    const hasContent = !!(data.title.trim() || data.content.trim() || data.dek.trim())
    if (hasContent && autoSaver.isDirty(data)) {
      void saveDraft(data).catch(() => {})
    }
  }, [autoSaver, snapshotDraft])

  const handleCoverUpload = useCallback(async (file: File) => {
    setCoverUploading(true)
    setPublishError(null)
    try {
      const result = await uploadImage(file)
      setCoverImageUrl(result.url)
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : 'Cover upload failed')
    } finally {
      setCoverUploading(false)
    }
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
      }),
      ImageUpload.configure({
        onUploadStart: () => setUploading(true),
        onUploadEnd: () => setUploading(false),
        onUploadError: (err) => {
          setUploading(false)
          setPublishError(err.message)
        },
      }),
      EmbedNode,
      PaywallGateNode,
      Placeholder.configure({
        placeholder: 'Start writing...',
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
          setDraftStatus('Saved')
          setTimeout(() => setDraftStatus(null), 2000)
        },
        () => setDraftStatus('Save failed')
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
        setDraftStatus('Saved')
        setTimeout(() => setDraftStatus(null), 2000)
      },
      () => setDraftStatus('Save failed'),
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
        const totalLen = freeContent.length + paywallContent.length
        gatePositionPct = totalLen > 0 ? Math.min(99, Math.max(1, Math.round((freeContent.length / totalLen) * 100))) : 50
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
      setPublishError(err instanceof Error ? err.message : 'Publishing failed — please try again.')
    } finally {
      setPublishing(false)
    }
  }, [editor, title, dek, pricePence, onPublish, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, sendEmail, isEditing, articleTags, coverImageUrl, currentDraftId, autoSaver])

  // Show the publish confirmation panel for new personal articles;
  // submit-for-review and edits skip confirmation and go straight through.
  const handlePublishClick = useCallback(() => {
    const isSubmitForReview = selectedPub && !selectedPub.can_publish
    if (isEditing || isSubmitForReview) {
      void handlePublish()
    } else {
      setSendEmail(true)
      setShowPublishConfirm(true)
    }
  }, [isEditing, selectedPub, handlePublish])

  const handleScheduleSubmit = useCallback(async () => {
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
        const totalLen = freeContent.length + paywallContent.length
        gatePositionPct = totalLen > 0 ? Math.min(99, Math.max(1, Math.round((freeContent.length / totalLen) * 100))) : 50
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
        sendEmail: false,
        tags: articleTags,
        coverImageUrl,
        draftId: currentDraftId,
      }

      // Set BEFORE the await (§0f-4) — same unmount race as handlePublish.
      disposedRef.current = true
      await onSchedule(data, new Date(scheduleDateTime).toISOString())
    } catch (err) {
      disposedRef.current = false // schedule failed — the draft still exists
      console.error('Schedule error:', err)
      setPublishError(err instanceof Error ? err.message : 'Scheduling failed — please try again.')
    } finally {
      setPublishing(false)
      setShowSchedulePicker(false)
      setScheduleDateTime('')
    }
  }, [editor, title, dek, pricePence, onSchedule, hasGateMarker, commentsEnabled, selectedPublicationId, showOnWriterProfile, articleTags, scheduleDateTime, coverImageUrl, currentDraftId, autoSaver])

  if (!editor) return null

  const wordCount = editor.storage.characterCount.words()
  const readMinutes = Math.max(1, Math.round(wordCount / 200))
  const priceDisplay = (pricePence / 100).toFixed(2)
  const gateInserted = hasGateMarker()

  return (
    // data-explain: the editor's Explain base kind (C2) — answers any interior
    // hover a more specific leaf doesn't. Inert on the standalone /write page
    // (Explain only runs in the workspace).
    <div data-explain="editor" className={isOverlay ? 'px-6 sm:px-10 py-12 flex-1 flex flex-col' : 'mx-auto max-w-editor-frame px-4 sm:px-6 pt-8 pb-8 bg-glasshouse min-h-screen ah-clear-row-band'}>
      {/* Sticky title + toolbar — stays visible while scrolling the body. It
          sticks to `top-0` in BOTH chromes now: the overlay to the Glasshouse
          pane's top, and the page to the viewport's. The page branch used to
          carry `top-[53px] lg:top-0`, offsetting the black topbar's mobile
          height — there is no topbar anywhere any more, so the offset was
          53px of dead space pushing the bar down the screen on a phone.
          The cards span the full width (matching the body editor below); only the
          title card — the row that pins under the floating ✕ when scrolled — gets
          its own right inset (pr-12) so a long title still clears it. */}
      <div className="sticky top-0 z-20 bg-glasshouse pb-4 mb-6">
      {/* Title card */}
      <div className={`bg-glasshouse-well py-4 mb-2 pl-5 ${isOverlay ? 'pr-12' : 'pr-5'}`}>
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
      <div className="bg-glasshouse-well px-5 py-4 mb-2" data-explain="editor.dek">
        <input
          type="text"
          value={dek}
          onChange={(e) => setDek(e.target.value)}
          placeholder="Add a subtitle or standfirst…"
          className="w-full border-none bg-transparent font-serif text-lg text-grey-600 italic placeholder:text-grey-300 focus:outline-none"
        />
      </div>

      {/* Cover card */}
      <div className="bg-glasshouse-well/40 px-5 py-4 mb-2">
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

      {/* Editor toolbar */}
      <div className="flex items-center gap-0.5 sm:gap-1 px-2 sm:px-4 py-2.5">
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
                setPublishError(err instanceof Error ? err.message : 'Image upload failed')
              } finally {
                setUploading(false)
              }
            }
            input.click()
          }}
        >
          {uploading ? '...' : 'img'}
        </ToolbarButton>
        <ToolbarButton
          active={false}
          onClick={() => {
            const url = window.prompt('Paste a YouTube, Vimeo, Twitter, or Spotify URL:')
            if (url) {
              editor.chain().focus().setEmbed({ src: url }).run()
            }
          }}
        >
          embed
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
      </div>{/* end sticky */}

      {/* Editor content — the clean white "page" the article is written on. In
          the overlay it grows to fill a stretched-taller pane (flex-1) so the whole
          white canvas stays writable; long articles still grow past it and scroll. */}
      <div className={`bg-glasshouse-well p-8 sm:p-10 ${isOverlay ? 'flex-1 flex flex-col' : ''}`}>
        <EditorContent
          editor={editor}
          className={isOverlay ? 'flex-1 flex flex-col' : undefined}
        />
      </div>

      {/* Tags */}
      <div className="mt-3" data-explain="editor.tags">
        <TagInput value={articleTags} onChange={setArticleTags} />
      </div>

      {/* Article settings card — publishing, price, replies */}
      <div className="mt-3 bg-glasshouse-well/40 px-5 py-4 space-y-3">
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
                  // A cleared/partial field parses to NaN, which would JSON-
                  // serialise to null and fail publish — treat it as 0 and let
                  // the pre-publish validation ask for a real price.
                  const pence = Math.round(parseFloat(e.target.value) * 100)
                  setPricePence(Number.isFinite(pence) ? pence : 0)
                }}
                className="w-24 bg-glasshouse-well border-none px-3 py-1.5 text-sm focus:outline-none"
              />
              <span className="text-mono-xs text-grey-600">
                Suggested: &pound;{priceDisplay} based on {wordCount} words
              </span>
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
      {showPublishConfirm && (
        <div className="mt-6 bg-glasshouse-well/40 px-5 py-4 rounded">
          <p className="text-sm text-grey-600 mb-3">Your article will be published.</p>
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
              {publishing ? 'Publishing...' : 'Publish'}
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
      {!showPublishConfirm && (
      <div className="mt-6 flex items-center gap-4">
        <button
          onClick={handlePublishClick}
          disabled={publishing || !title.trim() || wordCount < 10}
          className="btn disabled:opacity-50"
        >
          {publishing
            ? (isEditing ? 'Updating...' : 'Publishing...')
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
        <button
          className="text-sm text-grey-300 hover:text-grey-600 transition-colors"
          data-explain="editor.draft"
          onClick={async () => {
            if (!editor) return
            setDraftStatus('Saving...')
            try {
              const content = editor.storage.markdown.getMarkdown()
              const draftData = {
                title, dek, content, gatePositionPct: 50, pricePence,
                coverImageUrl, commentsEnabled, draftId: currentDraftId ?? undefined, dTag: editingDTag,
              }
              const saved = await saveDraft(draftData)
              // Record the fingerprint so the unmount flush doesn't re-save it.
              autoSaver.markSaved(draftData)
              setCurrentDraftId(saved.draftId)
              setDraftStatus('Saved')
              setTimeout(() => setDraftStatus(null), 2000)
            } catch {
              setDraftStatus('Save failed')
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

      {/* Schedule picker */}
      {showSchedulePicker && (
        <div className="mt-3 flex items-center gap-3">
          <input
            type="datetime-local"
            value={scheduleDateTime}
            onChange={e => setScheduleDateTime(e.target.value)}
            min={new Date().toISOString().slice(0, 16)}
            className="bg-glasshouse-well px-3 py-1.5 text-sm focus:outline-none"
          />
          <button
            onClick={handleScheduleSubmit}
            disabled={publishing || !scheduleDateTime}
            className="btn text-sm disabled:opacity-50"
          >
            {publishing ? 'Scheduling...' : 'Confirm schedule'}
          </button>
          <button
            onClick={() => { setShowSchedulePicker(false); setScheduleDateTime('') }}
            className="text-sm text-grey-600 hover:text-black"
          >
            Cancel
          </button>
        </div>
      )}
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

// Price suggestion per ADR §II.2
function suggestPrice(wordCount: number): number {
  if (wordCount < 700)   return 0
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

// Split markdown content at the paywall gate marker
function splitAtGateMarker(markdown: string): { free: string; paywall: string } {
  const markerIndex = markdown.indexOf(PAYWALL_GATE_MARKER)
  if (markerIndex === -1) {
    return { free: markdown, paywall: '' }
  }

  const free = markdown.slice(0, markerIndex).trim()
  const paywall = markdown.slice(markerIndex + PAYWALL_GATE_MARKER.length).trim()

  return { free, paywall }
}
