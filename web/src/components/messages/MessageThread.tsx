'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { messages as messagesApi, type DirectMessage, type DecryptedMessage } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
import { useMediaAttachments } from '../../hooks/useMediaAttachments'
import { MediaPreview } from '../ui/MediaPreview'
import { MediaContent } from '../ui/MediaContent'
import { CommissionForm } from '../ui/CommissionForm'
import { pledgesEnabled } from '../../lib/featureFlags'

const POLL_INTERVAL = 5_000

function timeStamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function MessageThread({
  conversationId,
  memberName,
  memberId,
  onBack,
  onMessagesRead,
  headerRightInset = false,
}: {
  conversationId: string
  memberName: string
  memberId?: string
  onBack?: () => void
  onMessagesRead?: () => void
  // Set when rendered inside a Glasshouse overlay (the Messages surface). The
  // overlay has two pinned, floating handles this thread must clear: the close ✕
  // at the pane's top-right (so the header reserves room for the Commission
  // button) and the bottom-right resize grip (so the Send button is nudged left
  // of it, rather than sharing its corner).
  headerRightInset?: boolean
}) {
  const { user } = useAuth()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const [msgs, setMsgs] = useState<DecryptedMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [decrypting, setDecrypting] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<DecryptedMessage | null>(null)
  const [showCommission, setShowCommission] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const latestCreatedAt = useRef<string | null>(null)
  const media = useMediaAttachments()

  async function decryptMessages(encrypted: DirectMessage[]): Promise<DecryptedMessage[]> {
    if (encrypted.length === 0) return []

    // Collect all ciphertexts to decrypt: message bodies + reply previews
    const toDecrypt: { id: string; counterpartyPubkey: string; ciphertext: string }[] = []
    for (const m of encrypted) {
      toDecrypt.push({ id: m.id, counterpartyPubkey: m.counterpartyPubkey, ciphertext: m.contentEnc })
      if (m.replyTo?.contentEnc && m.replyTo.counterpartyPubkey) {
        toDecrypt.push({
          id: `reply:${m.id}`,
          counterpartyPubkey: m.replyTo.counterpartyPubkey,
          ciphertext: m.replyTo.contentEnc,
        })
      }
    }

    try {
      const { results } = await messagesApi.decryptBatch(toDecrypt)
      const plaintextMap = new Map(results.map(r => [r.id, r.plaintext]))
      return encrypted.map(m => ({
        ...m,
        content: plaintextMap.get(m.id) ?? null,
        replyToContent: plaintextMap.get(`reply:${m.id}`) ?? null,
      }))
    } catch {
      return encrypted.map(m => ({ ...m, content: null, replyToContent: null }))
    }
  }

  const fetchMessages = useCallback(async (before?: string) => {
    const isInitial = !before
    if (isInitial) setLoading(true)
    else setLoadingMore(true)

    const scrollEl = scrollRef.current
    const prevScrollHeight = scrollEl?.scrollHeight ?? 0

    try {
      const data = await messagesApi.getMessages(conversationId, before)
      setDecrypting(true)
      const decrypted = await decryptMessages(data.messages)
      const chronological = decrypted.reverse()

      if (isInitial) {
        setMsgs(chronological)
        if (chronological.length > 0) {
          latestCreatedAt.current = chronological[chronological.length - 1].createdAt
        }
      } else {
        setMsgs(prev => [...chronological, ...prev])
        requestAnimationFrame(() => {
          if (scrollEl) {
            scrollEl.scrollTop = scrollEl.scrollHeight - prevScrollHeight
          }
        })
      }
      setNextCursor(data.nextCursor)

      // Mark all messages in conversation as read (single batch call).
      // Always fire — the loaded page may not include the unread messages
      // (they could be older than the most recent 50).
      await messagesApi.markAllRead(conversationId).catch(err => {
        console.error('markAllRead failed:', err)
      })
      await refreshUnread()
      onMessagesRead?.()
    } catch {}
    finally { setLoading(false); setLoadingMore(false); setDecrypting(false) }
  }, [conversationId, user?.id])

  // Poll for new messages in the active thread
  const pollForNew = useCallback(async () => {
    if (!latestCreatedAt.current) return
    try {
      // Fetch messages newer than what we have by getting the first page
      // and filtering to only truly new ones
      const data = await messagesApi.getMessages(conversationId)
      if (data.messages.length === 0) return

      // Find messages newer than our latest
      const newMsgs = data.messages.filter(m =>
        new Date(m.createdAt) > new Date(latestCreatedAt.current!)
      )
      if (newMsgs.length === 0) return

      const decrypted = await decryptMessages(newMsgs)
      const chronological = decrypted.reverse()

      setMsgs(prev => {
        const existingIds = new Set(prev.map(m => m.id))
        const unique = chronological.filter(m => !existingIds.has(m.id))
        if (unique.length === 0) return prev
        return [...prev, ...unique]
      })

      latestCreatedAt.current = chronological[chronological.length - 1].createdAt

      // Mark new messages from others as read (batch)
      const hasUnread = newMsgs.some(msg => msg.senderId !== user?.id)
      if (hasUnread) {
        await messagesApi.markAllRead(conversationId).catch(() => {})
        await refreshUnread()
        onMessagesRead?.()
      }
    } catch {}
  }, [conversationId, user?.id])

  // Initial fetch + set up polling
  useEffect(() => {
    setMsgs([])
    setReplyTo(null)
    latestCreatedAt.current = null
    initialScrollDone.current = false
    void fetchMessages()

    pollRef.current = setInterval(pollForNew, POLL_INTERVAL)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [conversationId])

  // Auto-scroll when new messages appear
  const initialScrollDone = useRef(false)
  useEffect(() => {
    if (loading) return
    const el = scrollRef.current
    if (!el) return

    if (!initialScrollDone.current) {
      // First load: jump straight to the bottom (no smooth animation)
      initialScrollDone.current = true
      el.scrollTop = el.scrollHeight
      return
    }

    // Subsequent messages: only auto-scroll if user is near the bottom (within 150px)
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [msgs.length, loading])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    const finalContent = media.buildContent(content)
    if (!finalContent.trim() || sending) return
    const replyToId = replyTo?.id

    // Optimistic update: add the message to the UI immediately
    const optimisticId = `optimistic-${Date.now()}`
    const optimisticMsg: DecryptedMessage = {
      id: optimisticId,
      conversationId,
      senderId: user!.id,
      senderUsername: user!.username ?? '',
      senderDisplayName: user!.displayName ?? null,
      counterpartyPubkey: '',
      contentEnc: '',
      replyTo: replyTo ? {
        id: replyTo.id,
        senderUsername: replyTo.senderUsername,
        contentEnc: null,
        counterpartyPubkey: null,
      } : null,
      content: finalContent,
      replyToContent: replyTo?.content ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
      likeCount: 0,
      likedByMe: false,
    } as any

    setMsgs(prev => [...prev, optimisticMsg])
    setContent('')
    media.reset()
    setReplyTo(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSending(true)

    try {
      const result = await messagesApi.send(conversationId, finalContent, replyToId)
      // Replace optimistic message with real ID
      if (result.messageIds?.[0]) {
        setMsgs(prev => prev.map(m =>
          m.id === optimisticId ? { ...m, id: result.messageIds[0] } : m
        ))
        latestCreatedAt.current = new Date().toISOString()
      }
      if (result.skippedRecipientIds?.length) {
        console.warn('DM send partial: recipients without pubkeys were skipped', result.skippedRecipientIds)
      }
    } catch (err: any) {
      // Remove optimistic message on failure
      setMsgs(prev => prev.filter(m => m.id !== optimisticId))
      setContent(finalContent) // Restore the text so user doesn't lose it
      if (replyToId && replyTo) setReplyTo(replyTo)
    } finally {
      setSending(false)
    }
  }

  async function handleToggleLike(messageId: string) {
    // Snapshot current state for rollback
    const prev = msgs.find(m => m.id === messageId)
    if (!prev) return

    // Optimistic toggle
    setMsgs(ms => ms.map(m =>
      m.id === messageId
        ? { ...m, likedByMe: !m.likedByMe, likeCount: m.likeCount + (m.likedByMe ? -1 : 1) }
        : m
    ))
    try {
      await messagesApi.toggleLike(messageId)
    } catch (err) {
      console.error('Like toggle failed:', messageId, err)
      // Revert to snapshot
      setMsgs(ms => ms.map(m =>
        m.id === messageId
          ? { ...m, likedByMe: prev.likedByMe, likeCount: prev.likeCount }
          : m
      ))
    }
  }

  function handleReply(msg: DecryptedMessage) {
    setReplyTo(msg)
    inputRef.current?.focus()
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setContent(val)
    media.detectEmbeds(val)
    // Auto-resize: reset then expand to scrollHeight
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
  }

  return (
    <div data-explain="messages.thread" className="flex flex-col h-full">
      {/* Commission modal — pledge drives parked (pledgesEnabled) */}
      {pledgesEnabled() && showCommission && memberId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowCommission(false)}>
          <div className="w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <CommissionForm
              targetWriterId={memberId}
              targetWriterName={memberName}
              parentConversationId={conversationId}
              onCreated={() => setShowCommission(false)}
              onClose={() => setShowCommission(false)}
            />
          </div>
        </div>
      )}

      {/* Header */}
      <div className={`flex items-center justify-between py-3 flex-shrink-0 pl-4 ${headerRightInset ? 'pr-12' : 'pr-4'}`}>
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="font-mono text-[12px] text-grey-600 hover:text-black uppercase tracking-[0.04em]">
              &#8592;
            </button>
          )}
          <p className="text-ui-sm font-sans font-semibold text-black">{memberName}</p>
        </div>
        {pledgesEnabled() && memberId && (
          <button
            onClick={() => setShowCommission(true)}
            className="text-[12px] font-mono uppercase tracking-[0.04em] text-grey-600 hover:text-black transition-colors"
          >
            Commission
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {nextCursor && (
          <div className="text-center">
            <button
              onClick={() => fetchMessages(nextCursor)}
              disabled={loadingMore}
              className="text-[12px] font-sans text-grey-600 hover:text-black"
            >
              {loadingMore ? 'Loading\u2026' : 'Load older messages'}
            </button>
          </div>
        )}

        {loading || decrypting ? (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-8 animate-pulse bg-grey-100 rounded" />)}</div>
        ) : msgs.length === 0 ? (
          <p className="text-center text-ui-xs font-sans text-grey-600 py-8">No messages yet. Start the conversation.</p>
        ) : (
          msgs.map(msg => {
            const isMine = msg.senderId === user?.id
            return (
              <div key={msg.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] group`}>
                  {/* Reply context */}
                  {msg.replyTo && (
                    <div className={`flex items-start gap-1.5 mb-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                      <div className="bg-grey-100/60 px-3 py-1.5 border-l-2 border-grey-300">
                        <p className="text-[11px] font-sans font-semibold text-grey-600">
                          {msg.replyTo.senderUsername ?? 'Unknown'}
                        </p>
                        <p className="text-[12px] font-sans text-grey-600 truncate max-w-[200px]">
                          {msg.replyToContent ?? <span className="italic">Encrypted message</span>}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className={`${isMine ? 'bg-black text-white' : 'bg-grey-100 text-black'} px-4 py-2.5`}>
                    {!isMine && (
                      <p className={`text-[12px] font-sans font-semibold mb-0.5 text-grey-600`}>
                        {msg.senderDisplayName ?? msg.senderUsername}
                      </p>
                    )}
                    {msg.content ? (
                      <MediaContent
                        content={msg.content}
                        variant="message"
                        textClassName={`text-ui-sm font-sans leading-relaxed whitespace-pre-wrap ${isMine ? 'text-white' : 'text-black'}`}
                      />
                    ) : (
                      <p className="text-ui-sm font-sans leading-relaxed whitespace-pre-wrap italic text-grey-600">
                        Could not decrypt
                      </p>
                    )}
                    <p className={`text-[10px] font-mono mt-1 ${isMine ? 'text-grey-400' : 'text-grey-600'}`}>
                      {timeStamp(msg.createdAt)}
                    </p>
                  </div>

                  {/* Like + Reply buttons */}
                  <div className={`flex items-center gap-2 mt-0.5 ${isMine ? 'justify-end' : 'justify-start'}`}>
                    {/* Reply — hover-reveal on desktop, always visible on mobile */}
                    <button
                      onClick={() => handleReply(msg)}
                      className="text-[11px] font-sans text-grey-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:text-black"
                    >
                      Reply
                    </button>

                    {/* Like — always visible when liked; hover-reveal when not */}
                    {(msg.likedByMe || msg.likeCount > 0) ? (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="flex items-center gap-1 text-[12px] text-crimson hover:opacity-70 transition-opacity"
                        aria-label={msg.likedByMe ? 'Unlike' : 'Like'}
                      >
                        <span>{'\u2665'}</span>
                        <span className="text-[11px] font-mono">{msg.likeCount}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="text-[12px] text-grey-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:text-black"
                        aria-label="Like"
                      >
                        {'\u2661'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview bar */}
      {replyTo && (
        <div className="flex items-center gap-2 px-4 py-2 bg-grey-100/80">
          <div className="flex-1 min-w-0 border-l-2 border-crimson pl-2">
            <p className="text-[11px] font-sans font-semibold text-grey-600">
              Replying to {replyTo.senderDisplayName ?? replyTo.senderUsername}
            </p>
            <p className="text-[12px] font-sans text-grey-600 truncate">
              {replyTo.content ?? 'Encrypted message'}
            </p>
          </div>
          <button
            onClick={() => setReplyTo(null)}
            className="text-[12px] text-grey-600 hover:text-black flex-shrink-0"
            aria-label="Cancel reply"
          >
            &#10005;
          </button>
        </div>
      )}

      {/* Media preview strip */}
      {(media.attachments.length > 0 || media.uploading) && (
        <div className="px-4 pt-2">
          <MediaPreview
            attachments={media.attachments}
            onRemove={media.removeAttachment}
            uploading={media.uploading}
          />
        </div>
      )}

      {/* Media error */}
      {media.error && (
        <div className="px-4 py-1.5 bg-grey-100 text-crimson text-[12px] font-sans flex items-center justify-between">
          <span>{media.error}</span>
          <button onClick={media.clearError} className="ml-2 text-grey-600 hover:text-crimson">×</button>
        </div>
      )}

      {/* Send box */}
      <form onSubmit={handleSend} className={`flex items-end gap-2 py-3 flex-shrink-0 pl-4 ${headerRightInset ? 'pr-7' : 'pr-4'}`}>
        <textarea
          ref={inputRef}
          value={content}
          onChange={handleChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSend(e)
            }
          }}
          placeholder={replyTo ? 'Write a reply\u2026' : 'Write a message\u2026'}
          rows={1}
          className="flex-1 bg-glasshouse-well px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300 resize-none overflow-y-auto"
          style={{ maxHeight: '160px' }}
        />
        <button
          type="button"
          onClick={media.triggerImageUpload}
          disabled={media.uploading}
          className="text-grey-600 hover:text-black disabled:opacity-40 transition-colors p-1.5"
          title="Add image"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
            <circle cx="5.5" cy="5.5" r="1" />
            <path d="M14.5 10.5L11 7L3.5 14.5" />
          </svg>
        </button>
        <button
          type="submit"
          disabled={sending || (!content.trim() && media.attachments.length === 0)}
          className="btn text-sm disabled:opacity-50"
        >
          {sending ? '\u2026' : 'Send'}
        </button>
      </form>
    </div>
  )
}
