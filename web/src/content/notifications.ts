import type { Notification } from '../lib/api'

// =============================================================================
// Notifications — the words, in one home for both registers.
//
// The full site's `NotificationsPanel` (a client component) and modernhaus's
// `/modernhaus/notifications` (bare HTML) say the same sentence about each
// row. They live here because modernhaus cannot import a `'use client'` file.
// A row reads `{actor} {label}`, except the three shapes with their own
// builders: a reply (who was answered decides the sentence), a post from
// another network, and a cross-post that did not go out. The reasoning behind
// each is in `NotificationsPanel.tsx`'s comments.
// =============================================================================

/** The inbox with nothing in it — and only that. A list that could not be
 *  read says `NOTIFICATIONS_LOAD_FAILED` instead (CA-E1). */
export const NOTIFICATIONS_EMPTY = 'No notifications yet'
export const NOTIFICATIONS_LOAD_FAILED = 'Couldn’t load your notifications. Please try again.'

// outbound_posts.protocol → the network a member would name.
export const CROSS_POST_NETWORK: Record<string, string> = {
  atproto: 'Bluesky',
  activitypub: 'Mastodon',
  nostr_external: 'Nostr',
}

function crossPostNetworks(n: Notification): string {
  const names = [...new Set((n.crossPostFailures ?? []).map(f => CROSS_POST_NETWORK[f.protocol] ?? f.protocol))]
  if (names.length === 0) return 'another network'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/** `cross_post_failed`: the member's own post, so no actor name. */
export function crossPostFailedSentence(n: Notification): string {
  return `Your post is on all.haus, but we couldn’t send it to ${crossPostNetworks(n)}`
}

// The three external types, as the sentence after the author's name. "your
// post" rather than a title: a note has none, and the excerpt below says which.
export const EXTERNAL_LABEL: Partial<Record<Notification['type'], string>> = {
  external_reply: 'replied to your post',
  external_mention: 'mentioned you',
  external_quote: 'quoted your post',
}

/** `on Bluesky`, or '' where the network is not one a member would name. */
export function externalNetworkSuffix(n: Notification): string {
  const p = n.external?.protocol
  return p && CROSS_POST_NETWORK[p] ? ` on ${CROSS_POST_NETWORK[p]}` : ''
}

/** Who the row is about: the remote author for an external row, else the actor. */
export function notificationActorName(n: Notification): string {
  const ext = n.external ?? null
  return ext
    ? ext.authorName ?? ext.authorHandle ?? `${CROSS_POST_NETWORK[ext.protocol ?? ''] ?? 'Someone'} user`
    : n.actor?.displayName ?? n.actor?.username ?? 'Someone'
}

/**
 * `new_reply`: TWO PEOPLE ARE TOLD ABOUT A NESTED REPLY AND THEY ARE NOT TOLD
 * THE SAME THING — `parentComment` is bound only on the row whose recipient
 * wrote the remark being answered (migration 230). `joiner` precedes the
 * article's title where there is one.
 */
export function replyVerb(n: Notification): { verb: string; joiner: string } {
  return n.parentComment
    ? { verb: ' replied to your comment', joiner: ' on ' }
    : { verb: ' replied', joiner: ' to ' }
}

/** The sentence after the actor's name, for every row without its own builder. */
export function notificationLabel(n: Notification): string {
  const pub = n.publication?.name ?? null
  const labels: Partial<Record<Notification['type'], string>> = {
    new_follower: 'followed you',
    new_subscriber: 'bought a subscription',
    new_quote: 'quoted you',
    new_mention: 'mentioned you',
    commission_request: 'sent you a commission request',
    drive_funded: 'your pledge drive reached its goal',
    pledge_fulfilled: 'a pledge drive you backed was published',
    new_message: 'sent you a message',
    pub_article_submitted: 'submitted an article for review',
    pub_article_published: 'published your article',
    // The four pub_* labels NAME THE PUBLICATION where the row carries one.
    // Two publications inviting the same person used to collapse into ONE
    // notification (migration 198); now that both rows survive, "invited you to
    // a publication" twice, identically, would be a worse surface than the
    // collapse it replaced. Indefinite where the row predates the column or the
    // publication has since been deleted (`ON DELETE SET NULL`) — a vaguer
    // sentence beats a wrong name.
    pub_new_subscriber: pub
      ? `subscribed to ${pub}`
      : 'subscribed to your publication',
    pub_invite_received: pub ? `invited you to ${pub}` : 'invited you to a publication',
    pub_member_joined: pub ? `joined ${pub}` : 'joined your publication',
    pub_member_left: pub ? `left ${pub}` : 'left your publication',
    tribute_offer_received: 'wants to share earnings with you',
    subscription_offer: 'sent you a gift subscription',
  }
  return labels[n.type] ?? 'sent you a notification'
}
