import type { Notification } from '../../lib/api/notifications'
import type { SourceMeta } from '../../lib/api/feeds'
import type { Post } from '../../lib/post/types'
import { REPORT_CATEGORIES } from '../../lib/api/admin'
import { getDest, type Dest } from '../../lib/notifications/dest'
import {
  EXTERNAL_LABEL,
  crossPostFailedSentence,
  externalNetworkSuffix,
  notificationActorName,
  notificationLabel,
  replyVerb,
  NOTIFICATIONS_EMPTY,
} from '../../content/notifications'
import {
  REPORT_CATEGORY_LABEL,
  REPORT_TITLE,
  REPORT_NOTES_PLACEHOLDER,
  REPORT_SUBMIT,
  REPORT_FOOTNOTE,
} from '../../content/report'
import { query } from '../gateway'
import { PostForm, Hidden, NextLink, Time, TextParagraphs, type Viewer } from '../html'
import { PostList, type ItemActions } from '../post'
import type { ConfirmSpec } from '../confirms'
import type { FeedMembership, FollowSubject } from '../member-loaders'
import { feedLabel } from './feeds'

// =============================================================================
// modernhaus — the member pages of the reading step (§D2.3, E3): the follow
// picker, a report, an "are you sure?", notifications, and a source.
// =============================================================================

// ---------------------------------------------------------------------------
// Follow — every follow takes its feed from the context or asks for one
// (web-profile.md). This page asks: the feeds that already hold them, said;
// the rest as choices, and a new feed named on the spot. The route writes the
// graph row; this page never claims a follow it did not see the route make.
// ---------------------------------------------------------------------------

export interface FollowPageProps {
  csrf: string
  subject: FollowSubject
  name: string
  home: string
  back: string
  feeds: FeedMembership[]
  /** Set when the press came from a feed: follow into that one, no picker. */
  intoFeed: string | null
}

export function FollowPage(props: FollowPageProps) {
  const subjectFields = props.subject.kind === 'writer' ? { writer: props.subject.username } : { [props.subject.kind]: props.subject.id }
  const holding = props.feeds.filter((m) => typeof m.row === 'string' && m.row !== 'unknown')
  const unknown = props.feeds.filter((m) => m.row === 'unknown')
  const open = props.feeds.filter((m) => m.row === null)
  const into = props.intoFeed ? open.find((m) => m.feed.id === props.intoFeed) : undefined
  const label = (m: FeedMembership) => feedLabel(m.feed, null)

  return (
    <>
      <p>
        <a href={props.home}>{props.name}</a>
      </p>
      {holding.length > 0 && <p>{`Already in: ${holding.map(label).join(', ')}.`}</p>}
      {unknown.length > 0 && <p>{`We couldn’t check whether ${unknown.map(label).join(' or ')} already includes them. Please reload the page to try again.`}</p>}
      <PostForm action="follow" csrf={props.csrf}>
        <Hidden values={{ return: props.back, ...subjectFields }} />
        {into ? (
          <p>
            <input type="hidden" name="feedId" value={into.feed.id} />
            <button>{`Follow into ${label(into)}`}</button>
          </p>
        ) : (
          <fieldset>
            <legend>Which channel?</legend>
            {open.map((m, i) => (
              <p key={m.feed.id}>
                <label>
                  <input type="radio" name="feedId" value={m.feed.id} defaultChecked={i === 0} />
                  {` ${label(m)}${m.feed.hidden ? ' (hidden)' : ''}`}
                </label>
              </p>
            ))}
            <p>
              <label>
                <input type="radio" name="feedId" value="new" defaultChecked={open.length === 0} />
                {' A new channel, named '}
              </label>
              <input type="text" name="newFeedName" maxLength={80} aria-label="The new channel's name" />
            </p>
            <p>
              <button>Follow</button>
            </p>
          </fieldset>
        )}
      </PostForm>
      {holding.length > 0 && (
        <p>
          <a href={`/modernhaus/confirm/unfollow_everywhere${query({ ...subjectFields, return: props.home })}`}>
            Unfollow everywhere
          </a>
        </p>
      )}
      <p>
        <a href={props.back}>Cancel</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Report — twelve categories, in the reporter's words; the priority is the
// server's, derived from the category and never sent.
// ---------------------------------------------------------------------------

export type ReportTarget =
  | { kind: 'post'; postId: string; eventId: string | null }
  | { kind: 'event'; eventId: string }
  | { kind: 'account'; accountId: string }

export function reportTargetFields(t: ReportTarget): Record<string, string | null> {
  switch (t.kind) {
    case 'post':
      return { targetPostId: t.postId, targetNostrEventId: t.eventId }
    case 'event':
      return { targetNostrEventId: t.eventId }
    case 'account':
      return { targetAccountId: t.accountId }
  }
}

export function ReportPage(props: { csrf: string; target: ReportTarget; back: string }) {
  return (
    <>
      <PostForm action="report" csrf={props.csrf}>
        <Hidden values={{ return: props.back, ...reportTargetFields(props.target) }} />
        <fieldset>
          <legend>{REPORT_TITLE}</legend>
          {REPORT_CATEGORIES.map((c) => (
            <p key={c}>
              <label>
                <input type="radio" name="category" value={c} required />
                {` ${REPORT_CATEGORY_LABEL[c]}`}
              </label>
            </p>
          ))}
        </fieldset>
        <p>
          <label>
            {REPORT_NOTES_PLACEHOLDER}
            <br />
            <textarea name="notes" rows={3} cols={60} maxLength={2000} />
          </label>
        </p>
        <p>
          <button>{REPORT_SUBMIT}</button>
        </p>
      </PostForm>
      <p>{REPORT_FOOTNOTE}</p>
      <p>
        <a href={props.back}>Cancel</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// An "are you sure?" — the consequence, one button, and Cancel.
// ---------------------------------------------------------------------------

export function ConfirmPage(props: {
  csrf: string
  action: string
  spec: Pick<ConfirmSpec, 'consequence' | 'button'>
  values: Record<string, string>
  back: string
}) {
  const consequence = props.spec.consequence
  const paragraphs = typeof consequence === 'string' ? (consequence ? [consequence] : []) : consequence
  return (
    <>
      {paragraphs.map((p) => (
        <p key={p}>{p}</p>
      ))}
      <PostForm action={props.action} csrf={props.csrf}>
        <Hidden values={{ return: props.back, ...props.values }} />
        <p>
          <button>{props.spec.button}</button>
        </p>
      </PostForm>
      <p>
        <a href={props.back}>Cancel</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// Notifications — each row's sentence is the full site's (`content/
// notifications.ts`) and its destination the full site's `getDest`, mapped
// onto this register's pages. Following a link is a GET, so it marks nothing
// read: that is its own button.
// ---------------------------------------------------------------------------

/** A destination in this register, or the full site's page where there is none yet. */
export function modernhausDest(dest: Dest): { href: string; fullSite: boolean } | null {
  if (dest.kind === 'none') return null
  if (dest.kind === 'profile') {
    // A row about something they WROTE opens on it: the conversation.
    if (dest.focus) return { href: `/modernhaus/thread/${encodeURIComponent(dest.focus.postId)}`, fullSite: false }
    const author = dest.href.match(/^\/author\/([^/?#]+)$/)
    if (author) return { href: `/modernhaus/author/${author[1]}`, fullSite: false }
    const user = dest.href.match(/^\/([^/?#]+)$/)
    if (user) return { href: `/modernhaus/u/${user[1]}`, fullSite: false }
    return null
  }
  const article = dest.href.match(/^\/article\/([^/?#]+)(?:#reply-([0-9a-f-]+))?$/i)
  if (article) {
    // The comment rides as `focus` too, so the foot's first page is widened
    // through the reply that carries it (GET /thread/:postId/top's errand).
    const [, dTag, comment] = article
    return {
      href: comment ? `/modernhaus/article/${dTag}?focus=${comment}#reply-${comment}` : `/modernhaus/article/${dTag}`,
      fullSite: false,
    }
  }
  // The overlays the full site opens over its workspace are pages here (E6).
  const convo = dest.href.match(/^\/reader\?overlay=messages&conversation=([0-9a-f-]+)$/i)
  if (convo) return { href: `/modernhaus/messages/${convo[1]}`, fullSite: false }
  if (dest.href === '/reader?overlay=messages') return { href: '/modernhaus/messages', fullSite: false }
  if (dest.href === '/reader?overlay=dashboard&tab=proposals') return { href: '/modernhaus/dashboard/offers', fullSite: false }
  if (dest.href === '/reader?overlay=dashboard') return { href: '/modernhaus/dashboard', fullSite: false }
  const offer = dest.href.match(/^\/subscribe\/([^/?#]+)$/)
  if (offer) return { href: `/modernhaus/subscribe/${offer[1]}`, fullSite: false }
  return dest.href.startsWith('/') && !dest.href.startsWith('//') ? { href: dest.href, fullSite: true } : null
}

function NotificationSentence(props: { n: Notification }) {
  const { n } = props
  const actor = notificationActorName(n)
  if (n.type === 'new_reply') {
    const { verb, joiner } = replyVerb(n)
    return (
      <>
        <p>
          {actor}
          {verb}
          {n.article?.title && (
            <>
              {joiner}
              {`“${n.article.title}”`}
            </>
          )}
        </p>
        {n.comment?.content && <TextParagraphs text={n.comment.content} />}
      </>
    )
  }
  if (n.external && EXTERNAL_LABEL[n.type]) {
    return (
      <>
        <p>{`${actor} ${EXTERNAL_LABEL[n.type]}${externalNetworkSuffix(n)}`}</p>
        {n.external.excerpt && <TextParagraphs text={n.external.excerpt} />}
      </>
    )
  }
  if (n.type === 'cross_post_failed') {
    return (
      <>
        <p>{crossPostFailedSentence(n)}</p>
        {(n.crossPostFailures ?? [])
          .filter((f) => f.error)
          .map((f, i) => (
            <p key={i}>{f.error}</p>
          ))}
      </>
    )
  }
  return <p>{`${actor} ${notificationLabel(n)}`}</p>
}

export function NotificationsPage(props: {
  csrf: string
  viewer: Viewer
  notifications: Notification[]
  next: string | null
  self: string
}) {
  const unread = props.notifications.some((n) => !n.read)
  if (props.notifications.length === 0) return <p>{NOTIFICATIONS_EMPTY}.</p>
  return (
    <PostForm action="notification_read" csrf={props.csrf}>
      <Hidden values={{ return: props.self }} />
      {unread && (
        <p>
          <button formAction="/modernhaus/do/notifications_read_all">Mark all as read</button>
        </p>
      )}
      <ol>
        {props.notifications.map((n) => {
          const dest = modernhausDest(getDest(n, props.viewer.username))
          return (
            <li key={n.id}>
              <article>
                <header>
                  <p>
                    {n.read ? 'Read' : 'Unread'}
                    {' · '}
                    <Time at={new Date(n.createdAt)} />
                  </p>
                </header>
                <NotificationSentence n={n} />
                <p>
                  {dest && <a href={dest.href}>{dest.fullSite ? 'Open on the full site' : 'Open'}</a>}
                  {dest && !n.read && ' · '}
                  {!n.read && (
                    <button name="id" value={n.id}>
                      Mark as read
                    </button>
                  )}
                </p>
              </article>
            </li>
          )
        })}
      </ol>
      <NextLink href={props.next} />
    </PostForm>
  )
}

// ---------------------------------------------------------------------------
// A source — the provenance line's destination.
// ---------------------------------------------------------------------------

export function SourcePage(props: {
  source: SourceMeta
  sourceId: string
  items: Post[]
  next: string | null
  actions: ItemActions
}) {
  const { source } = props
  const followable = !!source.followTarget
  return (
    <>
      {source.description && <TextParagraphs text={source.description} />}
      <p>{`${source.protocol} · ${source.sourceUri}`}</p>
      {followable && (
        <p>
          <a href={`/modernhaus/follow${query({ source: props.sourceId, return: props.actions.back })}`}>Follow…</a>
        </p>
      )}
      <PostList posts={props.items} empty="Nothing from this source yet." actions={props.actions} />
      <NextLink href={props.next} />
    </>
  )
}

