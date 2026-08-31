import { notFound } from 'next/navigation'
import Script from 'next/script'
import type { Metadata } from 'next'
import { renderMarkdown } from '../../../lib/markdown'
import { ArticleReader } from '../../../components/article/ArticleReader'
import { TraffologyMeta } from '../../../components/traffology/TraffologyMeta'
import WorkspacePaneRedirect from '../../../components/layout/WorkspacePaneRedirect'
import { PublicPage } from '../../../components/public/PublicPage'
import { traffologyEnabled, publicationsEnabled } from '../../../lib/featureFlags'
import type { ArticleMetadata } from '../../../lib/api'

// Publications suspended 2026-08-31 (lib/featureFlags.ts). A publication
// article is still reachable at its PERSONAL /article/:dTag URL — that route is
// not suspended — but while the system is dark it must not wear its
// publication's identity: the masthead link would 404 and the publication
// subscribe price would offer a subscription whose route is gone. One helper so
// the metadata and the body cannot disagree about whether a publication exists.
function visiblePublication(article: ArticleMetadata) {
  return publicationsEnabled() ? (article.publication ?? null) : null
}

// =============================================================================
// Article Page — /article/:dTag  (Server Component)
//
// Fetches article metadata + free content from the gateway at request time,
// renders markdown to HTML on the server, and passes the result to the
// ArticleReader client component for interactive features (paywall, replies,
// quote selection).
//
// The article body arrives as static HTML — no JavaScript needed to read it.
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getArticle(dTag: string): Promise<ArticleMetadata | null> {
  const res = await fetch(`${GATEWAY}/api/v1/articles/${dTag}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

function extractFirstImage(markdown: string | null): string | undefined {
  if (!markdown) return undefined
  const match = markdown.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/)
  return match?.[1] ?? undefined
}

export async function generateMetadata({ params }: { params: { dTag: string } }): Promise<Metadata> {
  const article = await getArticle(params.dTag)
  if (!article) return {}

  const title = article.title
  const description = article.summary || `By ${article.writer.displayName ?? article.writer.username}`
  const authorName = article.writer.displayName ?? article.writer.username
  const url = `https://all.haus/article/${article.dTag}`
  // Prefer the explicit cover (slice 23b); fall back to inline-image scrape
  // for legacy articles that have no cover_image_url set.
  const image = article.coverImageUrl ?? extractFirstImage(article.contentFree)

  return {
    title,
    description,
    authors: [{ name: authorName }],
    openGraph: {
      title,
      description,
      type: 'article',
      url,
      siteName: visiblePublication(article)?.name ?? 'all.haus',
      publishedTime: article.publishedAt ?? undefined,
      authors: [authorName],
      ...(image && { images: [{ url: image }] }),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  }
}

export default async function ArticlePage({ params }: { params: { dTag: string } }) {
  const article = await getArticle(params.dTag)
  if (!article) return notFound()

  // Render free-section markdown to HTML on the server
  const freeHtml = article.contentFree
    ? await renderMarkdown(article.contentFree)
    : ''

  // Traffology parked (architecture-audit item 8): when off, neither the hidden
  // meta nor the beacon script load, so readers' browsers never POST to the
  // (now 404ing) /ingest/* endpoint. This JSX gate is the authoritative source
  // gate — the served /traffology.js is a hand-built artifact, not bundled from
  // web/src/lib/traffology.ts, so not loading the <Script> is what stops it.
  const traffologyOn = traffologyEnabled()

  // `ground={false}`: ArticleReader's root is `min-h-screen bg-white` — it is
  // the reading surface and owns both its ground and its height. PublicPage
  // contributes only the nav row's bottom band.
  return (
    <PublicPage ground={false}>
    <WorkspacePaneRedirect overlay="reader" params={{ article: params.dTag }} />
    {traffologyOn && <TraffologyMeta articleId={article.id} />}
    <ArticleReader
      article={{
        id: article.nostrEventId,
        pubkey: article.writer.pubkey,
        dTag: article.dTag,
        title: article.title,
        summary: article.summary ?? '',
        content: article.contentFree ?? '',
        publishedAt: article.publishedAt
          ? Math.floor(new Date(article.publishedAt).getTime() / 1000)
          : 0,
        tags: [],
        pricePence: article.pricePence ?? undefined,
        gatePositionPct: article.gatePositionPct ?? undefined,
        isPaywalled: article.isPaywalled,
      }}
      coverImageUrl={article.coverImageUrl ?? null}
      articleDbId={article.id}
      writerName={article.writer.displayName ?? article.writer.username}
      writerUsername={article.writer.username}
      writerAvatar={article.writer.avatar ?? undefined}
      writerId={article.writer.id}
      subscriptionPricePence={visiblePublication(article)?.subscriptionPricePence ?? article.writer.subscriptionPricePence}
      writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
      nudgeShownThisMonth={article.nudgeShownThisMonth ?? false}
      preRenderedFreeHtml={freeHtml}
      publicationName={visiblePublication(article)?.name ?? undefined}
      publicationSlug={visiblePublication(article)?.slug ?? undefined}
    />
    {traffologyOn && <Script src="/traffology.js" strategy="afterInteractive" />}
    </PublicPage>
  )
}
