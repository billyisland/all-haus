import {
  ArticleLink,
  EmptyState,
  PubByline,
  articleKey,
  formatPubDate,
  type PubArticle,
} from './article-shared'

// =============================================================================
// HomepageMinimal — a contents page. Titles and dates, nothing else.
//
// NO IMAGES HERE, ON PURPOSE — that is the whole choice a writer is making when
// they pick this template, so `cover_image_url` is deliberately never read.
// Minimal is not "Blog with less padding"; it is the publication saying the
// writing needs no shopfront.
//
// The date sits right and the title left, on a shared baseline, so the page
// reads as a column of titles with a date rail beside it. The byline drops
// below the title rather than crowding that line, and only when the author
// differs from nothing useful — a single-author publication repeating one name
// forty times is noise, but this template can't know that, so it shows the
// author and lets the writer pick Minimal knowing it will.
// =============================================================================

export function HomepageMinimal({
  slug,
  articles,
  onOpen,
}: {
  slug: string
  articles: PubArticle[]
  /** Overlay mode — see ArticleLink. Omitted on the standalone page. */
  onOpen?: (dTag: string) => void
}) {
  if (articles.length === 0) return <EmptyState />

  return (
    <ul className="mx-auto max-w-article">
      {articles.map((a, i) => (
        <li key={articleKey(a)} className={i === 0 ? '' : 'mt-7'}>
          <ArticleLink slug={slug} article={a} onOpen={onOpen}>
            <div className="flex items-baseline justify-between gap-6">
              <h2 className="font-serif text-black text-[1.1875rem] leading-[1.35] group-hover:text-crimson-dark transition-colors">
                {a.title}
              </h2>
              {a.published_at && (
                <span className="font-mono text-mono-xs text-grey-600 shrink-0">
                  {formatPubDate(a.published_at)}
                </span>
              )}
            </div>
            <PubByline article={a} className="mt-1" showDate={false} />
          </ArticleLink>
        </li>
      ))}
    </ul>
  )
}
