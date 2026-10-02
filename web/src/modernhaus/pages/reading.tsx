import type { ReactNode } from 'react'
import type { ArticleMetadata } from '../../lib/api/articles'
import type { Post } from '../../lib/post/types'
import { safeHttpUrl } from '../../lib/external-links'
import { ARTICLE_WITHDRAWN_NOTICE, ARTICLE_NOT_HERE_BODY } from '../../content/article'
import { Time, Unavailable, TextParagraphs } from '../html'
import { authorName, bodyHtml } from '../post'

// =============================================================================
// modernhaus — the two reading pages (§D2.3, §D2.6), read half only (E1).
//
// `/modernhaus/article/<dTag>` is a native article: header, the free half, and
// whatever stands below it — the gate or the paid half, which
// `article-view.tsx` decides (E5). The conversation below it is E3.
//
// `/modernhaus/read/<postId>` is an external article: its byline, a link to the
// source, and for a member the extracted full text.
// =============================================================================

export interface ArticleProps {
  article: ArticleMetadata
  /** The free half, rendered by `renderMarkdown` and passed through the ornament pass. */
  freeHtml: string
  /** What stands under the free half of a paywalled piece: the gate, or the
   *  paid half once a press has opened it (`article-view.tsx`, E5). */
  below?: ReactNode
}

export function ArticlePage(props: ArticleProps) {
  const { article } = props
  const writer = article.writer
  const name = writer.displayName ?? writer.username
  return (
    <article>
      <header>
        <h1>{article.title}</h1>
        {article.summary && <p>{article.summary}</p>}
        <p>
          {'By '}
          <a href={`/modernhaus/u/${encodeURIComponent(writer.username)}`}>{name}</a>
          {article.publishedAt && (
            <>
              {' · '}
              <Time at={new Date(article.publishedAt)} dateOnly />
            </>
          )}
        </p>
        {article.withdrawn && <p>{ARTICLE_WITHDRAWN_NOTICE}</p>}
      </header>
      {props.freeHtml && <div dangerouslySetInnerHTML={{ __html: props.freeHtml }} />}
      {props.below}
    </article>
  )
}

export type Extracted = { kind: 'text'; html: string } | { kind: 'unavailable' } | { kind: 'members_only' }

export interface ReadProps {
  post: Post
  /** The source's web address, already through `safeHttpUrl`. */
  sourceUrl: string | null
  extracted: Extracted
}

export function ReadPage(props: ReadProps) {
  const { post, sourceUrl, extracted } = props
  const site = post.origin.sourceName
  const own = bodyHtml(post)
  const ownBody = own ? (
    <div dangerouslySetInnerHTML={{ __html: own }} />
  ) : post.body.summary ? (
    <TextParagraphs text={post.body.summary} />
  ) : null
  return (
    <article>
      <header>
        <h1>{post.body.title ?? 'Untitled'}</h1>
        <p>
          {authorName(post)}
          {' · '}
          <Time at={new Date(post.publishedAt * 1000)} dateOnly />
          {site && ` · ${site}`}
        </p>
        {sourceUrl && (
          <p>
            <a href={safeHttpUrl(sourceUrl)} target="_blank" rel="noopener noreferrer">
              {`Read at source${site ? ` (${site})` : ''}`}
            </a>
          </p>
        )}
      </header>
      {extracted.kind === 'text' ? (
        <div dangerouslySetInnerHTML={{ __html: extracted.html }} />
      ) : extracted.kind === 'unavailable' ? (
        <>
          <Unavailable what="The full text" />
          {ownBody}
        </>
      ) : (
        <>
          {ownBody}
          <p>Members can read the full text here.</p>
        </>
      )}
    </article>
  )
}

/** No piece this viewer may read at that address (the full site's words). */
export function ArticleNotHerePage() {
  return <p>{ARTICLE_NOT_HERE_BODY}</p>
}
