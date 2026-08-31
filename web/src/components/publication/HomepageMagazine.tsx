import {
  ArticleLink,
  EmptyState,
  PubByline,
  PubCover,
  articleKey,
  type PubArticle,
} from './article-shared'

// =============================================================================
// HomepageMagazine — the front page that has to look like a magazine.
//
// THE ARRANGEMENT IS THE ARGUMENT, so it is asymmetric on purpose and does not
// tidy itself into a regular stack at desktop widths. Three registers, each a
// different weight of attention:
//
//   1. LEAD — one piece, cover left at 3:2 across three fifths, text right.
//      The only italic serif on the page and the only headline over 2rem.
//   2. SECOND RANK — two pieces, covers above, equal weight to each other.
//   3. THE REST — a text index, three columns on wide screens, no images.
//
// A magazine's front page is a claim about which piece matters most, and a grid
// of identical tiles cannot make one. That is why the previous version of this
// file — a hero card and then a uniform 2-up of title-only tiles on grey
// panels, with no image anywhere — read as a wireframe: it had the shape of a
// magazine and none of the editing.
//
// SEPARATION IS WHITESPACE AND RHYTHM. There is no rule, panel or frame in
// here; the three registers are told apart by size, measure and the gaps
// between them. A `.slab-rule-4` before "MORE" was tried and removed — a full
// 4px bar across the column is a heavier statement than the break is making.
//
// COVERS DEGRADE HONESTLY. Not every article has one, and `PubCover` renders
// nothing rather than a grey box, so a text-only publication reads as a
// well-set index rather than as a page of broken images.
// =============================================================================

export function HomepageMagazine({
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

  const [lead, ...tail] = articles
  const secondRank = tail.slice(0, 2)
  const rest = tail.slice(2)

  return (
    <div>
      {/* ── 1. Lead ─────────────────────────────────────────────────────── */}
      <ArticleLink slug={slug} article={lead} onOpen={onOpen}>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-6 md:gap-10 items-center">
          {lead.cover_image_url && (
            <div className="md:col-span-3">
              <PubCover src={lead.cover_image_url} ratio="3 / 2" />
            </div>
          )}
          <div
            className={
              lead.cover_image_url
                ? 'md:col-span-2'
                : 'md:col-span-5 mx-auto max-w-article text-center'
            }
          >
            <PubByline article={lead} className="mb-3" />
            <h2
              className="font-serif italic font-medium text-black tracking-[-0.02em] group-hover:text-crimson-dark transition-colors"
              style={{
                fontSize: 'clamp(1.75rem, 3.4vw, 2.75rem)',
                lineHeight: 1.12,
              }}
            >
              {lead.title}
            </h2>
            {lead.summary && (
              <p className="font-serif text-grey-600 mt-4 leading-[1.6] text-[1.0625rem]">
                {lead.summary}
              </p>
            )}
          </div>
        </div>
      </ArticleLink>

      {/* ── 2. Second rank ──────────────────────────────────────────────── */}
      {secondRank.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 sm:gap-10 mt-16">
          {secondRank.map((a) => (
            <ArticleLink key={articleKey(a)} slug={slug} article={a} onOpen={onOpen}>
              {a.cover_image_url && (
                <div className="mb-4">
                  <PubCover src={a.cover_image_url} ratio="16 / 10" />
                </div>
              )}
              <PubByline article={a} className="mb-2" />
              <h3 className="font-serif font-medium text-black text-[1.5rem] leading-[1.2] tracking-[-0.015em] group-hover:text-crimson-dark transition-colors">
                {a.title}
              </h3>
              {a.summary && (
                <p className="font-serif text-grey-600 mt-2 leading-[1.6] text-ui-sm line-clamp-3">
                  {a.summary}
                </p>
              )}
            </ArticleLink>
          ))}
        </div>
      )}

      {/* ── 3. The rest ─────────────────────────────────────────────────── */}
      {rest.length > 0 && (
        <section className="mt-16">
          <h2 className="label-ui text-grey-600 mb-6">More from this publication</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-8">
            {rest.map((a) => (
              <ArticleLink key={articleKey(a)} slug={slug} article={a} onOpen={onOpen}>
                <h3 className="font-serif font-medium text-black text-[1.125rem] leading-[1.3] group-hover:text-crimson-dark transition-colors">
                  {a.title}
                </h3>
                <PubByline article={a} className="mt-2" />
              </ArticleLink>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
