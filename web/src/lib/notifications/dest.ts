import type { Notification } from '../api'
import type { ProfileFocus } from '../../stores/profileOverlay'
import { replyAnchor } from '../post/reply-anchor'

// =============================================================================
// Where a notification leads — pure, so both registers read it: the full
// site's `NotificationsPanel` (a client component) and modernhaus's
// `/modernhaus/notifications`, which maps each destination onto its own pages.
// =============================================================================

// A destination is a URL AND WHAT KIND OF THING IT NAMES, because those are two
// different answers and flattening them to a string threw the second one away.
//
// Nine of the branches below point at a PERSON, and a person is a Glasshouse
// pane on this platform — `ProfileLink`'s rule, which every byline on the site
// already obeys. This panel could not obey it because it had reduced every
// destination to an href, and `profileTargetFromHref` cannot be asked "is this
// a profile?" after the fact: its native matcher is `/^\/@?([^/?#]+)/`, which
// answers YES to `/article/abc` with the username "article". The kind is known
// here, at the branch, and nowhere else — so it is carried rather than re-derived.
export type Dest =
  | { kind: 'profile'; href: string; focus: ProfileFocus | null }
  | { kind: 'url'; href: string }
  | { kind: 'none' }

const NOWHERE: Dest = { kind: 'none' }
/** A person — the profile pane, opened over whatever the click was made in.
 *  Where the row is about something they WROTE, the pane opens ON it: the
 *  server sends the post_id and the view it lives in, because a notification
 *  that names a person and then shows their front door has answered a question
 *  nobody asked. Rows that name a person for some other reason (a follow, a
 *  gift) carry no focus and open exactly as before. */
const person = (
  username?: string | null,
  focus?: ProfileFocus | null,
): Dest =>
  username
    ? { kind: 'profile', href: `/${username}`, focus: focus ?? null }
    : NOWHERE
/** Anything else — a workspace overlay deep link, or a real navigation. */
const page = (href: string): Dest => ({ kind: 'url', href })

export function getDest(n: Notification, selfUsername?: string | null): Dest {
  switch (n.type) {
    case 'new_follower':
    case 'new_subscriber':
      return person(n.actor?.username)
    case 'new_reply':
      if (n.article?.slug) {
        return page(
          n.comment?.id
            ? `/article/${n.article.slug}${replyAnchor(n.comment.id)}`
            : `/article/${n.article.slug}`
        )
      }
      // Reply to a note — go to the actor's profile, opened on the reply
      return person(n.actor?.username, n.focus)
    case 'new_quote':
    case 'new_mention':
      if (n.article?.slug) return page(`/article/${n.article.slug}`)
      // Note-based quote/mention — the profile, opened on the note itself
      return person(n.actor?.username, n.focus)
    case 'commission_request':
    case 'drive_funded':
    case 'pledge_fulfilled':
      return page('/reader?overlay=dashboard&tab=proposals')
    case 'new_message':
      return page(
        n.conversationId
          ? `/reader?overlay=messages&conversation=${n.conversationId}`
          : '/reader?overlay=messages'
      )
    case 'pub_article_submitted':
    case 'pub_article_published':
      return n.article?.slug ? page(`/article/${n.article.slug}`) : NOWHERE
    case 'tribute_offer_received':
      // Open the piece — the Tributes apparatus there carries Accept / Decline.
      return n.article?.slug ? page(`/article/${n.article.slug}`) : NOWHERE
    case 'pub_invite_received':
      return page('/reader?overlay=dashboard')
    case 'subscription_offer':
      // The gift itself. Null once revoked (the gateway withholds the code), in
      // which case there is nowhere useful to go — the writer's profile is the
      // honest fallback, not a /subscribe URL that 404s.
      return n.offer?.code
        ? page(`/subscribe/${n.offer.code}`)
        : person(n.actor?.username)
    case 'pub_new_subscriber':
    case 'pub_member_joined':
    case 'pub_member_left':
      return person(n.actor?.username)
    case 'cross_post_failed':
      // The actor is the member themselves: their own profile, opened on the
      // note that did not go out.
      return person(n.actor?.username, n.focus)
    case 'external_reply':
    case 'external_mention':
    case 'external_quote':
      // Somebody on Bluesky or Mastodon, answering or quoting one of the
      // reader's cross-posts: their OWN profile, opened on that note — whose
      // conversation draws the remote reply beneath it (rung B). Anything
      // else (a bare mention, a reply to a post made directly on the other
      // network) opens on the person who wrote it.
      if (n.focus && selfUsername) return person(selfUsername, n.focus)
      return n.external?.authorId
        ? {
            kind: 'profile',
            href: `/author/${encodeURIComponent(n.external.authorId)}`,
            focus: null,
          }
        : NOWHERE
    default:
      return NOWHERE
  }
}
