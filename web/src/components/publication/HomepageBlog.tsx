import {
  ArticleLink,
  EmptyState,
  PubByline,
  PubCover,
  articleKey,
  type PubArticle,
} from './article-shared'

// =============================================================================
// HomepageBlog — reverse-chronological, one piece at a time, generous.
//
// The straight answer to "just show me the writing in order". Each entry is a
// wide text column with an optional cover thumbnail alongside; every piece gets
// the same weight, which is exactly the difference from Magazine (which spends
// its layout deciding what matters most).
//
// SEPARATION WAS A BOTTOM RULE ON EVERY ENTRY AND IS NOW A GAP. That rule was
// one of five single-pixel lines the tripwire caught across this surface.
// Rhythm does the same job: 56px between entries is unambiguous at any type
// size, and unlike a rule it need not pick a colour that works in both modes.
//
// THE THUMBNAIL SITS RIGHT, not left, so every title starts on the same
// vertical — a left-hand image makes the column of headlines ragged and turns
// an ordered list of writing into a list of pictures.
// =============================================================================

export function HomepageBlog({
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
    <div className="mx-auto max-w-feed">
      {articles.map((a, i) => (
        <article key={articleKey(a)} className={i === 0 ? '' : 'mt-14'}>
          <ArticleLink slug={slug} article={a} onOpen={onOpen}>
            <div className="flex flex-col-reverse sm:flex-row sm:items-start gap-5 sm:gap-8">
              <div className="min-w-0 flex-1">
                <PubByline article={a} className="mb-2" />
                <h2 className="font-serif font-medium text-black text-[1.625rem] leading-[1.2] tracking-[-0.015em] group-hover:text-crimson-dark transition-colors">
                  {a.title}
                </h2>
                {a.summary && (
                  <p className="font-serif text-grey-600 mt-3 leading-[1.65] text-[1.0625rem] line-clamp-3">
                    {a.summary}
                  </p>
                )}
              </div>
              {a.cover_image_url && (
                <div className="sm:w-[200px] sm:shrink-0">
                  <PubCover src={a.cover_image_url} ratio="4 / 3" />
                </div>
              )}
            </div>
          </ArticleLink>
        </article>
      ))}
    </div>
  )
}
