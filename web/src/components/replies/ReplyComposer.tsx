'use client'

import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { publishReply } from '../../lib/replies'
import { useMediaAttachments } from '../../hooks/useMediaAttachments'
import { MediaPreview } from '../ui/MediaPreview'

const REPLY_CHAR_LIMIT = 2000

interface ReplyComposerProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
  replyingToName?: string
  onPublished?: (reply: any) => void
  onCancel?: () => void
}

export function ReplyComposer({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  parentCommentId,
  parentCommentEventId,
  replyingToName,
  onPublished,
  onCancel,
}: ReplyComposerProps) {
  const { user } = useAuth()
  const [content, setContent] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const media = useMediaAttachments()

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [content])

  useEffect(() => {
    if (parentCommentId && inputRef.current) {
      inputRef.current.focus()
    }
  }, [parentCommentId])

  if (!user) return null

  const charCount = media.totalCharCount(content)
  const isOverLimit = charCount > REPLY_CHAR_LIMIT
  const isEmpty = content.trim().length === 0 && media.attachments.filter(a => a.type === 'image').length === 0
  const canPost = !isEmpty && !isOverLimit && !publishing

  async function handlePost() {
    if (!canPost || !user) return
    setPublishing(true)
    setError(null)
    try {
      const finalContent = media.buildContent(content)
      const result = await publishReply({
        content: finalContent,
        targetEventId,
        targetKind,
        targetAuthorPubkey,
        parentCommentId,
        parentCommentEventId,
      })
      setContent('')
      media.reset()
      onPublished?.({
        id: result.replyId,
        nostrEventId: result.replyEventId,
        author: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar,
          pipStatus: 'unknown',
        },
        parentCommentId: parentCommentId ?? null,
        content: finalContent,
        publishedAt: new Date().toISOString(),
        isDeleted: false,
        isMuted: false,
        replies: [],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post reply.')
    } finally {
      setPublishing(false)
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setContent(val)
    media.detectEmbeds(val)
  }

  const isExpanded = focused || content.length > 0 || media.attachments.length > 0
  const displayError = error ?? media.error

  return (
    <div className="pt-2">
      {replyingToName && (
        <p className="text-ui-xs text-grey-300 mb-1.5 flex items-center gap-1">
          Replying to <span className="font-medium text-grey-400">{replyingToName}</span>
          {onCancel && (
            <button onClick={onCancel} className="text-grey-300 hover:text-grey-400 ml-1">×</button>
          )}
        </p>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <textarea
            ref={inputRef}
            value={content}
            onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handlePost() } }}
            placeholder="Reply..."
            rows={1}
            className={`w-full resize-none text-ui-sm text-black placeholder:text-grey-300 focus:outline-none leading-relaxed transition-all ${
              isExpanded
                ? 'bg-grey-100 px-3.5 py-2'
                : 'bg-grey-100/60 px-3.5 py-2'
            }`}
          />
        </div>

        <div className="flex items-center gap-1.5 pb-0.5">
          {isExpanded && (
            <button
              onClick={media.triggerImageUpload}
              disabled={media.uploading}
              className="text-grey-300 hover:text-grey-400 disabled:opacity-40 transition-colors p-1.5"
              title="Add image"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14.5 10.5L11 7L3.5 14.5" />
              </svg>
            </button>
          )}
          <button
            onClick={handlePost}
            disabled={!canPost}
            className="btn disabled:opacity-30 px-3.5 py-1.5 text-ui-xs font-medium"
          >
            {publishing ? '...' : 'Post'}
          </button>
        </div>
      </div>

      {/* Media previews */}
      {isExpanded && (
        <MediaPreview
          attachments={media.attachments}
          onRemove={media.removeAttachment}
          uploading={media.uploading}
        />
      )}

      {displayError && (
        <div className="mt-1.5 bg-grey-100 text-crimson px-3 py-1.5 text-ui-xs flex items-center justify-between">
          <span>{displayError}</span>
          <button onClick={() => { setError(null); media.clearError() }} className="ml-2 text-grey-300 hover:text-crimson">×</button>
        </div>
      )}

      {isExpanded && charCount > REPLY_CHAR_LIMIT - 200 && (
        <p className={`text-ui-xs mt-1 transition-colors ${
          isOverLimit ? 'text-crimson font-medium' : 'text-grey-300'
        }`}>
          {charCount}/{REPLY_CHAR_LIMIT}
        </p>
      )}
    </div>
  )
}
