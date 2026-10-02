import type { Post } from '../../lib/post/types'
import { formulaSourceKind, type FeedLink } from '../../lib/api/formulas'
import {
  FEED_LINK_CONTENTS_LABEL,
  feedLinkAuthorName,
  feedLinkExcludedSentence,
  feedLinkGoneSentence,
  feedLinkRefusalSentence,
  feedLinkSourceCount,
  feedLinkWithdrawnSentence,
  FEED_LINK_BY_BEFORE,
  FEED_LINK_ADD,
  FEED_LINK_CLOSED_BETA,
  FEED_LINK_JOIN_WAITLIST,
  FEED_LINK_LOGIN_BEFORE,
  FEED_LINK_LOGIN_LINK,
  FEED_LINK_LOGIN_AFTER,
} from '../../content/feed-link'
import { query } from '../gateway'
import { Time, NextLink, Unavailable, PostForm, Hidden, type Viewer } from '../html'
import { PostList } from '../post'

// =============================================================================
// modernhaus — a tag, search, and a shared feed link (§D2.3), read half (E1).
// =============================================================================

export function TagPage(props: { posts: Post[]; total: number; next: string | null }) {
  return (
    <>
      <p>{`${props.total} ${props.total === 1 ? 'article' : 'articles'}`}</p>
      <PostList posts={props.posts} empty="No articles carry this tag." />
      <NextLink href={props.next} />
    </>
  )
}

export const SEARCH_TYPES = ['articles', 'writers'] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

export interface ArticleHit {
  id: string
  dTag: string
  title: string
  summary: string | null
  isPaywalled: boolean
  publishedAt: string
  writer: { username: string; displayName: string | null }
}
export interface WriterHit {
  id: string
  username: string
  displayName: string | null
  bio: string | null
}

export type SearchResults =
  | { kind: 'none' }
  /** The query was refused before it ran: too short, or the route said no. */
  | { kind: 'refused'; sentence: string }
  | { kind: 'articles'; hits: ArticleHit[] }
  | { kind: 'writers'; hits: WriterHit[] }

export type TagHits = { name: string; count: number }[] | 'unavailable' | null

export interface SearchProps {
  q: string
  type: SearchType
  results: SearchResults
  tags: TagHits
  next: string | null
}

export function SearchPage(props: SearchProps) {
  const { results } = props
  return (
    <>
      <form method="get" action="/modernhaus/search">
        <p>
          <label>
            {'Search for '}
            <input type="search" name="q" defaultValue={props.q} minLength={2} required />
          </label>
        </p>
        <fieldset>
          <legend>Look for</legend>
          {SEARCH_TYPES.map((t) => (
            <label key={t}>
              <input type="radio" name="type" value={t} defaultChecked={props.type === t} />
              {t === 'articles' ? ' Articles ' : ' Writers '}
            </label>
          ))}
        </fieldset>
        <p>
          <button type="submit">Search</button>
        </p>
      </form>

      {results.kind === 'refused' && <p role="status">{results.sentence}</p>}

      {props.tags === 'unavailable' ? (
        <Unavailable what="Matching tags" />
      ) : (
        props.tags &&
        props.tags.length > 0 && (
          <>
            <h2>Tags</h2>
            <ul>
              {props.tags.map((t) => (
                <li key={t.name}>
                  <a href={`/modernhaus/tag/${encodeURIComponent(t.name)}`}>{`#${t.name}`}</a>
                  {` (${t.count})`}
                </li>
              ))}
            </ul>
          </>
        )
      )}

      {results.kind === 'articles' && (
        <>
          <h2>Articles</h2>
          {results.hits.length === 0 ? (
            <p>No articles match.</p>
          ) : (
            <ol>
              {results.hits.map((a) => (
                <li key={a.id}>
                  <article>
                    <h3>
                      <a href={`/modernhaus/article/${encodeURIComponent(a.dTag)}`}>{a.title}</a>
                    </h3>
                    {a.summary && <p>{a.summary}</p>}
                    <p>
                      {'By '}
                      <a href={`/modernhaus/u/${encodeURIComponent(a.writer.username)}`}>
                        {a.writer.displayName ?? a.writer.username}
                      </a>
                      {' · '}
                      <Time at={new Date(a.publishedAt)} dateOnly />
                      {a.isPaywalled && ' · Paid'}
                    </p>
                  </article>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {results.kind === 'writers' && (
        <>
          <h2>Writers</h2>
          {results.hits.length === 0 ? (
            <p>No writers match.</p>
          ) : (
            <ul>
              {results.hits.map((w) => (
                <li key={w.id}>
                  <a href={`/modernhaus/u/${encodeURIComponent(w.username)}`}>{w.displayName ?? w.username}</a>
                  {` (@${w.username})`}
                  {w.bio && <p>{w.bio}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <NextLink href={props.next} label="More results" />
    </>
  )
}

/**
 * A shared feed link. Every sentence is the full site's (`content/feed-link.ts`).
 * Adding the feed (`formula_redeem`) is E6; until then it is added on the full
 * site, which the nav's "Full site" link reaches.
 */
export function FormulaPage(props: { link: FeedLink; twin: string; viewer?: Viewer | null; csrf?: string }) {
  const { link } = props
  const author = feedLinkAuthorName(link)
  if (link.revoked) return <p>{feedLinkWithdrawnSentence(author)}</p>
  if (link.gone) return <p>{feedLinkGoneSentence(author)}</p>
  return (
    <>
      <p>
        {feedLinkSourceCount(link.sourceCount)}
        {author && (
          <>
            {FEED_LINK_BY_BEFORE}
            {link.author.username ? (
              <a href={`/modernhaus/u/${encodeURIComponent(link.author.username)}`}>{author}</a>
            ) : (
              author
            )}
          </>
        )}
        {'.'}
      </p>
      <h2>{FEED_LINK_CONTENTS_LABEL}</h2>
      <ol>
        {link.sources.map((s) => (
          <li key={s.position}>{`${s.label} — ${formulaSourceKind(s)}`}</li>
        ))}
      </ol>
      {link.excludedCount > 0 && <p>{feedLinkExcludedSentence(link.excludedCount)}</p>}
      {link.refusal ? (
        <p>{feedLinkRefusalSentence(link.refusal)}</p>
      ) : props.viewer && props.csrf ? (
        <PostForm action="formula_redeem" csrf={props.csrf}>
          <Hidden values={{ token: link.token }} />
          <p>
            <button>{FEED_LINK_ADD}</button>
          </p>
        </PostForm>
      ) : (
        <>
          <p>{FEED_LINK_CLOSED_BETA}</p>
          <p>
            <a href="/modernhaus/waitlist">{FEED_LINK_JOIN_WAITLIST}</a>
          </p>
          <p>
            {`${FEED_LINK_LOGIN_BEFORE} `}
            <a href={`/modernhaus/signin${query({ return: `/modernhaus/f/${link.token}` })}`}>{FEED_LINK_LOGIN_LINK}</a>
            {` ${FEED_LINK_LOGIN_AFTER}`}
          </p>
        </>
      )}
    </>
  )
}
