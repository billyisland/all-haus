import type { ArticleMetadata } from '../lib/api/articles'
import type { WriterProfile } from '../lib/api/writers'
import type { AuthorProfile } from '../lib/api/post'
import type { FeedLink } from '../lib/api/formulas'
import type { Post } from '../lib/post/types'
import { renderMarkdown } from '../lib/markdown'
import { externalizeHtml, safeHttpUrl } from '../lib/external-links'
import { originWebUrl } from '../lib/post/origin-url'
import { call, must, okBody, path, query, GatewayFault, type GatewayContext } from './gateway'
import { stripOrnament } from './html-pass'
import { sentenceForStatus } from './outcomes'
import type { Viewer } from './html'
import type { Extracted } from './pages/reading'
import {
  PROFILE_VIEWS,
  type ProfileArticle,
  type ProfileList,
  type ProfileNote,
  type ProfilePerson,
  type ProfileReply,
  type ProfileView,
} from './pages/people'
import { SEARCH_TYPES, type ArticleHit, type SearchResults, type SearchType, type TagHits, type WriterHit } from './pages/finding'

// =============================================================================
// modernhaus — each page's gateway reads (MODERNHAUS-ADR §D1.2).
//
// A loader returns props, or null for "no such thing" (the route's own 404),
// and THROWS for a fault — the page pipeline turns that into the 500. A
// secondary read (marked in §D2.3 with +) never throws: its section renders as
// unavailable, never as empty.
//
// Every path is built with `path`, which encodes each interpolation.
// =============================================================================

const PAGE = 20

/** A 404 or a 400 on a path id is "not here" (security.md: a path id answers 404). */
function absent(status: number): boolean {
  return status === 404 || status === 400
}

/**
 * The reading-log record, as the full site's reader MOUNT makes it (posts.md:
 * the log has one writer, the open). Fire-and-forget in contract: a failed
 * write loses a row and never costs the reader the piece, so every failure is
 * swallowed here — the one place in modernhaus a failure is, deliberately.
 */
async function logOpen(gw: GatewayContext, viewer: Viewer | null, postId: string): Promise<void> {
  if (!viewer) return
  try {
    await call(gw, 'POST', '/reading-log', { json: { postId } })
  } catch {
    // Deliberate: see above.
  }
}

// ---------------------------------------------------------------------------

export async function loadArticle(
  gw: GatewayContext,
  viewer: Viewer | null,
  dTag: string,
): Promise<{ article: ArticleMetadata; freeHtml: string } | null> {
  const a = must(await call<ArticleMetadata>(gw, 'GET', path`/articles/${dTag}`), 'article')
  if (absent(a.status)) return null
  const article = okBody(a, 'article')
  const [freeHtml] = await Promise.all([
    article.contentFree ? renderMarkdown(article.contentFree).then(stripOrnament) : Promise.resolve(''),
    logOpen(gw, viewer, article.postId),
  ])
  return { article, freeHtml }
}

interface ThreadBody {
  focalId: string
  posts: Post[]
}

export async function loadRead(
  gw: GatewayContext,
  viewer: Viewer | null,
  postId: string,
): Promise<{ post: Post; sourceUrl: string | null; extracted: Extracted } | null> {
  const t = must(await call<ThreadBody>(gw, 'GET', path`/thread/${postId}`), 'thread')
  if (absent(t.status)) return null
  const thread = okBody(t, 'thread')
  const post = Array.isArray(thread.posts) ? thread.posts.find((p) => p.id === thread.focalId) : undefined
  // External articles only, as on the full site: a native article lives at
  // /article/<dTag>, and a note is not something you read on its own page.
  if (!post || post.type !== 'article' || post.origin.protocol === 'nostr') return null

  const sourceUrl = safeHttpUrl(originWebUrl(post)) ?? null
  let extracted: Extracted = { kind: 'members_only' }
  if (viewer && sourceUrl) {
    extracted = { kind: 'unavailable' }
    try {
      const x = await call<{ content?: string }>(gw, 'GET', '/extract' + query({ url: sourceUrl }))
      if (x.status === 200 && x.body && typeof x.body.content === 'string' && x.body.content) {
        extracted = { kind: 'text', html: stripOrnament(externalizeHtml(x.body.content)) }
      }
    } catch (err) {
      console.warn('[modernhaus] extract unavailable', err instanceof GatewayFault ? err.message : err)
    }
  }
  if (viewer) await logOpen(gw, viewer, post.id)
  return { post, sourceUrl, extracted }
}

// ---------------------------------------------------------------------------

export function parseView(v: string | null): ProfileView {
  return (PROFILE_VIEWS as readonly string[]).includes(v ?? '') ? (v as ProfileView) : 'articles'
}

export function parseOffset(v: string | null): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export async function loadProfile(
  gw: GatewayContext,
  username: string,
  view: ProfileView,
  offset: number,
): Promise<{ writer: WriterProfile; list: ProfileList; nextOffset: number | null } | null> {
  const w = must(await call<WriterProfile>(gw, 'GET', path`/writers/${username}`), 'writer')
  if (absent(w.status)) return null
  const writer = okBody(w, 'writer')
  const qs = query({ limit: PAGE, offset })
  const u = writer.username

  let list: ProfileList
  let full: boolean
  switch (view) {
    case 'articles': {
      const b = okBody(await call<{ articles: ProfileArticle[] }>(gw, 'GET', path`/writers/${u}/articles` + qs), 'articles')
      list = { view, items: b.articles }
      full = b.articles.length === PAGE
      break
    }
    case 'notes': {
      const b = okBody(await call<{ notes: ProfileNote[] }>(gw, 'GET', path`/writers/${u}/notes` + qs), 'notes')
      list = { view, items: b.notes }
      full = b.notes.length === PAGE
      break
    }
    case 'replies': {
      const b = okBody(await call<{ replies: ProfileReply[] }>(gw, 'GET', path`/writers/${u}/replies` + qs), 'replies')
      list = { view, items: b.replies }
      full = b.replies.length === PAGE
      break
    }
    case 'followers': {
      const b = okBody(
        await call<{ followers: ProfilePerson[]; total: number }>(gw, 'GET', path`/writers/${u}/followers` + qs),
        'followers',
      )
      list = { view, items: b.followers, total: b.total }
      full = offset + b.followers.length < b.total
      break
    }
    case 'following': {
      const b = okBody(
        await call<{ following: ProfilePerson[]; total: number }>(gw, 'GET', path`/writers/${u}/following` + qs),
        'following',
      )
      list = { view, items: b.following, total: b.total }
      full = offset + b.following.length < b.total
      break
    }
  }
  return { writer, list, nextOffset: full ? offset + PAGE : null }
}

export async function loadAuthor(
  gw: GatewayContext,
  authorId: string,
  cursor: string | null,
): Promise<
  | { kind: 'author'; profile: AuthorProfile; posts: Post[]; nextCursor: string | null; hydrating: boolean }
  | { kind: 'native'; username: string }
  | null
> {
  const p = must(await call<AuthorProfile>(gw, 'GET', path`/author/${authorId}/profile`), 'author profile')
  if (absent(p.status)) return null
  const profile = okBody(p, 'author profile')
  // A native account's profile is its /u/ page; the gateway names it as a
  // one-segment path (`/:username`).
  const native = profile.profilePath?.match(/^\/([^/?#]+)$/)
  if (native) return { kind: 'native', username: decodeURIComponent(native[1]) }

  const posts = okBody(
    await call<{ items: Post[]; nextCursor?: string; hydrating?: boolean }>(
      gw,
      'GET',
      path`/author/${authorId}/posts` + query({ cursor }),
    ),
    'author posts',
  )
  return {
    kind: 'author',
    profile,
    posts: posts.items,
    nextCursor: posts.nextCursor ?? null,
    hydrating: posts.hydrating === true,
  }
}

export async function loadTag(
  gw: GatewayContext,
  tag: string,
  cursor: string | null,
): Promise<{ posts: Post[]; total: number; nextCursor: string | null } | null> {
  const t = must(
    await call<{ items: Post[]; total: number; nextCursor?: string }>(
      gw,
      'GET',
      path`/tags/${tag}/posts` + query({ cursor }),
    ),
    'tag',
  )
  if (absent(t.status)) return null
  const body = okBody(t, 'tag')
  return { posts: body.items, total: body.total, nextCursor: body.nextCursor ?? null }
}

export function parseSearchType(v: string | null): SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(v ?? '') ? (v as SearchType) : 'articles'
}

export const SEARCH_TOO_SHORT = 'Please type at least two characters to search.'

export async function loadSearch(
  gw: GatewayContext,
  q: string,
  type: SearchType,
  offset: number,
): Promise<{ results: SearchResults; tags: TagHits; nextOffset: number | null }> {
  if (q === '') return { results: { kind: 'none' }, tags: null, nextOffset: null }
  if (q.length < 2) return { results: { kind: 'refused', sentence: SEARCH_TOO_SHORT }, tags: null, nextOffset: null }

  const tagsRead: Promise<TagHits> = call<{ tags: { name: string; count: number }[] }>(
    gw,
    'GET',
    '/tags/search' + query({ q }),
  ).then(
    (a): TagHits => (a.status === 200 && a.body && Array.isArray(a.body.tags) ? a.body.tags : 'unavailable'),
    (): TagHits => 'unavailable',
  )

  const s = must(
    await call<{ results: ArticleHit[] | WriterHit[] }>(gw, 'GET', '/search' + query({ q, type, limit: PAGE, offset })),
    'search',
  )
  const tags = await tagsRead
  if (s.status === 400 || s.status === 429) {
    return { results: { kind: 'refused', sentence: sentenceForStatus(s.status) }, tags, nextOffset: null }
  }
  const body = okBody(s, 'search')
  const hits = Array.isArray(body.results) ? body.results : []
  const results: SearchResults =
    type === 'articles' ? { kind: 'articles', hits: hits as ArticleHit[] } : { kind: 'writers', hits: hits as WriterHit[] }
  return { results, tags, nextOffset: hits.length === PAGE ? offset + PAGE : null }
}

export async function loadFormula(gw: GatewayContext, token: string): Promise<FeedLink | null> {
  const f = must(await call<{ formula: FeedLink }>(gw, 'GET', path`/formulas/${token}`), 'formula')
  if (absent(f.status)) return null
  return okBody(f, 'formula').formula
}
