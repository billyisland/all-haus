'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '../../stores/auth'
import { useUnreadCounts } from '../../stores/unread'
import { notifications as notificationsApi, type Notification } from '../../lib/api'
import { routeToOverlay } from '../../lib/workspace/overlays'
import { timeAgo } from '../../lib/format'

// =============================================================================
// NotificationsPanel — the notifications activity log. It is the left column of
// the merged Messages inbox (MessagesInbox, hosted by MessagesOverlay); a
// `new_message` row selects the conversation in place via onMessageActivate.
// Unread items render bold with a crimson dot; read items stay visible but
// muted. Older items load in tranches via cursor pagination. The caller supplies
// the root `className` (height); auth gating is the caller's concern (the
// overlay only mounts when authenticated). The standalone /notifications route
// is a redirect shim into the merged Messages overlay.
// =============================================================================

function getDestUrl(n: Notification): string {
  switch (n.type) {
    case 'new_follower':
    case 'new_subscriber':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_reply':
      if (n.article?.slug) {
        return n.comment?.id
          ? `/article/${n.article.slug}#reply-${n.comment.id}`
          : `/article/${n.article.slug}`
      }
      // Reply to a note — go to the actor's profile
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'new_quote':
    case 'new_mention':
      if (n.article?.slug) return `/article/${n.article.slug}`
      // Note-based quote/mention — go to the actor's profile
      return n.actor?.username ? `/${n.actor.username}` : '#'
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return '/reader?overlay=dashboard&tab=proposals'
    case 'new_message':
      return n.conversationId
        ? `/reader?overlay=messages&conversation=${n.conversationId}`
        : '/reader?overlay=messages'
    case 'pub_article_submitted':
    case 'pub_article_published':
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    case 'tribute_offer_received':
      // Open the piece — the Tributes apparatus there carries Accept / Decline.
      return n.article?.slug ? `/article/${n.article.slug}` : '#'
    case 'pub_invite_received':
      return '/reader?overlay=dashboard'
    case 'subscription_offer':
      // The gift itself. Null once revoked (the gateway withholds the code), in
      // which case there is nowhere useful to go — the writer's profile is the
      // honest fallback, not a /subscribe URL that 404s.
      return n.offer?.code
        ? `/subscribe/${n.offer.code}`
        : n.actor?.username
          ? `/${n.actor.username}`
          : '#'
    case 'pub_new_subscriber':
    case 'pub_member_joined':
    case 'pub_member_left':
      return n.actor?.username ? `/${n.actor.username}` : '#'
    default:
      return '#'
  }
}

function NotificationRow({ n, onActivate }: { n: Notification; onActivate: (n: Notification) => void }) {
  const actorName = n.actor?.displayName ?? n.actor?.username ?? 'Someone'
  const isUnread = !n.read

  const labels: Partial<Record<Notification['type'], string>> = {
    new_follower: 'followed you',
    new_subscriber: 'subscribed to your content',
    new_quote: 'quoted you',
    new_mention: 'mentioned you',
    commission_request: 'sent you a commission request',
    drive_funded: 'your pledge drive reached its goal',
    pledge_fulfilled: 'a pledge drive you backed was published',
    new_message: 'sent you a message',
    pub_article_submitted: 'submitted an article for review',
    pub_article_published: 'published your article',
    pub_new_subscriber: 'subscribed to your publication',
    pub_invite_received: 'invited you to a publication',
    pub_member_joined: 'joined your publication',
    pub_member_left: 'left your publication',
    tribute_offer_received: 'wants to share earnings with you',
    subscription_offer: 'sent you a gift subscription',
  }

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onActivate(n)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onActivate(n) }}
      className={`flex items-start gap-3 px-1 py-4 hover:bg-grey-100/50 transition-colors cursor-pointer ${isUnread ? 'bg-glasshouse-well' : ''}`}
    >
      {n.actor?.avatar ? (
        <img src={n.actor.avatar} alt="" className="h-10 w-10 object-cover flex-shrink-0 mt-0.5" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center bg-grey-100 text-sm font-medium text-grey-600 flex-shrink-0 mt-0.5">
          {(n.actor?.displayName ?? n.actor?.username ?? '?')[0].toUpperCase()}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {n.type === 'new_reply' ? (
          <>
            <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
              <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
              {' replied'}
              {n.article?.title && <>{' to '}<span className="italic">{n.article.title}</span></>}
            </p>
            {n.comment?.content && (
              <p className="text-sm text-grey-600 mt-1 line-clamp-2 leading-snug">{n.comment.content}</p>
            )}
          </>
        ) : (
          <p className={`text-sm leading-snug ${isUnread ? 'text-black font-semibold' : 'text-grey-600'}`}>
            <span className={isUnread ? 'font-semibold' : 'font-medium'}>{actorName}</span>
            {' '}{labels[n.type] ?? 'sent you a notification'}
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
  const [items, setItems] = useState<Notification[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const hasUnread = items.some((n) => !n.read)

  const fetchPage = useCallback(async (cursor?: string) => {
    const isInitial = !cursor
    if (isInitial) setDataLoading(true)
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
    } finally {
      setDataLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { if (user) void fetchPage() }, [user, fetchPage])

  async function handleActivate(n: Notification) {
    const href = getDestUrl(n)
    // Optimistic mark-read, then sync the shared badge count.
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

    if (href === '#') return
    // A workspace-overlay target opens in place (we're already on /reader);
    // anything else is a real navigation.
    const openedOverlay = routeToOverlay(href)
    onClose?.()
    if (!openedOverlay) router.push(href)
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
          <p className="text-ui-sm text-grey-600 mt-1">Your activity log</p>
        </div>
        <button
          type="button"
          onClick={handleReadAll}
          disabled={!hasUnread}
          className="label-ui text-grey-600 enabled:hover:text-black disabled:opacity-50"
        >
          Mark all read
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
        ) : items.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-ui-sm text-grey-600">No notifications yet</p>
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
