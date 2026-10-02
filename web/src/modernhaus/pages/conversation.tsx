import type { Post } from '../../lib/post/types'
import type { LinkedAccount } from '../../lib/api/linked-accounts'
import { replyTargetFromPost, type ReplyTarget } from '../../lib/post/reply-target'
import { replyAnchor } from '../../lib/post/reply-anchor'
import { tierCaps } from '../../lib/post/level-spec'
import { interactionCaps } from '../../lib/post/interaction-caps'
import { safeHttpUrl } from '../../lib/external-links'
import { PostForm, Hidden, NextLink, Unavailable, type Viewer } from '../html'
import { PostItem, authorName, type ItemActions, type VoteLookup } from '../post'

// =============================================================================
// modernhaus — a conversation (§D2.6, E3): the thread page, the article's
// foot, and the reply forms.
//
// A REPLY IS ADDRESSED TO THE CONVERSATION, NEVER THE REMARK: the native form's
// hidden fields are `replyTargetFromPost(focal)`'s output, computed here at
// render exactly as the full site's card computes it, and the gateway stays the
// guard. There is ONE reply form per page, under the focal. A locked
// conversation (`rootLocked`) is readable but not joinable, and says so once.
// An external focal replies back to its own network through the member's
// linked account, under the same gate the full site asks.
// =============================================================================

/** The sentence under a conversation the viewer may read but not join. */
export const LOCKED_CONVERSATION =
  'You can read this conversation, but only readers of the piece can reply to it.'
export const REPLIES_CLOSED = 'The writer has turned off replies for this piece.'

/** The hidden fields a native reply carries. */
export function replyFields(t: ReplyTarget): Record<string, string | undefined> {
  return {
    eventId: t.eventId,
    eventKind: String(t.eventKind),
    authorPubkey: t.authorPubkey,
    parentCommentId: t.parentCommentId,
    parentCommentEventId: t.parentCommentEventId,
  }
}

/**
 * The native reply form: a textarea over a target, and an optional picture.
 * `draft` and an already-uploaded `pictureUrl` survive a refusal.
 */
export function NativeReplyForm(props: {
  csrf: string
  target: ReplyTarget
  back: string
  draft?: string
  label?: string
  pictureUrl?: string | null
}) {
  const picture = props.pictureUrl ? safeHttpUrl(props.pictureUrl) : undefined
  return (
    <PostForm action="reply" csrf={props.csrf} multipart>
      <Hidden values={{ return: props.back, pictureUrl: picture, ...replyFields(props.target) }} />
      <p>
        <label>
          {props.label ?? (props.target.authorName ? `Reply to ${props.target.authorName}` : 'Reply')}
          <br />
          <textarea name="content" rows={5} cols={60} defaultValue={props.draft} />
        </label>
      </p>
      {picture ? (
        <p>
          {'Your picture is kept: '}
          <a href={picture}>{picture}</a>
        </p>
      ) : (
        <p>
          <label>
            {'A picture (optional) '}
            <input type="file" name="picture" accept="image/jpeg,image/png,image/gif,image/webp" />
          </label>
        </p>
      )}
      <p>
        <button>Post reply</button>
      </p>
    </PostForm>
  )
}

/** The account an external post replies back through, or null. */
export function externalReplyAccount(post: Post, linked: LinkedAccount[] | null): LinkedAccount | null {
  const active = !!post.externalItemId && tierCaps(post.biddabilityTier).interactBack
  const account = active ? (linked?.find((l) => l.protocol === post.origin.protocol && l.isValid) ?? null) : null
  return interactionCaps(post.origin.protocol, !!account, active).replyEnabled ? account : null
}

/** Where an external reply goes: the item, and the account it is sent through. */
export interface ExternalReplyTarget {
  itemId: string
  linkedAccountId: string
  /** "Reply to Ada, on Bluesky" — absent when re-rendered from the form alone. */
  label?: string
}

export function externalReplyTarget(post: Post, account: LinkedAccount): ExternalReplyTarget {
  const where = post.origin.sourceName ?? account.externalHandle ?? 'the original network'
  return {
    itemId: post.externalItemId as string,
    linkedAccountId: account.id,
    label: `Reply to ${authorName(post)}, on ${where}`,
  }
}

export function ExternalReplyForm(props: { csrf: string; target: ExternalReplyTarget; back: string; draft?: string }) {
  return (
    <PostForm action="external_reply" csrf={props.csrf}>
      <Hidden values={{ return: props.back, itemId: props.target.itemId, linkedAccountId: props.target.linkedAccountId }} />
      <p>
        <label>
          {props.target.label ?? 'Reply'}
          <br />
          <textarea name="content" rows={5} cols={60} required defaultValue={props.draft} />
        </label>
      </p>
      <p>
        <button>Post reply</button>
      </p>
    </PostForm>
  )
}

/** An open external poll, voted through the linked account. */
function PollForm(props: { csrf: string; post: Post; account: LinkedAccount; back: string }) {
  const poll = props.post.body.poll
  if (!poll || poll.closed) return null
  return (
    <PostForm action="external_poll_vote" csrf={props.csrf}>
      <Hidden values={{ return: props.back, itemId: props.post.externalItemId, linkedAccountId: props.account.id }} />
      <fieldset>
        <legend>Vote in this poll</legend>
        {poll.options.map((o, i) => (
          <p key={i}>
            <label>
              <input type={poll.multiple ? 'checkbox' : 'radio'} name="choice" value={String(i)} required={!poll.multiple} />
              {` ${o.title}`}
            </label>
          </p>
        ))}
        <p>
          <button>Vote</button>
        </p>
      </fieldset>
    </PostForm>
  )
}

/** Whom each reply answers, where it is not the item above it (the full site's rule). */
function replyingTo(p: Post, above: Post, pool: Map<string, Post>): string | null {
  if (!p.inReplyTo || p.inReplyTo === above.id) return null
  const parent = pool.get(p.inReplyTo)
  return parent?.author.displayName || parent?.author.handle || null
}

export interface ThreadPageProps {
  ancestors: Post[]
  focal: Post
  replies: Post[]
  totalDescendants: number
  hydrating: boolean
  next: string | null
  self: string
  viewer: Viewer | null
  csrf: string
  votes: VoteLookup
  linked: LinkedAccount[] | null
}

export function ThreadPage(props: ThreadPageProps) {
  const { focal, viewer } = props
  const actions: ItemActions | undefined = viewer
    ? { viewer, csrf: props.csrf, back: props.self, votes: props.votes, linked: props.linked }
    : undefined
  const pool = new Map([...props.ancestors, focal, ...props.replies].map((p) => [p.id, p]))

  const native = focal.origin.protocol === 'nostr'
  const locked = focal.rootLocked === true
  const target = native && !focal.isDeleted ? replyTargetFromPost(focal) : null
  const account = !native && viewer ? externalReplyAccount(focal, props.linked) : null

  let replyBox: JSX.Element | null = null
  if (!viewer) {
    replyBox = (
      <p>
        <a href={`/modernhaus/signin?return=${encodeURIComponent(props.self)}`}>Sign in</a> to reply.
      </p>
    )
  } else if (locked) {
    replyBox = <p>{LOCKED_CONVERSATION}</p>
  } else if (target) {
    replyBox = <NativeReplyForm csrf={props.csrf} target={target} back={props.self} />
  } else if (account) {
    replyBox = <ExternalReplyForm csrf={props.csrf} target={externalReplyTarget(focal, account)} back={props.self} />
  } else if (!native && props.linked === null) {
    replyBox = <Unavailable what="Your linked accounts" />
  }

  return (
    <>
      {props.ancestors.length > 0 && (
        <>
          <h2>Earlier</h2>
          <ol>
            {props.ancestors.map((p) => (
              <li key={p.id}>
                <PostItem post={p} actions={actions} />
              </li>
            ))}
          </ol>
          <h2>This post</h2>
        </>
      )}
      <PostItem post={focal} actions={actions} anchor="focal" />
      {viewer && account && <PollForm csrf={props.csrf} post={focal} account={account} back={props.self} />}
      {replyBox}
      <h2>{`Replies (${props.totalDescendants})`}</h2>
      {props.hydrating && (
        <p>
          {'Replies are still being fetched from the original network. '}
          <a href={props.self}>Check again</a>
        </p>
      )}
      {props.replies.length === 0 ? (
        <p>No replies yet.</p>
      ) : (
        <ol>
          {props.replies.map((p, i) => (
            <li key={p.id}>
              <PostItem post={p} actions={actions} replyingTo={replyingTo(p, i === 0 ? focal : props.replies[i - 1], pool)} />
            </li>
          ))}
        </ol>
      )}
      <NextLink href={props.next} label="More replies" />
    </>
  )
}

export interface ArticleFootProps {
  /** The article's own reply target — its event, kind and writer. */
  target: ReplyTarget | null
  self: string
  viewer: Viewer | null
  csrf: string
  repliesEnabled: boolean
  posts: Map<string, Post>
  topLevel: Array<{ id: string; count: number; previewIds: string[] }>
  totalReplies: number
  next: string | null
  votes: VoteLookup
}

/** A comment's element id: the house address `#reply-<id>`, parsed in one home. */
function commentAnchor(p: Post): string | undefined {
  return p.conversation ? replyAnchor(p.conversation.commentId).slice(1) : undefined
}

/**
 * The article's foot at rest: the direct replies, ranked by how much hangs off
 * each, each with its first two replies below it and a link into the rest
 * (the full site's foot, as a list).
 */
export function ArticleFoot(props: ArticleFootProps) {
  const { viewer } = props
  const actions: ItemActions | undefined = viewer
    ? { viewer, csrf: props.csrf, back: props.self, votes: props.votes, linked: [] }
    : undefined
  const total = props.totalReplies
  return (
    <>
      <h2>{total > 0 ? `${total} ${total !== 1 ? 'replies' : 'reply'}` : 'Replies'}</h2>
      {props.topLevel.length > 0 && (
        <ol>
          {props.topLevel.map((entry) => {
            const head = props.posts.get(entry.id)
            if (!head) return null
            const previews = entry.previewIds.map((id) => props.posts.get(id)).filter((p): p is Post => !!p)
            const rest = entry.count - previews.length
            return (
              <li key={entry.id}>
                <PostItem post={head} actions={actions} anchor={commentAnchor(head)} />
                {previews.length > 0 && (
                  <ol>
                    {previews.map((p) => (
                      <li key={p.id}>
                        <PostItem post={p} actions={actions} anchor={commentAnchor(p)} />
                      </li>
                    ))}
                  </ol>
                )}
                {rest > 0 && (
                  <p>
                    <a href={`/modernhaus/thread/${encodeURIComponent(head.id)}`}>
                      {`Show ${rest} more repl${rest === 1 ? 'y' : 'ies'}`}
                    </a>
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <NextLink href={props.next} label="Show more replies" />
      {!props.repliesEnabled ? (
        <p>{REPLIES_CLOSED}</p>
      ) : !viewer ? (
        <p>
          <a href={`/modernhaus/signin?return=${encodeURIComponent(props.self)}`}>Sign in</a> to leave a reply.
        </p>
      ) : props.target ? (
        <NativeReplyForm csrf={props.csrf} target={props.target} back={props.self} label="Reply to the piece" />
      ) : null}
    </>
  )
}

/**
 * A reply the route refused, re-rendered with what was typed (§D1.3, §D2.5.3):
 * the reason, the same form, and the way back.
 */
export function ReplyAgainPage(props: {
  csrf: string
  back: string
  draft: string
  native: ReplyTarget | null
  external: ExternalReplyTarget | null
  pictureUrl?: string | null
}) {
  return (
    <>
      {props.native && (
        <NativeReplyForm csrf={props.csrf} target={props.native} back={props.back} draft={props.draft} pictureUrl={props.pictureUrl} />
      )}
      {props.external && (
        <ExternalReplyForm csrf={props.csrf} target={props.external} back={props.back} draft={props.draft} />
      )}
      <p>
        <a href={props.back}>Back to the conversation</a>
      </p>
    </>
  )
}
