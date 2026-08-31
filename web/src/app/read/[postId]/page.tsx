import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ExternalArticleReader } from '../../../components/article/ExternalArticleReader'
import WorkspacePaneRedirect from '../../../components/layout/WorkspacePaneRedirect'
import { PublicPage } from '../../../components/public/PublicPage'

// =============================================================================
// Reader Page — /read/:postId  (Server Component) — UNIVERSAL-POST-ADR Phase R
//
// The addressable full-page surface for an EXTERNAL article. It is the direct-URL
// / new-tab counterpart of the workspace reader overlay (ReaderOverlay): both
// render the same ExternalArticleReader, so "open from feed" and "visit the URL"
// land in one reader.
//
// Resolution: GET /thread/:postId (Phase 1 projector) resolves the focal Post by
// its deterministic post_id; we read its origin URL + title + site name and hand
// them to ExternalArticleReader (which fetches reader-mode HTML via /extract).
//
// Scope: EXTERNAL articles only. Native articles keep their canonical, SEO-rich
// /article/[dTag] page; a native or note post_id here ⇒ notFound (the overlay
// routes native to /article/<dTag>, never here).
// =============================================================================

const GATEWAY = process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

interface FocalTarget {
  url: string
  title: string | null
  sourceName: string | null
}

async function getExternalArticleTarget(postId: string): Promise<FocalTarget | null> {
  const res = await fetch(`${GATEWAY}/api/v1/thread/${encodeURIComponent(postId)}`, {
    next: { revalidate: 60 },
  })
  if (!res.ok) return null
  const data = await res.json()
  const focal = Array.isArray(data?.posts)
    ? data.posts.find((p: { id?: string }) => p.id === data.focalId)
    : null
  if (!focal) return null
  // External article only: a note expands inline, a native article lives at
  // /article/[dTag]. Both fall through to notFound.
  const isExternalArticle = focal.type === 'article' && focal.origin?.protocol !== 'nostr'
  if (!isExternalArticle || !focal.origin?.uri) return null
  return {
    url: focal.origin.uri,
    title: focal.body?.title ?? null,
    sourceName: focal.origin?.sourceName ?? null,
  }
}

export async function generateMetadata({ params }: { params: { postId: string } }): Promise<Metadata> {
  const target = await getExternalArticleTarget(params.postId)
  if (!target) return {}
  const title = target.title ?? 'Reader'
  return {
    title,
    openGraph: {
      title,
      type: 'article',
      siteName: target.sourceName ?? 'all.haus',
    },
    twitter: { card: 'summary', title },
  }
}

export default async function ReaderPage({ params }: { params: { postId: string } }) {
  const target = await getExternalArticleTarget(params.postId)
  if (!target) return notFound()

  return (
    <PublicPage>
      <WorkspacePaneRedirect overlay="reader" params={{ read: params.postId }} />
      {/* The reading column sits on the bone floor with no shadow. The house has
          no elevation: a card is distinguished from its ground by being a
          different colour, which is what every card in the workspace does. The
          shadow was compensating for a ground that never rendered — the wrapper
          was `bg-grey-50`, and the Tailwind theme defines `grey` at
          100/200/300/400/600 only, so that class has always resolved to nothing
          and the white column has been floating on the browser default. */}
      <div
        className="mx-auto w-full"
        style={{ maxWidth: 640, background: 'var(--ah-white)', marginTop: 32 }}
      >
        <ExternalArticleReader
          url={target.url}
          title={target.title}
          siteName={target.sourceName}
        />
      </div>
    </PublicPage>
  )
}
