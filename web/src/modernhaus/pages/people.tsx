import type { ReactNode } from 'react'
import type { WriterProfile } from '../../lib/api/writers'
import type { AuthorProfile } from '../../lib/api/post'
import type { Post } from '../../lib/post/types'
import { safeHttpUrl } from '../../lib/external-links'
import { Time, NextLink, TextParagraphs } from '../html'
import { PostList } from '../post'

// =============================================================================
// modernhaus — a member's profile and an external author (§D2.3), read half (E1).
//
// The profile's view row gates on CONTENT, never on who is looking
// (web-profile.md): a view with nothing in it is not offered. Follow (E3) is a
// link to the picker; subscribe, block and mute arrive with E5 and E6.
// =============================================================================

export const PROFILE_VIEWS = ['articles', 'notes', 'replies', 'followers', 'following'] as const
export type ProfileView = (typeof PROFILE_VIEWS)[number]

export interface ProfileArticle {
  dTag: string
  title: string
  summary: string | null
  isPaywalled: boolean
  publishedAt: string | null
}
export interface ProfileNote {
  id: string
  content: string
  publishedAt: string
  quotedExcerpt?: string
  quotedTitle?: string
  quotedAuthor?: string
}
export interface ProfileReply {
  id: string
  content: string
  publishedAt: string
  isDeleted: boolean
  articleTitle: string | null
  parentAuthorDisplayName: string | null
  parentAuthorUsername: string | null
}
export interface ProfilePerson {
  id: string
  username: string
  displayName: string | null
}

export type ProfileList =
  | { view: 'articles'; items: ProfileArticle[] }
  | { view: 'notes'; items: ProfileNote[] }
  | { view: 'replies'; items: ProfileReply[] }
  | { view: 'followers' | 'following'; items: ProfilePerson[]; total: number }

export interface ProfileProps {
  writer: WriterProfile
  list: ProfileList
  /** The next page's href, or null when this is the last. */
  next: string | null
  /** The follow picker, for a member looking at somebody else (E3). */
  followHref?: string | null
  reportHref?: string | null
  /** The subscribe row (E5), for a member looking at a writer who sells something. */
  subscribe?: ReactNode
  /** Message, mute and block (E6), for a member looking at somebody else. */
  social?: ReactNode
}

function viewCount(w: WriterProfile, v: ProfileView): number | undefined {
  switch (v) {
    case 'articles':
      return w.articleCount
    case 'notes':
      return w.noteCount
    case 'replies':
      return w.replyCount
    case 'followers':
      return w.followerCount
    case 'following':
      return w.followingCount
  }
}

const VIEW_LABEL: Record<ProfileView, string> = {
  articles: 'Articles',
  notes: 'Notes',
  replies: 'Replies',
  followers: 'Followers',
  following: 'Following',
}

function ViewRow(props: { writer: WriterProfile; current: ProfileView }) {
  const base = `/modernhaus/u/${encodeURIComponent(props.writer.username)}`
  return (
    <ul>
      {PROFILE_VIEWS.map((v) => {
        const n = viewCount(props.writer, v)
        // Absent is "unknown, so offer it"; zero is "nothing there".
        if (n === 0 && v !== props.current) return null
        const label = n === undefined ? VIEW_LABEL[v] : `${VIEW_LABEL[v]} (${n})`
        return (
          <li key={v}>{v === props.current ? `${label} (showing)` : <a href={`${base}?view=${v}`}>{label}</a>}</li>
        )
      })}
    </ul>
  )
}

function Person(props: { p: ProfilePerson }) {
  const name = props.p.displayName ?? props.p.username
  return (
    <li>
      <a href={`/modernhaus/u/${encodeURIComponent(props.p.username)}`}>{name}</a>
      {props.p.displayName && ` (@${props.p.username})`}
    </li>
  )
}

function ListBody(props: { list: ProfileList }) {
  const { list } = props
  if (list.items.length === 0) return <p>Nothing here yet.</p>
  switch (list.view) {
    case 'articles':
      return (
        <ol>
          {list.items.map((a) => (
            <li key={a.dTag}>
              <article>
                <h3>
                  <a href={`/modernhaus/article/${encodeURIComponent(a.dTag)}`}>{a.title}</a>
                </h3>
                {a.summary && <p>{a.summary}</p>}
                <p>
                  {a.publishedAt && <Time at={new Date(a.publishedAt)} dateOnly />}
                  {a.isPaywalled && ' · Paid'}
                </p>
              </article>
            </li>
          ))}
        </ol>
      )
    case 'notes':
      return (
        <ol>
          {list.items.map((n) => (
            <li key={n.id}>
              <article>
                <header>
                  <p>
                    <Time at={new Date(n.publishedAt)} />
                  </p>
                </header>
                <TextParagraphs text={n.content} linkify />
                {(n.quotedTitle || n.quotedExcerpt) && (
                  <blockquote>
                    <p>
                      {n.quotedAuthor ? `${n.quotedAuthor}: ` : ''}
                      {[n.quotedTitle, n.quotedExcerpt].filter(Boolean).join(': ')}
                    </p>
                  </blockquote>
                )}
              </article>
            </li>
          ))}
        </ol>
      )
    case 'replies':
      return (
        <ol>
          {list.items.map((r) => (
            <li key={r.id}>
              <article>
                <header>
                  <p>
                    <Time at={new Date(r.publishedAt)} />
                    {r.articleTitle && ` · on “${r.articleTitle}”`}
                    {r.parentAuthorDisplayName && ` · → ${r.parentAuthorDisplayName}`}
                  </p>
                </header>
                {r.isDeleted ? <p>This reply was deleted.</p> : <TextParagraphs text={r.content} linkify />}
              </article>
            </li>
          ))}
        </ol>
      )
    default:
      return (
        <ul>
          {list.items.map((p) => (
            <Person key={p.id} p={p} />
          ))}
        </ul>
      )
  }
}

export function ProfilePage(props: ProfileProps) {
  const { writer } = props
  return (
    <>
      <p>{`@${writer.username}`}</p>
      {writer.bio && <TextParagraphs text={writer.bio} />}
      {writer.presences && writer.presences.length > 0 && (
        <>
          <h2>Also on</h2>
          <ul>
            {writer.presences.map((p, i) => {
              const href = safeHttpUrl(p.externalUrl)
              const label = p.handle ? `${p.protocol}: ${p.handle}` : p.protocol
              return (
                <li key={i}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
      {(props.followHref || props.reportHref) && (
        <p>
          {props.followHref && <a href={props.followHref}>Follow…</a>}
          {props.followHref && props.reportHref && ' · '}
          {props.reportHref && <a href={props.reportHref}>Report</a>}
        </p>
      )}
      {props.social}
      {props.subscribe}
      <p>
        <a href={`/rss/${encodeURIComponent(writer.username)}`}>RSS feed</a>
      </p>
      <h2>{VIEW_LABEL[props.list.view]}</h2>
      <ViewRow writer={writer} current={props.list.view} />
      <ListBody list={props.list} />
      <NextLink href={props.next} />
    </>
  )
}

export interface AuthorProps {
  authorId: string
  profile: AuthorProfile
  posts: Post[]
  next: string | null
  hydrating: boolean
  followHref?: string | null
}

export function AuthorPage(props: AuthorProps) {
  const { profile } = props
  const external = safeHttpUrl(profile.externalUrl)
  const website = safeHttpUrl(profile.website)
  const self = `/modernhaus/author/${encodeURIComponent(props.authorId)}`
  return (
    <>
      {profile.handle && <p>{profile.handle}</p>}
      {profile.bio && <TextParagraphs text={profile.bio} />}
      <ul>
        {external && (
          <li>
            <a href={external} target="_blank" rel="noopener noreferrer">
              {`Profile on ${profile.sourceName ?? 'the original site'}`}
            </a>
          </li>
        )}
        {website && (
          <li>
            <a href={website} target="_blank" rel="noopener noreferrer">
              {website}
            </a>
          </li>
        )}
      </ul>
      {props.followHref && (
        <p>
          <a href={props.followHref}>Follow…</a>
        </p>
      )}
      <h2>Posts</h2>
      {props.hydrating && (
        <p>
          {'Earlier posts are still being fetched from the source. '}
          <a href={self}>Check again</a>
        </p>
      )}
      <PostList posts={props.posts} empty="No posts yet." />
      <NextLink href={props.next} />
    </>
  )
}
