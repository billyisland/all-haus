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
  | 'cross_post_failed'
  | 'external_reply'
  | 'external_mention'
  | 'external_quote'

export interface Notification {
  id: string
  type: NotificationType
  read: boolean
  createdAt: string
  actor: NotificationActor | null
  article: { id: string; title: string | null; slug: string | null; writerUsername: string | null } | null
  note: { id: string; nostrEventId: string | null } | null
  comment: { id: string; content: string | null } | null
  /** THE COMMENT THAT WAS REPLIED TO — a different comment from `comment`
   *  above, which on a `new_reply` is the NEW reply (what the row renders and
   *  what `focus` opens). Bound by the gateway only where the recipient is
   *  being told because the reply was to a remark of THEIRS (migration 230),
   *  so one nested reply produces two rows that are otherwise identical and
   *  this is what tells them apart. Its presence picks the sentence: *replied
   *  to your comment* against *replied to <title>*. Read it as a presence
   *  check; null is the ordinary case on every other row. */
  parentComment: { id: string } | null
  // The publication a pub_* notification is about (migration 198). It is what
  // makes two of them distinguishable now that two publications no longer
  // collapse into one row — "invited you to a publication" twice, identically,
  // would be a worse surface than the collapse it replaced.
  publication: { id: string; name: string | null; slug: string | null } | null
  conversationId?: string
  driveId?: string
  /** Grant-mode subscription offers: the code addresses /subscribe/:code. Null
   *  once the offer is revoked, so the row stops linking to a page that 404s. */
  offer?: { id: string; code: string } | null
  /** The conversation this row is about, where it is about one: the post_id of
   *  the note or comment, and which of the profile's five views that post lives
   *  in. Null for every row that names a person for some other reason (a
   *  follow, a subscription, an invite). */
  focus?: { postId: string; view: 'posts' | 'replies' } | null
  /** `cross_post_failed` only: every network this row's note never reached,
   *  with the worker's reason (CROSS-NETWORK-ROUNDTRIP-ADR A7). One row stands
   *  for all of a note's failed targets, so this is a list; `protocol` is the
   *  outbound_posts value (`atproto` / `activitypub` / `nostr_external`). */
  crossPostFailures?: { protocol: string; error: string | null }[]
  /** The three `external_*` types only (CROSS-NETWORK-ROUNDTRIP-ADR rung C):
   *  the Bluesky/Mastodon post that was addressed to the recipient. `actor` is
   *  null on these rows — the author is not a member — so the row names them
   *  from here. `protocol` is `atproto` / `activitypub`; `authorId` is the
   *  external_authors id a profile pane opens on. Where the post answers or
   *  quotes one of the recipient's own cross-posts, `note` and `focus` are set
   *  as well, and the row opens on that conversation instead. */
  external?: {
    itemId: string
    protocol: string | null
    authorName: string | null
    authorHandle: string | null
    authorAvatar: string | null
    authorId: string | null
    excerpt: string | null
  } | null
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
