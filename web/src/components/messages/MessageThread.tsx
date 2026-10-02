'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { ReportButton } from '../ui/ReportButton'
import { MuteBlockControls } from '../social/MuteBlockControls'
import { messages as messagesApi, type DirectMessage, type DecryptedMessage } from '../../lib/api'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
import { CommissionForm } from '../ui/CommissionForm'
import { pledgesEnabled } from '../../lib/featureFlags'
import { apiErrorMessage } from '../../lib/api/client'
import {
  MESSAGES_LOAD_OLDER,
  MESSAGES_THREAD_EMPTY,
  MESSAGES_UNKNOWN_SENDER,
  MESSAGES_ENCRYPTED,
  MESSAGES_COULD_NOT_DECRYPT,
  MESSAGES_REPLY,
  MESSAGES_LIKE,
  MESSAGES_UNLIKE,
  MESSAGES_REPLY_PLACEHOLDER,
  MESSAGES_MESSAGE_PLACEHOLDER,
  MESSAGES_SEND,
  MESSAGES_SEND_FAILED,
  messagesReplyingTo,
  messagesBlockedSentence,
} from '../../content/messages'

// =============================================================================
// DIRECT MESSAGES ARE TEXT ONLY (L6.2, decision A1; D1 §5).
//
// What was here until now: an image-upload button, a `useMediaAttachments`
// hook that appended the uploaded URLs to the message body, and `MediaContent`
// rendering the result — which linkified bare URLs and mounted YouTube
// iframes. A DM is the one surface where a stranger can put something in front
// of a member with nobody else in the room, and every one of those three was a
// way to make that worth doing.
//
// All three are gone, and the thread renders `whitespace-pre-wrap` text and
// nothing else. THAT IS LOAD-BEARING, not tidying: the gateway's link refusal
// (`containsUrl`) deliberately does not chase a bare `example.com`, because
// the pattern that catches one also catches "node.js" — and it is safe not to
// precisely because nothing on this surface turns text into a link. Putting a
// renderer back here means rethinking the two together.
//
// `MediaPreview` is NOT deleted: the note composer still uses it. What is
// deleted is its mount HERE. `MediaContent` outlived its last caller (the
// playscript reply) and is gone (CA-I7); `web/tests/dm-text-only.test.ts` is
// what keeps a renderer of either kind out of this file.
// =============================================================================

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
  const [sendError, setSendError] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<DecryptedMessage | null>(null)
  const [showCommission, setShowCommission] = useState(false)
  // Whether the VIEWER has blocked the other member — learned from the header
  // control (W2). Only this direction is ever known here: a block the other
  // party set is not disclosed, and the send's own neutral refusal covers it.
  const [iBlocked, setIBlocked] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const knownIds = useRef(new Set<string>())
  // Settled once the first page has landed (or failed): until then a poll
  // would open page one a second time beside the initial fetch.
  const initialSettled = useRef(false)
  useEffect(() => {
    knownIds.current = new Set(msgs.map(m => m.id))
  }, [msgs])

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
        knownIds.current = new Set(chronological.map(m => m.id))
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
    finally {
      if (isInitial) initialSettled.current = true
      setLoading(false); setLoadingMore(false); setDecrypting(false)
    }
  }, [conversationId, user?.id])

  // Poll for new messages in the active thread (CA-E5). There is NO cursor:
  // the poll reads page one and keeps what this thread does not already hold,
  // by id. A clock cursor was wrong both ways — the send stamped it with the
  // CLIENT's clock (the send returns ids only), so a clock ahead of the server
  // hid the counterpart's next replies; and an empty thread had no cursor at
  // all, so a recipient who opened the new conversation never saw its first
  // message without a reload. The id filter runs BEFORE the decrypt: every
  // decrypt opens a custodial key and leaves a `key_access_log` row, so page
  // one is never re-opened wholesale every five seconds.
  const pollForNew = useCallback(async () => {
    if (!initialSettled.current) return
    try {
      const data = await messagesApi.getMessages(conversationId)
      const newMsgs = data.messages.filter(m => !knownIds.current.has(m.id))
      if (newMsgs.length === 0) return

      const decrypted = await decryptMessages(newMsgs)
      const chronological = decrypted.reverse()

      setMsgs(prev => {
        const existingIds = new Set(prev.map(m => m.id))
        const unique = chronological.filter(m => !existingIds.has(m.id))
        if (unique.length === 0) return prev
        return [...prev, ...unique]
      })

      // Mark new messages from others as read (batch)
      const hasUnread = newMsgs.some(msg => msg.senderId !== user?.id)
      if (hasUnread) {
        await messagesApi.markAllRead(conversationId).catch(() => {})
        await refreshUnread()
        onMessagesRead?.()
      }
    } catch {}
  }, [conversationId, user?.id])

  // Initial fetch + set up polling. The thread is keyed on its conversation
  // by its mount (CA-E4), so this runs once per instance. The poll runs only
  // while the tab is visible, as `AuthProvider`'s does, and polls once on
  // becoming visible again.
  useEffect(() => {
    void fetchMessages()

    const start = () => {
      if (pollRef.current) return
      pollRef.current = setInterval(pollForNew, POLL_INTERVAL)
    }
    const stop = () => {
      if (!pollRef.current) return
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void pollForNew()
        start()
      } else stop()
    }

    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
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
    const finalContent = content
    if (!finalContent.trim() || sending) return
    setSendError(null)
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
    setReplyTo(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    setSending(true)

    try {
      const result = await messagesApi.send(conversationId, finalContent, replyToId)
      // Replace optimistic message with real ID
      // The poll may already have brought the real row in while the send was
      // in flight; then the optimistic copy just goes.
      const realId = result.messageIds?.[0]
      if (realId) {
        setMsgs(prev => prev.some(m => m.id === realId)
          ? prev.filter(m => m.id !== optimisticId)
          : prev.map(m => m.id === optimisticId ? { ...m, id: realId } : m))
      }
      if (result.skippedRecipientIds?.length) {
        console.warn('DM send partial: recipients without pubkeys were skipped', result.skippedRecipientIds)
      }
    } catch (err: unknown) {
      // Remove optimistic message on failure
      setMsgs(prev => prev.filter(m => m.id !== optimisticId))
      setContent(finalContent) // Restore the text so user doesn't lose it
      if (replyToId && replyTo) setReplyTo(replyTo)
      // The gateway's own sentence when it has one. `dm_links_not_allowed` is
      // the code from `gateway/src/routes/messages.ts`, pinned by
      // `web/tests/dm-text-only.test.ts` — a code the server went to the
      // trouble of splitting is one the client has to read, and a retry on the
      // same body will fail identically, so "try again" would be false.
      setSendError(
        apiErrorMessage(err) ?? MESSAGES_SEND_FAILED,
      )
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
        <div className="flex items-center gap-4">
          {/* REPORT A DM (L6.3; D1 §9.2 covers "native, DM, and ingested").
              A DM is the one surface where a stranger can put something in
              front of a member with nobody else in the room — no feed, no
              queue, no other reader who might notice — which is exactly why
              the report control has to be ON it and not somewhere else.
              It names the CONVERSATION and the other member: the gateway
              refuses a conversation the reporter is not in, and the snapshot
              deliberately captures neither party's messages (they are read on
              review, through the audited key path — D7 §4). */}
          {/* MUTE AND BLOCK THE OTHER MEMBER (W2) — a 1:1 thread only, since
              with a group there is no one person the header is about. Mute
              takes the conversation out of the inbox; block also ends the
              thread for both of you, and the send box below says so. */}
          {memberId && (
            <MuteBlockControls
              userId={memberId}
              name={memberName}
              triggerClassName="text-[12px] font-mono uppercase tracking-[0.04em] text-grey-600 hover:text-black transition-colors"
              onChange={(r) => setIBlocked(r.blocked)}
            />
          )}
          <ReportButton
            targetConversationId={conversationId}
            targetAccountId={memberId}
            label="Report"
            triggerClassName="text-[12px] font-mono uppercase tracking-[0.04em] text-grey-600 hover:text-black transition-colors"
          />
          {pledgesEnabled() && memberId && (
            <button
              onClick={() => setShowCommission(true)}
              className="text-[12px] font-mono uppercase tracking-[0.04em] text-grey-600 hover:text-black transition-colors"
            >
              Commission
            </button>
          )}
        </div>
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
              {loadingMore ? 'Loading\u2026' : MESSAGES_LOAD_OLDER}
            </button>
          </div>
        )}

        {loading || decrypting ? (
          <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-8 animate-pulse bg-grey-100 rounded" />)}</div>
        ) : msgs.length === 0 ? (
          <p className="text-center text-ui-xs font-sans text-grey-600 py-8">{MESSAGES_THREAD_EMPTY}</p>
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
                          {msg.replyTo.senderUsername ?? MESSAGES_UNKNOWN_SENDER}
                        </p>
                        <p className="text-[12px] font-sans text-grey-600 truncate max-w-[200px]">
                          {msg.replyToContent ?? <span className="italic">{MESSAGES_ENCRYPTED}</span>}
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
                      // PLAIN TEXT, and nothing that could turn it into a
                      // link. See the header.
                      <p
                        className={`text-ui-sm font-sans leading-relaxed whitespace-pre-wrap break-words ${isMine ? 'text-white' : 'text-black'}`}
                      >
                        {msg.content}
                      </p>
                    ) : (
                      <p className="text-ui-sm font-sans leading-relaxed whitespace-pre-wrap italic text-grey-600">
                        {MESSAGES_COULD_NOT_DECRYPT}
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
                      {MESSAGES_REPLY}
                    </button>

                    {/* Like — always visible when liked; hover-reveal when not */}
                    {(msg.likedByMe || msg.likeCount > 0) ? (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="flex items-center gap-1 text-[12px] text-crimson hover:opacity-70 transition-opacity"
                        aria-label={msg.likedByMe ? MESSAGES_UNLIKE : MESSAGES_LIKE}
                      >
                        <span>{'\u2665'}</span>
                        <span className="text-[11px] font-mono">{msg.likeCount}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleToggleLike(msg.id)}
                        className="text-[12px] text-grey-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity hover:text-black"
                        aria-label={MESSAGES_LIKE}
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
              {messagesReplyingTo(replyTo.senderDisplayName ?? replyTo.senderUsername)}
            </p>
            <p className="text-[12px] font-sans text-grey-600 truncate">
              {replyTo.content ?? MESSAGES_ENCRYPTED}
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

      {/* A refused send says so, in the server's own words.
          The optimistic message disappearing and the text reappearing in the
          box is a signal, but a mute one — and the sender's reasonable reading
          of it is that the network hiccuped, so they press Send again on the
          same body and it fails again. This band is the one the media-error
          strip used to occupy: one error place on this surface, not two. */}
      {sendError && (
        <div className="px-4 py-1.5 bg-grey-100 text-crimson text-[12px] font-sans flex items-center justify-between">
          <span>{sendError}</span>
          <button
            onClick={() => setSendError(null)}
            aria-label="Dismiss"
            className="ml-2 text-grey-600 hover:text-crimson"
          >
            ×
          </button>
        </div>
      )}

      {/* Send box — or, once the viewer has blocked the other member, the
          sentence that replaces it: a box whose every send would be refused
          is a button that cannot do its job. */}
      {iBlocked ? (
        <p className={`py-4 flex-shrink-0 pl-4 text-ui-xs font-sans text-grey-600 ${headerRightInset ? 'pr-7' : 'pr-4'}`}>
          {messagesBlockedSentence(memberName)}
        </p>
      ) : (
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
          placeholder={replyTo ? MESSAGES_REPLY_PLACEHOLDER : MESSAGES_MESSAGE_PLACEHOLDER}
          rows={1}
          className="flex-1 bg-glasshouse-well px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300 resize-none overflow-y-auto"
          style={{ maxHeight: '160px' }}
        />
        <button
          type="submit"
          disabled={sending || !content.trim()}
          className="btn text-sm disabled:opacity-50"
        >
          {sending ? '\u2026' : MESSAGES_SEND}
        </button>
      </form>
      )}
    </div>
  )
}
