'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
import { notifications as notificationsApi, type Notification } from '../../lib/api'
import { routeToOverlay } from '../../lib/workspace/overlays'
import { openProfileHref } from '../ui/ProfileLink'
import { getDest } from '../../lib/notifications/dest'
import {
  EXTERNAL_LABEL,
  crossPostFailedSentence,
  externalNetworkSuffix,
  notificationActorName,
  notificationLabel,
  replyVerb,
  NOTIFICATIONS_EMPTY,
  NOTIFICATIONS_LOAD_FAILED,
} from '../../content/notifications'
import { SETTINGS_RETRY } from '../../content/settings'
import { prefetchProfileOverlay } from '../workspace/prefetchProfile'
import { timeAgo } from '../../lib/format'
import { Avatar } from '../ui/Avatar'

// =============================================================================
// NotificationsPanel — the notifications activity log. It is the left column of
// the merged Messages inbox (MessagesInbox, hosted by MessagesOverlay); a
// `new_message` row selects the conversation in place via onMessageActivate.
// Unread items render bold with a crimson dot; read items stay visible but
// muted. Older items load in tranches via cursor pagination. The caller supplies
// the root `className` (height); auth gating is the caller's concern (the
// overlay only mounts when authenticated). The standalone /notifications route
// is a redirect shim into the merged Messages overlay.
//
// Where a row leads is `lib/notifications/dest.ts` and what it says is
// `content/notifications.ts`, both pure and shared with modernhaus.
// =============================================================================


function NotificationRow({ n, onActivate }: { n: Notification; onActivate: (n: Notification) => void }) {
  const ext = n.external ?? null
  const actorName = notificationActorName(n)
  const isUnread = !n.read

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onActivate(n)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onActivate(n) }}
      className={`flex items-start gap-3 px-1 py-4 hover:bg-grey-100/50 transition-colors cursor-pointer ${isUnread ? 'bg-glasshouse-well' : ''}`}
    >
      <span className="flex flex-shrink-0 mt-0.5">
        <Avatar
          src={ext ? ext.authorAvatar : n.actor?.avatar}
          name={ext ? actorName : n.actor?.displayName ?? n.actor?.username ?? '?'}
          size={40}
        />
      </span>

      <div className="min-w-0 flex-1">
        {n.type === 'new_reply' ? (
          <>
            {/* TWO PEOPLE ARE TOLD ABOUT A NESTED REPLY AND THEY ARE NOT TOLD
                THE SAME THING. `parentComment` is bound only on the row whose
                recipient is the author of the remark being answered (migration
                230), and without reading it both rows render "replied to <the
                piece>" — true for the writer, and the wrong sentence for
                somebody who left a comment under somebody else's article. It
                still NAMES the piece where there is one: which conversation
                this happened in is the other half of what makes the row
                findable. Same rule as the pub_* labels (content/notifications.ts) — a row that now
                survives beside another must say what distinguishes it. */}
            <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
              <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
              {replyVerb(n).verb}
              {n.article?.title && (
                <>
                  {replyVerb(n).joiner}
                  <span className="italic">{n.article.title}</span>
                </>
              )}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-grey-600 mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
            )}
          </>
        ) : ext && EXTERNAL_LABEL[n.type] ? (
          <>
            {/* Somebody on another network (rung C). Named from the post,
                with the network said, because the name alone is a stranger's
                and the reader needs to know where to answer them. */}
            <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
              <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
              {' '}{EXTERNAL_LABEL[n.type]}
              {externalNetworkSuffix(n)}
            </p>
            {ext.excerpt && (
              <p className="text-sm text-grey-600 mt-1 line-clamp-2 leading-snug">{ext.excerpt}</p>
            )}
          </>
        ) : n.type === 'cross_post_failed' ? (
          <>
            {/* The member's own post, so no actor name: the sentence is about
                where it did NOT go, and the reason is what they act on
                (usually "reconnect"). A7. */}
            <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
              {crossPostFailedSentence(n)}
            </p>
            {(n.crossPostFailures ?? []).filter(f => f.error).map((f, i) => (
              <p key={i} className="text-sm text-grey-600 mt-1 line-clamp-2 leading-snug">{f.error}</p>
            ))}
          </>
        ) : (
          <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
            <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
            {' '}{notificationLabel(n)}
          </p>
        )}
        <p className="text-xs text-grey-600 mt-1">{timeAgo(n.createdAt)}</p>
      </div>

      {isUnread && (
        <span className="flex-shrink-0 mt-2 h-2 w-2 bg-crimson rounded-full" />
      )}
    </div>
  )
}

export function NotificationsPanel({
  className = '',
  inOverlay = false,
  onClose,
  onMessageActivate,
}: {
  className?: string
  inOverlay?: boolean
  // Called when a row navigates away — lets the overlay dismiss itself.
  onClose?: () => void
  // When provided, a `new_message` notification is handled in place (the host
  // selects that conversation) instead of routing away + closing. Used by the
  // merged Messages inbox, where notifications and DMs share one surface.
  onMessageActivate?: (conversationId: string | null) => void
}) {
  const { user } = useAuth()
  const router = useRouter()
  const refreshUnread = useUnreadCounts((s) => s.fetch)
  const noteRead = useUnreadCounts((s) => s.noteRead)
  const [items, setItems] = useState<Notification[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  // A list that could not be read is not an empty list (CA-E1): the catch
  // below used to log and leave `items` empty, and the branch read "No
  // notifications yet" through every outage.
  const [loadFailed, setLoadFailed] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const hasUnread = items.some((n) => !n.read)

  const fetchPage = useCallback(async (cursor?: string) => {
    const isInitial = !cursor
    if (isInitial) { setDataLoading(true); setLoadFailed(false) }
    else setLoadingMore(true)

    try {
      const data = await notificationsApi.list(cursor)
      if (isInitial) {
        setItems(data.notifications)
      } else {
        setItems(prev => {
          const existingIds = new Set(prev.map(n => n.id))
          const unique = data.notifications.filter(n => !existingIds.has(n.id))
          return [...prev, ...unique]
        })
      }
      setNextCursor(data.nextCursor)
    } catch (err) {
      console.error('Failed to load notifications', err)
      if (isInitial) setLoadFailed(true)
    } finally {
      setDataLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { if (user) void fetchPage() }, [user, fetchPage])

  // Most rows in this list lead to a person, and a person is a pane opening in
  // the place of this one — so the chunk is warmed while the list is being read
  // rather than inside the click (the handoff rule, part 2).
  useEffect(() => { prefetchProfileOverlay() }, [])

  async function handleActivate(n: Notification) {
    const dest = getDest(n, user?.username)
    // Optimistic mark-read — the ROW and the BADGE together, then the
    // round-trip to make it true. Leaving the count to the round-trip alone
    // made it a fact that lagged the screen, and `restore()` reads it to
    // decide whether to put the inbox back when this pane closes: open the
    // LAST unread notification, close the pane inside that round-trip, and
    // the reader was handed an empty inbox they had just finished with.
    if (!n.read) noteRead()
    setItems(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
    notificationsApi.markRead(n.id)
      .then(() => refreshUnread())
      .catch(err => console.error('Failed to mark notification read', err))

    // In the merged Messages inbox a message notification selects the
    // conversation in the reading pane — stay put, don't route/close.
    if (n.type === 'new_message' && onMessageActivate) {
      onMessageActivate(n.conversationId ?? null)
      return
    }

    if (dest.kind === 'none') return

    // A PERSON OPENS AS A PANE, IN THE PLACE OF THIS ONE — and this branch
    // closes nothing on the way. Glasshouse's one-at-a-time invariant
    // supersedes the inbox from the profile's own mount effect, so the two
    // cross in a single commit; closing here would take the inbox down before
    // the code-split profile chunk has landed, leaving the gap the handoff rule
    // exists to prevent. If the chunk is slow, the inbox holds the screen.
    // `returnTo` is the other half of not closing: the inbox is superseded
    // rather than closed, so it is the PROFILE's close that has to put it back
    // — and only if there is anything left unread to come back to. A reader
    // working down a list should find the list; a reader who has just read the
    // last of them should find the workspace.
    if (
      dest.kind === 'profile' &&
      openProfileHref(dest.href, null, {
        focus: dest.focus,
        returnTo: 'messages',
      })
    )
      return

    // A workspace-overlay target opens in place (we're already on /reader);
    // anything else is a real navigation.
    const openedOverlay = routeToOverlay(dest.href)
    onClose?.()
    if (!openedOverlay) router.push(dest.href)
  }

  async function handleReadAll() {
    if (!hasUnread) return
    setItems(prev => prev.map(n => ({ ...n, read: true })))
    try {
      await notificationsApi.readAll()
      void refreshUnread()
    } catch (err) {
      console.error('Read-all failed', err)
      void fetchPage()
    }
  }

  return (
    <div data-explain="messages.notifications" className={`flex flex-col ${className}`}>
      <div className={`flex items-baseline justify-between mb-6 ${inOverlay ? 'pr-10' : ''}`}>
        <div>
          <h1 className="font-sans text-2xl font-medium text-black tracking-tight">Notifications</h1>
          <p className="text-ui-sm text-grey-600 mt-1">When someone replies to you, mentions you, follows you or writes to you, it shows up here.</p>
        </div>
        <button
          type="button"
          onClick={handleReadAll}
          disabled={!hasUnread}
          className="label-ui text-grey-600 enabled:hover:text-black disabled:opacity-50"
        >
          Mark all as read
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {dataLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 py-4 animate-pulse">
                <div className="h-10 w-10 bg-grey-100 flex-shrink-0" />
                <div className="flex-1">
                  <div className="h-3.5 w-48 bg-grey-100 mb-2 rounded" />
                  <div className="h-3 w-20 bg-grey-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : loadFailed ? (
          <div className="py-20 text-center">
            <p className="text-ui-sm text-grey-600">
              {NOTIFICATIONS_LOAD_FAILED}{' '}
              <button onClick={() => void fetchPage()} className="btn-text-muted">{SETTINGS_RETRY}</button>
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-ui-sm text-grey-600">{NOTIFICATIONS_EMPTY}</p>
          </div>
        ) : (
          <div>
            <div>
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onActivate={handleActivate} />
              ))}
            </div>

            {nextCursor && (
              <div className="py-6 text-center">
                <button
                  onClick={() => fetchPage(nextCursor)}
                  disabled={loadingMore}
                  className="text-sm font-sans text-grey-600 hover:text-black transition-colors"
                >
                  {loadingMore ? 'Loading…' : 'Load older notifications'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
