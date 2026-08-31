import { request } from './client'

export interface NotificationActor {
  id: string
  username: string | null
  displayName: string | null
  avatar: string | null
}

export type NotificationType =
  | 'new_follower'
  | 'new_reply'
  | 'new_subscriber'
  | 'new_quote'
  | 'new_mention'
  | 'commission_request'
  | 'drive_funded'
  | 'pledge_fulfilled'
  | 'new_message'
  | 'pub_article_submitted'
  | 'pub_article_published'
  | 'pub_new_subscriber'
  | 'pub_invite_received'
  | 'pub_member_joined'
  | 'pub_member_left'
  | 'tribute_offer_received'
  | 'subscription_offer'

export interface Notification {
  id: string
  type: NotificationType
  read: boolean
  createdAt: string
  actor: NotificationActor | null
  article: { id: string; title: string | null; slug: string | null; writerUsername: string | null } | null
  note: { id: string; nostrEventId: string | null } | null
  comment: { id: string; content: string | null } | null
  conversationId?: string
  driveId?: string
  /** Grant-mode subscription offers: the code addresses /subscribe/:code. Null
   *  once the offer is revoked, so the row stops linking to a page that 404s. */
  offer?: { id: string; code: string } | null
}

export const notifications = {
  list: (cursor?: string) => {
    const params = new URLSearchParams()
    if (cursor) params.set('cursor', cursor)
    const qs = params.toString()
    return request<{ notifications: Notification[]; unreadCount: number; nextCursor: string | null }>(
      `/notifications${qs ? `?${qs}` : ''}`
    )
  },

  markRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/${id}/read`, { method: 'POST' }),

  readAll: () =>
    request<{ ok: boolean }>('/notifications/read-all', { method: 'POST' }),

  unreadCounts: () =>
    request<{ dmCount: number; notificationCount: number }>('/unread-counts'),

  getPreferences: () =>
    request<{ preferences: Record<string, boolean> }>('/notifications/preferences'),

  setPreference: (category: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/notifications/preferences/${category}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
}
