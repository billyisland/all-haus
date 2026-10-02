import type { Post } from '../lib/post/types'
import { safeHttpUrl, externalizeHtml } from '../lib/external-links'
import { originWebUrl } from '../lib/post/origin-url'
import { formatPrice } from '../lib/format'
import type { LinkedAccount } from '../lib/api/linked-accounts'
import { tierCaps } from '../lib/post/level-spec'
import { interactionCaps } from '../lib/post/interaction-caps'
import { stripOrnament } from './html-pass'
import { query } from './gateway'
import { Time, fromUnix, TextParagraphs, PostForm, Hidden, type Viewer } from './html'
import { sourcePageId } from '../lib/post/source-page'

// =============================================================================
// modernhaus — a post in a list (MODERNHAUS-ADR §D2.6).
//
// ONE POST PER ITEM: a parent is never drawn inside a child, and a quoted post
// is a short blockquote, never a second post. Every URL off the wire goes
// through `safeHttpUrl`; stored HTML goes through `externalizeHtml` (outbound
// links open in a new tab, as on the full site) and then the ornament pass.
//
// THE ACTION ROW (E3) is ONE form per post, many buttons (§D2.6): the vote
// buttons are the form's own action, and an external like or repost carries
// `formaction`. A button that cannot do its job is not offered — a direction
// the viewer already used is text, a locked conversation offers no vote, an
// external action needs a linked account on that network and a tier that
// interacts back (the same gate the full site asks, `interactionCaps`). Quote
// (E4) is a link to the compose page, offered where the full site offers it:
// not on a locked conversation (`PostActions`: `onQuote && !locked`).
// =============================================================================

/** The all.haus votes on a page's native posts, keyed by event id. A null
 *  half is a read that failed: its counts are not shown, never shown as 0. */
export interface VoteLookup {
  tally: Record<string, { upvoteCount: number; downvoteCount: number }> | null
  mine: Record<string, { upCount: number; downCount: number }> | null
}

/** What a list needs to draw each post's action row, for a member. */
export interface ItemActions {
  viewer: Viewer
  csrf: string
  /** Where every press on this page returns to. */
  back: string
  votes: VoteLookup
  /** The viewer's linked accounts, or null when they could not be read — in
   *  which case no external action is offered rather than a wrong one. */
  linked: LinkedAccount[] | null
  /** Post ids the seen window marks new. */
  newIds?: ReadonlySet<string>
}

export function authorName(post: Post): string {
  return post.author.displayName ?? post.author.handle ?? 'Unknown author'
}

function Byline(props: { post: Post }) {
  const { post } = props
  const a = post.author
  const name = authorName(post)
  if (post.origin.protocol === 'nostr' && a.accountId) {
    return a.handle ? <a href={`/modernhaus/u/${encodeURIComponent(a.handle)}`}>{name}</a> : <>{name}</>
  }
  // External. A presence a member CLAIMED (and consented to display — the
  // gateway omits `memberUsername` otherwise) links to their profile.
  const label = a.displayName && a.handle ? `${a.displayName} (${a.handle})` : name
  if (a.memberUsername) return <a href={`/modernhaus/u/${encodeURIComponent(a.memberUsername)}`}>{label}</a>
  if (a.id) return <a href={`/modernhaus/author/${encodeURIComponent(a.id)}`}>{label}</a>
  return <>{label}</>
}

/** Where to read the whole of a post that has a title, or null. */
export function articleHref(post: Post): string | null {
  if (post.type !== 'article') return null
  if (post.origin.protocol === 'nostr') {
    return post.dTag ? `/modernhaus/article/${encodeURIComponent(post.dTag)}` : null
  }
  return `/modernhaus/read/${encodeURIComponent(post.id)}`
}

/** A post's stored body, as trusted HTML ready to place, or null. */
export function bodyHtml(post: Post): string | null {
  if (!post.body.html) return null
  return stripOrnament(externalizeHtml(post.body.html))
}

function Body(props: { post: Post }) {
  const { post } = props
  if (post.isDeleted) return <p>This post was deleted.</p>
  if (post.type === 'article') {
    const summary = post.body.summary ?? post.body.text
    return summary ? <TextParagraphs text={summary} /> : null
  }
  const html = bodyHtml(post)
  if (html) return <div dangerouslySetInnerHTML={{ __html: html }} />
  return post.body.text ? <TextParagraphs text={post.body.text} linkify /> : null
}

function Media(props: { post: Post }) {
  return (
    <>
      {props.post.body.media.map((m, i) => {
        const src = safeHttpUrl(m.url)
        if (!src) return null
        if (m.type === 'image') {
          return (
            <p key={i}>
              {/* `lazy`, or Next's vendored React hoists a `<link rel="preload">`
                  into the head for every picture (MODERNHAUS-ADR §E3.2). */}
              <img src={src} alt={m.alt ?? ''} loading="lazy" />
            </p>
          )
        }
        const noun = m.type === 'video' ? 'Video' : m.type === 'audio' ? 'Audio' : 'Link'
        return (
          <p key={i}>
            {`${noun}: `}
            <a href={src} target="_blank" rel="noopener noreferrer">
              {m.title ?? src}
            </a>
          </p>
        )
      })}
    </>
  )
}

function Quoted(props: { post: Post }) {
  const q = props.post.quotedPreview
  if (!q) return null
  const text = [q.title, q.excerpt].filter(Boolean).join(': ')
  const href = safeHttpUrl(q.url)
  return (
    <blockquote>
      <p>{q.author ? `${q.author}: ${text}` : text}</p>
      {href && (
        <p>
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </p>
      )}
    </blockquote>
  )
}

function PollResults(props: { post: Post }) {
  const poll = props.post.body.poll
  if (!poll) return null
  return (
    <ol>
      {poll.options.map((o, i) => (
        <li key={i}>{`${o.title} — ${o.votesCount} ${o.votesCount === 1 ? 'vote' : 'votes'}`}</li>
      ))}
    </ol>
  )
}

/** Is this the viewer's own post? Native only: decided by the author's pubkey. */
export function isOwn(post: Post, viewer: Viewer | null): boolean {
  return !!viewer?.pubkey && post.origin.protocol === 'nostr' && post.author.pubkey === viewer.pubkey
}

/** A post's `/modernhaus/report` address. */
export function reportHref(post: Post, back: string): string {
  const native = post.origin.protocol === 'nostr'
  return `/modernhaus/report${query({
    target: `post:${post.id}`,
    // The event id rides beside the post id for a NATIVE post only: an
    // external post's `version` is a content hash, not an event (§0z item 6).
    event: native ? post.version : null,
    return: back,
  })}`
}

/** Where "Delete" goes for the viewer's own post, or null where there is no delete. */
export function deleteHref(post: Post, back: string): string | null {
  if (post.isDeleted) return null
  // A delete pressed on the post's OWN page cannot return there: the page is
  // gone, and the member would land on "Not found" with the outcome lost.
  const ownPage = `/modernhaus/thread/${encodeURIComponent(post.id)}`
  const ret = back.split('?')[0] === ownPage ? '/modernhaus' : back
  if (post.conversation) {
    return `/modernhaus/confirm/reply_delete${query({ replyId: post.conversation.commentId, return: ret })}`
  }
  if (post.type === 'note' && post.origin.protocol === 'nostr' && post.version) {
    return `/modernhaus/confirm/note_delete${query({ eventId: post.version, return: ret })}`
  }
  return null
}

function Votes(props: { post: Post; a: ItemActions; own: boolean }) {
  const { post, a, own } = props
  const id = post.version as string
  const t = a.votes.tally?.[id]
  const mine = a.votes.mine?.[id]
  const count = (n: number | undefined) => (n === undefined ? '' : ` ${n}`)
  const dir = (d: 'up' | 'down', label: string, n: number | undefined, used: boolean) =>
    own ? (
      `${label}${count(n)}`
    ) : used ? (
      `${label} — yours${count(n)}`
    ) : (
      <>
        <button name="direction" value={d}>
          {label}
        </button>
        {count(n)}
      </>
    )
  return (
    <>
      {dir('up', 'Up', t?.upvoteCount, (mine?.upCount ?? 0) > 0)}
      {' '}
      {dir('down', 'Down', t?.downvoteCount, (mine?.downCount ?? 0) > 0)}
    </>
  )
}

function ActionRow(props: { post: Post; a: ItemActions }) {
  const { post, a } = props
  if (post.isDeleted) return null
  const native = post.origin.protocol === 'nostr'
  const own = isOwn(post, a.viewer)
  const locked = post.rootLocked === true
  const canVote = native && !!post.version && !locked

  const active = !!post.externalItemId && tierCaps(post.biddabilityTier).interactBack
  const account = active ? (a.linked?.find((l) => l.protocol === post.origin.protocol && l.isValid) ?? null) : null
  const caps = interactionCaps(post.origin.protocol, !!account, active)

  const del = own ? deleteHref(post, a.back) : null
  const links = (
    <>
      <a href={`/modernhaus/thread/${encodeURIComponent(post.id)}`}>Conversation</a>
      {!locked && (
        <>
          {' · '}
          <a href={`/modernhaus/compose${query({ quote: post.id, return: a.back })}`}>Quote</a>
        </>
      )}
      {!own && (
        <>
          {' · '}
          <a href={reportHref(post, a.back)}>Report</a>
        </>
      )}
      {del && (
        <>
          {' · '}
          <a href={del}>Delete</a>
        </>
      )}
    </>
  )

  const buttons = canVote || caps.likeEnabled || caps.repostEnabled
  if (!buttons) return <p>{links}</p>
  return (
    <PostForm action="vote" csrf={a.csrf}>
      <Hidden
        values={{
          return: a.back,
          targetEventId: canVote ? post.version : null,
          targetKind: canVote ? (post.type === 'article' ? '30023' : '1') : null,
          itemId: account ? post.externalItemId : null,
          linkedAccountId: account?.id ?? null,
        }}
      />
      <p>
        {canVote && (
          <>
            <Votes post={post} a={a} own={own} />
            {' · '}
          </>
        )}
        {caps.likeEnabled && (
          <>
            <button formAction="/modernhaus/do/external_like">Like</button>
            {' · '}
          </>
        )}
        {caps.repostEnabled && (
          <>
            <button formAction="/modernhaus/do/external_repost">Repost</button>
            {' · '}
          </>
        )}
        {links}
      </p>
    </PostForm>
  )
}

export function PostItem(props: {
  post: Post
  actions?: ItemActions
  /** "→ NAME": whom this reply answers, where it is not the item above it. */
  replyingTo?: string | null
  /** The element id; a list item's is `p-<postId>`. */
  anchor?: string
}) {
  const { post } = props
  const title = post.body.title
  const href = articleHref(post)
  const source = post.origin.protocol !== 'nostr' ? post.origin.sourceName : null
  const showSource = !!source && source !== authorName(post)
  const sourceId = sourcePageId(post)
  const sourceHref = sourceId ? `/modernhaus/source/${encodeURIComponent(sourceId)}` : null
  const isNew = props.actions?.newIds?.has(post.id) === true
  const origin = post.origin.protocol !== 'nostr' ? safeHttpUrl(originWebUrl(post)) : undefined
  const warning = post.body.contentWarning

  const content = (
    <>
      <Body post={post} />
      <Media post={post} />
      <Quoted post={post} />
      <PollResults post={post} />
    </>
  )

  return (
    <article id={props.anchor ?? `p-${post.id}`}>
      <header>
        <p>
          <Byline post={post} />
          {props.replyingTo && ` → ${props.replyingTo}`}
          {' · '}
          <Time at={fromUnix(post.publishedAt)} />
          {showSource && (
            <>
              {' · via '}
              {sourceHref ? <a href={sourceHref}>{source}</a> : source}
            </>
          )}
          {isNew && ' · new'}
        </p>
      </header>
      {title && <h2>{href ? <a href={href}>{title}</a> : title}</h2>}
      {post.isMuted ? (
        <p>You muted this author.</p>
      ) : warning ? (
        <details>
          <summary>{`Content warning: ${warning}`}</summary>
          {content}
        </details>
      ) : (
        content
      )}
      {post.accessMode === 'gated' && post.pricePence !== undefined && (
        <p>{`${formatPrice(post.pricePence)} to read`}</p>
      )}
      {origin && (
        <p>
          <a href={origin} target="_blank" rel="noopener noreferrer">
            {`View on ${source ?? 'the original site'}`}
          </a>
        </p>
      )}
      {props.actions && <ActionRow post={post} a={props.actions} />}
    </article>
  )
}

export function PostList(props: { posts: Post[]; empty: string; actions?: ItemActions }) {
  if (props.posts.length === 0) return <p>{props.empty}</p>
  return (
    <ol>
      {props.posts.map((p) => (
        <li key={p.id}>
          <PostItem post={p} actions={props.actions} />
        </li>
      ))}
    </ol>
  )
}
