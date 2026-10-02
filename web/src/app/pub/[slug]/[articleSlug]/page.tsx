import { notFound, redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { renderMarkdown } from '../../../../lib/markdown'
import { ArticleReader } from '../../../../components/article/ArticleReader'
import { PublicPage } from '../../../../components/public/PublicPage'
import type { ArticleMetadata } from '../../../../lib/api'

// =============================================================================
// Publication Article Page — /pub/:slug/:articleSlug  (Server Component)
//
// Identical to the standard /article/:dTag page, and now chassised identically
// too: `PublicPage ground={false}`, because ArticleReader's root is
// `min-h-screen bg-white` and owns both its ground and its height.
//
// It used to sit inside `pub/[slug]/layout.tsx`, which wrapped it in a
// `max-w-feed` main between a publication nav bar and a footer — a second
// chassis on a route where LayoutShell already mounts PublicNavBar. The layout
// is deleted; an article is the reading experience and takes no frame.
//
// THE SLUG IS PART OF THE ADDRESS, NOT DECORATION. The article is fetched by
// d-tag alone, so before `canonicalPath` any publication slug rendered the
// piece happily — /pub/anyones-magazine/<d-tag> served somebody else's article
// under their masthead, and the OG url echoed the wrong slug back, so that is
// the URL a share would have propagated. A mismatch redirects to the piece's
// real home (its publication's, or the personal /article/:dTag for a piece that
// belongs to no publication) rather than 404ing: the article exists and the
// reader asked for it by a name that is nearly right.
// =============================================================================

import { publicationsEnabled } from '../../../../lib/featureFlags'

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

async function getArticle(dTag: string): Promise<ArticleMetadata | null> {
  const res = await fetch(`${GATEWAY}/api/v1/articles/${encodeURIComponent(dTag)}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  return res.json()
}

/**
 * Where this article actually lives — `null` when the requested slug is already
 * it. One home for the rule, so the page and its metadata cannot disagree about
 * which URL is canonical (the metadata's OG url was the half that shipped the
 * wrong slug onward).
 */
function canonicalPath(
  article: ArticleMetadata,
  requestedSlug: string,
): string | null {
  const home = article.publication
    ? `/pub/${article.publication.slug}/${article.dTag}`
    : `/article/${article.dTag}`
  return article.publication?.slug === requestedSlug ? null : home
}

function extractFirstImage(markdown: string | null): string | undefined {
  if (!markdown) return undefined
  const match = markdown.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/)
  return match?.[1] ?? undefined
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string; articleSlug: string }
}): Promise<Metadata> {
  const article = await getArticle(params.articleSlug)
  if (!article) return {}

  const title = article.title
  const description = article.summary || `By ${article.writer.displayName ?? article.writer.username}`
  const authorName = article.writer.displayName ?? article.writer.username
  const pubName = article.publication?.name
  const url = `https://all.haus${
    canonicalPath(article, params.slug) ?? `/pub/${params.slug}/${article.dTag}`
  }`
  const image = extractFirstImage(article.contentFree)

  return {
    title,
    description,
    authors: [{ name: authorName }],
    openGraph: {
      title,
      description,
      type: 'article',
      url,
      siteName: pubName ?? 'all.haus',
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

export default async function PublicationArticlePage({
  params,
}: {
  params: { slug: string; articleSlug: string }
}) {
  // Publications suspended 2026-08-31 (lib/featureFlags.ts). This is the ONE
  // /pub/* page the gateway gate does not close by itself: its five siblings
  // fetch /publications/:slug/public and 404 the moment that route darks, but
  // this one fetches the PERSONAL /articles/:dTag route, which is not
  // suspended — so without this check a publication article would keep
  // rendering under a /pub/ URL while every other publication surface is gone.
  // Full dark (Q1(a)) means the whole route is invisible, including the
  // wrong-slug redirect below.
  if (!publicationsEnabled()) return notFound()

  const article = await getArticle(params.articleSlug)
  if (!article) return notFound()

  const canonical = canonicalPath(article, params.slug)
  if (canonical) redirect(canonical)

  const freeHtml = article.contentFree
    ? await renderMarkdown(article.contentFree)
    : ''

  return (
    // `barGround`: same reading surface, same white, same reason as
    // /article/[dTag] — ArticleReader paints `bg-white` and the fixed nav bar
    // has to be told, or its invisible bottom edge shows as a seam.
    <PublicPage ground={false} barGround="var(--ah-white)">
    <ArticleReader
      // The unified key, straight off the article payload — resolved
      // server-side by `article_post_id()` (READING-LOG-AND-LIBRARY-ADR D8).
      // No `scrollRef`: this is a page, so the document scrolls.
      postId={article.postId}
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
      articleDbId={article.id}
      writerName={article.writer.displayName ?? article.writer.username}
      writerUsername={article.writer.username}
      writerAvatar={article.writer.avatar ?? undefined}
      writerId={article.writer.id}
      subscriptionPricePence={article.writer.subscriptionPricePence}
      writerSpendThisMonthPence={article.writerSpendThisMonthPence ?? undefined}
      preRenderedFreeHtml={freeHtml}
    />
    </PublicPage>
  )
}
