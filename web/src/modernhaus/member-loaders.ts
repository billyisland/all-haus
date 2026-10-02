import type { Post } from '../lib/post/types'
import type { WorkspaceFeed, FeedSeenWindow, WorkspaceFeedSource, SourceMeta } from '../lib/api/feeds'
import type { LinkedAccount } from '../lib/api/linked-accounts'
import type { Notification } from '../lib/api/notifications'
import type { AuthorProfile } from '../lib/api/post'
import type { WriterProfile } from '../lib/api/writers'
import { isFeedFollowable, matchFeedSource, type FeedFollowTarget } from '../lib/follow/feed-follow'
import { call, must, okBody, path, query, GatewayFault, type GatewayContext } from './gateway'
import type { Viewer } from './html'
import type { VoteLookup } from './post'

// =============================================================================
// modernhaus — the reading step's gateway reads (MODERNHAUS-ADR §D2.3, E3).
//
// Same contract as `loaders.ts`: null is the route's own "no such thing", a
// THROW is a fault (the pipeline's 500), and a secondary read (§D2.3's `+`)
// never throws — its section says it is unavailable, never that it is empty.
// =============================================================================

/** A 404 or a 400 on a path id is "not here" (security.md: a path id answers 404). */
function absent(status: number): boolean {
  return status === 404 || status === 400
}

/**
 * A secondary read: the body on a 200, else null — logged, never thrown. The
 * method is spelled at every call site so the contract pin reads the path
 * (`structure.test.ts` matches `(gw, 'GET', path…)`).
 */
export async function secondary<T>(gw: GatewayContext, method: 'GET', apiPath: string, what: string): Promise<T | null> {
  try {
    const a = await call<T>(gw, method, apiPath)
    if (a.status === 200 && a.body !== null) return a.body
    console.warn('[modernhaus] secondary read refused', what, a.status)
    return null
  } catch (err) {
    console.warn('[modernhaus] secondary read failed', what, err instanceof GatewayFault ? err.message : err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Shared by every list with an action row.
// ---------------------------------------------------------------------------

/** The route's own cap on one tally read (`votes.ts`). */
const VOTE_IDS_MAX = 200

/** The all.haus votes on a page's native posts. Both halves are secondary. */
export async function loadVotes(gw: GatewayContext, posts: Post[]): Promise<VoteLookup> {
  const ids = [
    ...new Set(posts.filter((p) => p.origin.protocol === 'nostr' && p.version).map((p) => p.version as string)),
  ].slice(0, VOTE_IDS_MAX)
  if (ids.length === 0) return { tally: {}, mine: {} }
  const qs = query({ eventIds: ids.join(',') })
  const [tally, mine] = await Promise.all([
    secondary<{ tallies: VoteLookup['tally'] }>(gw, 'GET', '/votes/tally' + qs, 'votes tally'),
    secondary<{ voteCounts: VoteLookup['mine'] }>(gw, 'GET', '/votes/mine' + qs, 'votes mine'),
  ])
  return { tally: tally?.tallies ?? null, mine: mine?.voteCounts ?? null }
}

/** The viewer's linked accounts, or null when they could not be read. */
export async function loadLinked(gw: GatewayContext, posts: Post[]): Promise<LinkedAccount[] | null> {
  // Only a page carrying an external post can use them.
  if (!posts.some((p) => p.externalItemId)) return []
  const b = await secondary<{ accounts: LinkedAccount[] }>(gw, 'GET', '/linked-accounts', 'linked accounts')
  return b && Array.isArray(b.accounts) ? b.accounts : null
}

// ---------------------------------------------------------------------------
// The feed index and a feed.
// ---------------------------------------------------------------------------

export interface FeedRow {
  feed: WorkspaceFeed
  /** How many posts in the feed's week are new, or null when that could not be read. */
  newCount: number | null
}

export async function loadFeedIndex(gw: GatewayContext): Promise<FeedRow[]> {
  const { feeds } = okBody(await call<{ feeds: WorkspaceFeed[] }>(gw, 'GET', '/workspace/feeds'), 'feeds')
  const sorted = [...feeds].sort((a, b) => a.sortRank - b.sortRank)
  return Promise.all(
    sorted.map(async (feed) => {
      const w = await secondary<FeedSeenWindow>(gw, 'GET', path`/workspace/feeds/${feed.id}/seen`, 'feed seen')
      return { feed, newCount: w && Array.isArray(w.items) ? w.items.filter((i) => i.isNew).length : null }
    }),
  )
}

const FEED_PAGE = 30

export interface FeedData {
  feed: WorkspaceFeed
  items: Post[]
  nextCursor: string | null
  asOf: string
  /** Post ids the seen window marks new; null when the window could not be read. */
  newIds: Set<string> | null
  votes: VoteLookup
  linked: LinkedAccount[] | null
}

export async function loadFeed(gw: GatewayContext, feedId: string, cursor: string | null): Promise<FeedData | null> {
  const [page, seen] = await Promise.all([
    call<{ feed: WorkspaceFeed; items: Post[]; nextCursor?: string; asOf: string }>(
      gw,
      'GET',
      path`/workspace/feeds/${feedId}/items` + query({ cursor, limit: FEED_PAGE }),
    ),
    secondary<FeedSeenWindow>(gw, 'GET', path`/workspace/feeds/${feedId}/seen`, 'feed seen'),
  ])
  must(page, 'feed items')
  if (absent(page.status)) return null
  const body = okBody(page, 'feed items')
  const [votes, linked] = await Promise.all([loadVotes(gw, body.items), loadLinked(gw, body.items)])
  return {
    feed: body.feed,
    items: body.items,
    nextCursor: body.nextCursor ?? null,
    asOf: body.asOf,
    newIds: seen && Array.isArray(seen.items) ? new Set(seen.items.filter((i) => i.isNew).map((i) => i.id)) : null,
    votes,
    linked,
  }
}

// ---------------------------------------------------------------------------
// A conversation.
// ---------------------------------------------------------------------------

/** One page of replies; the route's ceiling is 50 (`post-thread.ts`). */
const THREAD_REPLY_PAGE = 30

export interface ThreadData {
  ancestors: Post[]
  focal: Post
  replies: Post[]
  replyCursor: string | null
  totalDescendants: number
  /** An external thread still being fetched from its network. */
  hydrating: boolean
  votes: VoteLookup
  linked: LinkedAccount[] | null
}

export async function loadThread(
  gw: GatewayContext,
  viewer: Viewer | null,
  postId: string,
  replyCursor: string | null,
): Promise<ThreadData | null> {
  const t = must(
    await call<{
      focalId: string
      posts: Post[]
      replyCursor?: string
      totalDescendants: number
      hydrating?: boolean
    }>(gw, 'GET', path`/thread/${postId}` + query({ replyCursor, replyLimit: THREAD_REPLY_PAGE })),
    'thread',
  )
  if (absent(t.status)) return null
  const body = okBody(t, 'thread')
  const at = body.posts.findIndex((p) => p.id === body.focalId)
  if (at < 0) throw new GatewayFault('thread carried no focal')
  const [votes, linked] = viewer
    ? await Promise.all([loadVotes(gw, body.posts), loadLinked(gw, body.posts)])
    : [{ tally: null, mine: null }, null]
  return {
    ancestors: body.posts.slice(0, at),
    focal: body.posts[at],
    replies: body.posts.slice(at + 1),
    replyCursor: body.replyCursor ?? null,
    totalDescendants: body.totalDescendants,
    hydrating: body.hydrating === true,
    votes,
    linked,
  }
}

const TOP_PAGE = 10

export type ArticleConversation =
  /** A locked piece shows NOTHING below its gate (ARTICLE-HEADED-CONVERSATIONS-ADR §6a). */
  | { kind: 'locked' }
  | { kind: 'unavailable' }
  | {
      kind: 'open'
      repliesEnabled: boolean
      posts: Map<string, Post>
      topLevel: Array<{ id: string; count: number; previewIds: string[] }>
      totalReplies: number
      nextOffset: number | null
      votes: VoteLookup
    }

/**
 * The article's foot (§D2.6): GET /replies for the two facts /thread does not
 * carry — whether the author closed replies, and `paywallLocked`, which stays
 * the server's word — then the ranked direct replies from /thread/:postId/top.
 * Both are secondary to the article: a failure is "unavailable", never "no
 * replies".
 */
export async function loadArticleConversation(
  gw: GatewayContext,
  viewer: Viewer | null,
  eventId: string,
  postId: string,
  offset: number,
  focusComment: string | null = null,
): Promise<ArticleConversation> {
  const [gate, top] = await Promise.all([
    secondary<{ repliesEnabled?: boolean; commentsEnabled?: boolean; paywallLocked?: boolean }>(
      gw,
      'GET',
      path`/replies/${eventId}`,
      'reply gate',
    ),
    secondary<{
      posts: Post[]
      topLevel: Array<{ id: string; count: number; previewIds: string[] }>
      totalReplies: number
      nextOffset?: number
    }>(
      gw,
      'GET',
      path`/thread/${postId}/top` + query({ limit: TOP_PAGE, offset: offset || null, focusComment }),
      'article conversation',
    ),
  ])
  if (gate?.paywallLocked) return { kind: 'locked' }
  if (!gate || !top || !Array.isArray(top.posts) || !Array.isArray(top.topLevel)) return { kind: 'unavailable' }
  const votes = viewer ? await loadVotes(gw, top.posts) : { tally: null, mine: null }
  return {
    kind: 'open',
    repliesEnabled: gate.repliesEnabled ?? gate.commentsEnabled ?? true,
    posts: new Map(top.posts.map((p) => [p.id, p])),
    topLevel: top.topLevel,
    totalReplies: top.totalReplies,
    nextOffset: top.nextOffset ?? null,
    votes,
  }
}

// ---------------------------------------------------------------------------
// Following.
// ---------------------------------------------------------------------------

/** Who a follow is about, as the three pages that link to it name them. */
export type FollowSubject =
  | { kind: 'writer'; username: string }
  | { kind: 'author'; id: string }
  | { kind: 'source'; id: string }

export function followSubject(params: URLSearchParams | Record<string, unknown>): FollowSubject | null {
  const get = (k: string): string | null => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  }
  const writer = get('writer')
  if (writer) return { kind: 'writer', username: writer }
  const author = get('author')
  if (author) return { kind: 'author', id: author }
  const source = get('source')
  if (source) return { kind: 'source', id: source }
  return null
}

export function followQuery(s: FollowSubject): Record<string, string> {
  return s.kind === 'writer' ? { writer: s.username } : { [s.kind]: s.id }
}

export interface FollowResolved {
  target: FeedFollowTarget
  /** Who, in words, for the page's heading. */
  name: string
  /** Where their page is, in this register. */
  home: string
}

/**
 * The follow target, re-read from the gateway — never taken from the form. It
 * is the same `followTarget` the full site's hover card and profile hold, so
 * the add payload `feedFollowAddInput` builds from it is the browser's own.
 * Null: nobody by that name, or nobody THIS viewer can follow (the gateway
 * omits `followTarget` for themselves).
 */
export async function resolveFollow(
  gw: GatewayContext,
  viewer: Viewer,
  s: FollowSubject,
): Promise<FollowResolved | null> {
  if (s.kind === 'writer') {
    const w = must(await call<WriterProfile>(gw, 'GET', path`/writers/${s.username}`), 'writer')
    if (absent(w.status)) return null
    const writer = okBody(w, 'writer')
    if (writer.id === viewer.id) return null
    return {
      target: { type: 'user', id: writer.id, isFollowing: false },
      name: writer.displayName ?? writer.username,
      home: `/modernhaus/u/${encodeURIComponent(writer.username)}`,
    }
  }
  if (s.kind === 'author') {
    const p = must(await call<AuthorProfile>(gw, 'GET', path`/author/${s.id}/profile`), 'author profile')
    if (absent(p.status)) return null
    const profile = okBody(p, 'author profile')
    if (!profile.followTarget || !isFeedFollowable(profile.followTarget)) return null
    return {
      target: profile.followTarget,
      name: profile.displayName ?? profile.handle ?? 'This author',
      home: `/modernhaus/author/${encodeURIComponent(s.id)}`,
    }
  }
  const r = must(await call<{ source: SourceMeta }>(gw, 'GET', path`/sources/${s.id}`), 'source')
  if (absent(r.status)) return null
  const source = okBody(r, 'source').source
  if (!source.followTarget || !isFeedFollowable(source.followTarget)) return null
  return {
    target: source.followTarget,
    name: source.displayName ?? source.sourceUri,
    home: `/modernhaus/source/${encodeURIComponent(s.id)}`,
  }
}

export interface FeedMembership {
  feed: WorkspaceFeed
  /** The `feed_sources` row holding the target, null when it holds none, or
   *  `'unknown'` when that feed's sources could not be read. */
  row: string | null | 'unknown'
}

/**
 * Every feed, hidden ones included (a hidden feed still carries a follow —
 * `useFeedFollow`'s header), with whether each already holds the target. The
 * feed list is primary; one feed's sources failing is that feed's `unknown`.
 */
export async function loadMembership(gw: GatewayContext, target: FeedFollowTarget): Promise<FeedMembership[]> {
  const { feeds } = okBody(await call<{ feeds: WorkspaceFeed[] }>(gw, 'GET', '/workspace/feeds'), 'feeds')
  const sorted = [...feeds].sort((a, b) => a.sortRank - b.sortRank)
  return Promise.all(
    sorted.map(async (feed): Promise<FeedMembership> => {
      const b = await secondary<{ sources: WorkspaceFeedSource[] }>(
        gw,
        'GET',
        path`/workspace/feeds/${feed.id}/sources`,
        'feed sources',
      )
      if (!b || !Array.isArray(b.sources)) return { feed, row: 'unknown' }
      return { feed, row: matchFeedSource(b.sources, target) }
    }),
  )
}

// ---------------------------------------------------------------------------
// Notifications and a source.
// ---------------------------------------------------------------------------

export async function loadNotifications(
  gw: GatewayContext,
  cursor: string | null,
): Promise<{ notifications: Notification[]; nextCursor: string | null } | 'bad_cursor'> {
  const a = must(
    await call<{ notifications: Notification[]; nextCursor: string | null }>(
      gw,
      'GET',
      '/notifications' + query({ cursor }),
    ),
    'notifications',
  )
  if (a.status === 400) return 'bad_cursor'
  const body = okBody(a, 'notifications')
  return { notifications: body.notifications, nextCursor: body.nextCursor ?? null }
}

export async function loadSource(
  gw: GatewayContext,
  viewer: Viewer | null,
  sourceId: string,
  cursor: string | null,
): Promise<{ source: SourceMeta; items: Post[]; nextCursor: string | null; votes: VoteLookup; linked: LinkedAccount[] | null } | null> {
  const r = must(
    await call<{ source: SourceMeta; items: Post[]; nextCursor?: string }>(
      gw,
      'GET',
      path`/sources/${sourceId}` + query({ cursor }),
    ),
    'source',
  )
  if (absent(r.status)) return null
  const body = okBody(r, 'source')
  const [votes, linked] = viewer
    ? await Promise.all([loadVotes(gw, body.items), loadLinked(gw, body.items)])
    : [{ tally: null, mine: null }, null]
  return { source: body.source, items: body.items, nextCursor: body.nextCursor ?? null, votes, linked }
}
