'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useBackGuard } from '../../lib/backGuard'
import { useUnreadCounts } from '../../stores/unread'
import { messages as messagesApi, type Conversation } from '../../lib/api'
import { useResolverInput } from '../../hooks/useResolverInput'
import { ConversationList } from './ConversationList'
import { MessageThread } from './MessageThread'
import { NotificationsPanel } from '../notifications/NotificationsPanel'

// =============================================================================
// MessagesInbox — the merged notifications + direct-messages surface.
//
// Desktop (md+): three columns side-by-side — the notifications activity log
// (left), the conversation list (middle), and the message reading pane (right).
//
// Mobile (<md): two peer pages swiped horizontally — Notifications and Messages
// — with a segmented header that mirrors the swipe position and lets you tap
// between them. The Messages page is a self-contained drill-down: it shows the
// conversation list, and selecting a conversation pushes the thread in as a
// full-cover layer over it. The thread pops back to the list via its back arrow
// OR a right-swipe (the iOS-style back gesture) — so the drill-down never leaves
// the Messages page, and the pager's swipe axis only ever flips the two peers.
//
// A `new_message` notification (left/page-1) selects that conversation in the
// reading pane in place (via NotificationsPanel's onMessageActivate) — on mobile
// it also pages across to Messages — rather than routing away.
//
// Hosted in the workspace Glasshouse (MessagesOverlay), which supplies the frame
// + overlay resize and (on mobile) the full-screen sheet.
// =============================================================================

export function MessagesInbox({
  className = '',
  initialConversationId = null,
}: {
  className?: string
  initialConversationId?: string | null
}) {
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const { notificationCount, dmCount } = useUnreadCounts()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [showNewMessage, setShowNewMessage] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  // Omnivorous recipient input (CLAUDE.md rule; audit F4): username, email,
  // npub, URL — whatever the user has. The `dm` context keeps candidates
  // native-only server-side.
  const ri = useResolverInput({ context: 'dm', maxPolls: 3 })
  const recipientMatches = ri.matches.filter(m => m.account)

  // Mobile pager — the horizontal swipe between the two peer pages. `pagerRef`
  // is the snap-scroll container; `mobilePage` mirrors the resting page so the
  // segmented header tracks swipes.
  const pagerRef = useRef<HTMLDivElement>(null)
  const [mobilePage, setMobilePage] = useState(0)

  async function fetchConversations() {
    try {
      const data = await messagesApi.listConversations()
      setConversations(data.conversations)
    } catch {}
  }

  const handleMessagesRead = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => prev.map(c =>
      c.id === activeConvId ? { ...c, unreadCount: 0 } : c
    ))
  }, [activeConvId])

  useEffect(() => { if (user) void fetchConversations() }, [user])
  useEffect(() => { if (user) void useUnreadCounts.getState().fetch() }, [user])

  // Seed the active conversation (overlay passes the store value). On desktop,
  // default to the most recent one so the reading pane is filled; on mobile,
  // leave it null so the Messages page rests on the conversation list (the
  // thread is a drill-down, opened by tapping).
  useEffect(() => {
    if (initialConversationId) {
      setActiveConvId(initialConversationId)
    } else if (!isMobile && conversations.length > 0 && !activeConvId) {
      setActiveConvId(conversations[0].id)
    }
  }, [conversations, initialConversationId, isMobile])

  // Slide the mobile pager to a page. `smooth=false` for the initial jump (no
  // animation on open); a smooth slide for in-surface navigation.
  const goToPage = useCallback((idx: number, smooth = true) => {
    const el = pagerRef.current
    if (!el) return
    el.scrollTo({ left: idx * el.clientWidth, behavior: smooth ? 'smooth' : 'auto' })
    setMobilePage(idx)
  }, [])

  // Keep the segmented header in step with a finger-swipe.
  const onPagerScroll = useCallback(() => {
    const el = pagerRef.current
    if (!el) return
    const idx = Math.round(el.scrollLeft / el.clientWidth)
    setMobilePage(prev => (prev === idx ? prev : idx))
  }, [])

  // Open with a seeded conversation → land on the Messages page (showing the
  // thread) without animation. Runs when mobile resolves true and the pager has
  // mounted.
  useEffect(() => {
    if (isMobile && initialConversationId) {
      requestAnimationFrame(() => goToPage(1, false))
    }
  }, [isMobile, initialConversationId, goToPage])

  // Select a conversation (from the list, or a `new_message` notification). On
  // mobile, ensure we're on the Messages page so the thread is in view.
  const selectConversation = useCallback((id: string | null) => {
    setShowNewMessage(false)
    setCreateError(null)
    ri.reset()
    setActiveConvId(id)
    // Seat the list underneath the cover so popping the thread reveals it (and
    // the segmented header reads "Messages"). Instant — the cover hides it.
    if (isMobile && id) goToPage(1, false)
  }, [isMobile, goToPage, ri.reset])

  // Leave the thread / new-message form → back to the conversation list. On the
  // mobile drill-down this is the thread's back arrow (and the right-swipe); on
  // desktop it clears the reading pane to its empty state.
  const clearActive = useCallback(() => {
    setShowNewMessage(false)
    setActiveConvId(null)
    setCreateError(null)
    ri.reset()
  }, [ri.reset])

  // Mobile drill-down back-guard: while the thread cover is up, a browser Back /
  // OS edge-swipe pops it back to the conversation list (like the back arrow and
  // the in-element right-swipe) rather than closing the whole Messages sheet or
  // leaving the site. This sits ABOVE the Messages Glasshouse's own guard, so the
  // first Back returns to the list and a second Back closes the sheet.
  useBackGuard(isMobile && (!!activeConvId || showNewMessage), clearActive)

  // Right-swipe-to-dismiss on the mobile thread cover (the iOS-style back
  // gesture). Pops the drill-down back to the conversation list. We only act on
  // a decisively-horizontal rightward flick, and never from inside a text field
  // (so typing/selection isn't hijacked) or a horizontally-scrollable child (so
  // wide media keeps scrolling) — mirroring the mobile pager's restraint.
  const swipe = useRef<{ x: number; y: number; ok: boolean } | null>(null)
  const onCoverTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0]
    let el = e.target as HTMLElement | null
    let ok = true
    while (el && el !== e.currentTarget) {
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) { ok = false; break }
      if (el.scrollWidth > el.clientWidth) {
        const ox = getComputedStyle(el).overflowX
        if (ox === 'auto' || ox === 'scroll') { ok = false; break }
      }
      el = el.parentElement
    }
    swipe.current = { x: t.clientX, y: t.clientY, ok }
  }, [])
  const onCoverTouchEnd = useCallback((e: React.TouchEvent) => {
    const s = swipe.current
    swipe.current = null
    if (!s || !s.ok) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (dx > 64 && Math.abs(dx) > Math.abs(dy) * 1.5) clearActive()
  }, [clearActive])

  // Start a conversation with a PICKED match — never a blind first-result
  // guess (audit F4: the old path took search results[0] for whatever the
  // user typed).
  async function startConversation(accountId: string) {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const result = await messagesApi.createConversation([accountId])
      setActiveConvId(result.conversationId)
      setShowNewMessage(false)
      ri.reset()
      void fetchConversations()
    } catch { setCreateError('Couldn’t start the conversation. Try again.') }
    finally { setCreating(false) }
  }

  const activeConv = conversations.find(c => c.id === activeConvId)
  const otherMembers = activeConv?.members.filter(m => m.id !== user?.id) ?? []
  const activeMemberName = otherMembers.map(m => m.displayName ?? m.username).join(', ') || 'Conversation'
  const activeMemberId = otherMembers.length === 1 ? otherMembers[0].id : undefined

  // The new-message form — reused by the desktop reading pane and the mobile
  // Messages page.
  const newMessageForm = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 mb-1">
        <button
          onClick={() => { setShowNewMessage(false); setCreateError(null); ri.reset() }}
          className="label-ui text-grey-600 hover:text-black"
        >
          &#8592;
        </button>
        <p className="text-ui-sm font-sans font-semibold text-black">New message</p>
      </div>
      <div className="p-4">
        <label className="label-ui text-grey-600 block mb-2">To</label>
        <input
          type="text"
          value={ri.query}
          onChange={(e) => { setCreateError(null); ri.onQueryChange(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            // Enter picks an unambiguous match; otherwise re-resolves. A lone
            // SPECULATIVE fuzzy match is not unambiguous (one name-similar
            // stranger must never be DM'd implicitly), and `pending` guards
            // the debounce window where matches still answer the previous
            // query — explicit click-pick stays available for both.
            if (
              recipientMatches.length === 1 &&
              !ri.pending &&
              recipientMatches[0].confidence !== 'speculative'
            )
              void startConversation(recipientMatches[0].account!.id)
            else ri.submit()
          }}
          placeholder="Username, email, npub…"
          className="w-full bg-glasshouse-well px-3 py-2 text-ui-sm font-sans text-black placeholder-grey-300"
          autoFocus
        />
        <div className="mt-1.5 min-h-[24px]">
          {ri.resolving && (
            <p className="label-ui text-grey-600 px-1 py-1">RESOLVING…</p>
          )}
          {!ri.resolving && (ri.doneEmpty || ri.resolveError) && recipientMatches.length === 0 && (
            <p className="text-ui-xs text-grey-600 px-1 py-1">
              No one found — try a username, email, or npub.
            </p>
          )}
          {recipientMatches.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {recipientMatches.map(m => (
                <button
                  key={m.key}
                  onClick={() => void startConversation(m.account!.id)}
                  disabled={creating}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-ui-xs text-black hover:bg-glasshouse-well transition-colors disabled:opacity-50"
                >
                  <span className="truncate">{m.label}</span>
                  {m.sublabel && (
                    <span className="label-ui text-grey-600">{creating ? '…' : m.sublabel}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {createError && (
            <p className="text-ui-xs text-crimson px-1 pt-1">{createError}</p>
          )}
        </div>
      </div>
    </div>
  )

  const thread = (
    <MessageThread
      conversationId={activeConvId!}
      memberName={activeMemberName}
      memberId={activeMemberId}
      onBack={clearActive}
      onMessagesRead={handleMessagesRead}
      headerRightInset
    />
  )

  // ---------------------------------------------------------------------------
  // Mobile — two peer pages, segmented header + horizontal snap-pager.
  // ---------------------------------------------------------------------------
  if (isMobile) {
    const segments = [
      { label: 'Notifications', unread: notificationCount, page: 0 },
      { label: 'Messages', unread: dmCount, page: 1 },
    ]
    const coverActive = !!activeConvId || showNewMessage
    return (
      <div data-explain="messages" className={`relative flex flex-col ${className}`}>
        {/* Segmented header — tracks the swipe, taps to jump. Right padding
            clears the Glasshouse ✕ in the top-right corner. */}
        <div role="tablist" aria-label="Messages sections" className="flex items-stretch gap-6 px-5 pr-12 shrink-0">
          {segments.map(seg => {
            const active = mobilePage === seg.page
            return (
              <button
                key={seg.page}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => goToPage(seg.page)}
                className="relative flex items-center gap-2 py-3.5 focus-ring"
              >
                <span className={`label-ui ${active ? 'text-black' : 'text-grey-400'}`}>{seg.label}</span>
                {seg.unread > 0 && <span className="w-2 h-2 bg-crimson" aria-hidden="true" />}
                {active && <span className="slab-rule-4 absolute inset-x-0 bottom-0" aria-hidden="true" />}
              </button>
            )
          })}
        </div>

        {/* Pager — two full-width snap pages: notifications, conversation list. */}
        <div
          ref={pagerRef}
          onScroll={onPagerScroll}
          className="flex-1 min-h-0 flex overflow-x-auto snap-x snap-mandatory"
        >
          {/* Page 1 — notifications */}
          <div className="w-full shrink-0 snap-start flex flex-col min-h-0 px-5 sm:px-8 py-6">
            <NotificationsPanel
              className="flex-1 min-h-0"
              onMessageActivate={selectConversation}
            />
          </div>

          {/* Page 2 — conversation list */}
          <div className="w-full shrink-0 snap-start flex flex-col min-h-0">
            <ConversationList
              conversations={conversations}
              activeId={activeConvId}
              onSelect={(id) => selectConversation(id)}
              onNewMessage={() => setShowNewMessage(true)}
            />
          </div>
        </div>

        {/* Drill-down — the thread (or new-message form) pushed in over the
            list. Pops back via its own back arrow or a right-swipe. Absolute +
            no z-index so it covers the list/header (positioned > static) but
            stays below the Glasshouse ✕ (z-10), keeping the close-overlay
            affordance live. */}
        {coverActive && (
          <div
            className="absolute inset-0 bg-glasshouse flex flex-col animate-push-in"
            onTouchStart={onCoverTouchStart}
            onTouchEnd={onCoverTouchEnd}
          >
            {showNewMessage ? newMessageForm : thread}
          </div>
        )}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Desktop — three columns side-by-side.
  // ---------------------------------------------------------------------------
  return (
    <div data-explain="messages" className={`flex ${className}`}>
      {/* Notifications — left */}
      <div className="md:flex-1 md:min-w-[300px] shrink-0 flex flex-col min-h-0 px-5 sm:px-8 py-10">
        <NotificationsPanel
          className="flex-1 min-h-0"
          onMessageActivate={selectConversation}
        />
      </div>

      {/* Conversation list — middle. Grey ground separates it from the white
          panes either side by surface contrast (no divider rule). The `pt-6`
          reserves the band the Glasshouse drag-grip occupies (top-centre of the
          pane, which lands over this column at every realistic pane width) so the
          grip sits over the empty grey strip, never the "Messages" header. */}
      <div className="w-[240px] shrink-0 flex flex-col min-h-0 bg-grey-100 pt-6">
        <ConversationList
          conversations={conversations}
          activeId={activeConvId}
          onSelect={(id) => selectConversation(id)}
          onNewMessage={() => setShowNewMessage(true)}
        />
      </div>

      {/* Reading pane — right (deliberately the narrower column). */}
      <div className="w-[400px] shrink-0 flex flex-col min-h-0">
        {showNewMessage ? newMessageForm
          : activeConvId ? thread
          : (
            <div className="flex-1 flex items-center justify-center px-6">
              <p className="text-ui-sm font-sans text-grey-600 text-center">Select a conversation or start a new one.</p>
            </div>
          )}
      </div>
    </div>
  )
}
